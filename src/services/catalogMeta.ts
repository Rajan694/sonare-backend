import { z } from 'zod';
import { db } from '../db/index.js';
import { catalogItems } from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { idHelpers } from '../ids.js';

export interface TrackMeta {
  title: string;
  artist: string;
  artistId: string;
  album?: string;
  albumId?: string;
  durationMs: number | null;
  thumbnail?: string;
}

export interface AlbumMeta {
  title: string;
  artist: string;
  artistId: string;
  year?: number | null;
  trackCount?: number | null;
  thumbnail?: string;
}

export interface ArtistMeta {
  name: string;
  thumbnail?: string;
  monthlyListeners?: number | null;
}

export interface CatalogTrackData {
  id: string;
  title: string;
  artistId: string;
  artist: string;
  albumId: string | null;
  album: string | null;
  durationMs: number | null;
  source: 'server';
  codec: string | null;
  bitrateKbps: number | null;
  bitDepth?: number;
  thumbnail?: string;
}

export const toCatalogTrackData = (track: {
  id: string;
  title: string;
  artistId: string;
  artist: string;
  albumId: string | null;
  album: string | null;
  durationMs: number | null;
  source?: 'server' | 'local';
  codec?: string | null;
  bitrateKbps?: number | null;
  bitDepth?: number;
  thumbnail?: string;
}): CatalogTrackData => ({
  id: track.id,
  title: track.title,
  artistId: track.artistId,
  artist: track.artist,
  albumId: track.albumId,
  album: track.album,
  durationMs: track.durationMs,
  source: 'server',
  codec: track.codec ?? null,
  bitrateKbps: track.bitrateKbps ?? null,
  bitDepth: track.bitDepth,
  thumbnail: track.thumbnail,
});

export type CatalogKind = 'track' | 'album' | 'artist';

const sanitizeThumbnail = (val: unknown): string | undefined => {
  if (typeof val !== 'string') return undefined;
  const str = val.trim();
  if (!str || str.length > 2048) return undefined;
  if (str.startsWith('/api/v1/')) return str;
  try {
    const url = new URL(str);
    if (url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase();
    if (
      host === 'ytimg.com' ||
      host.endsWith('.ytimg.com') ||
      host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com') ||
      host === 'ggpht.com' ||
      host.endsWith('.ggpht.com')
    ) {
      return str;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const thumbnailSchema = z.preprocess(sanitizeThumbnail, z.string().optional());

const idSchema = z
  .string()
  .trim()
  .regex(/^(?:yt:[\w-]{1,64})?$/);

export const trackMetaSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    artist: z.string().trim().min(0).max(300),
    artistId: idSchema,
    album: z.string().trim().min(0).max(300).optional(),
    albumId: idSchema.optional(),
    durationMs: z.number().int().min(0).max(86_400_000).nullable(),
    thumbnail: thumbnailSchema,
  })
  .strip();

export const albumMetaSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    artist: z.string().trim().min(0).max(300),
    artistId: idSchema,
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    trackCount: z.number().int().min(0).max(10_000).nullable().optional(),
    thumbnail: thumbnailSchema,
  })
  .strip();

export const artistMetaSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    thumbnail: thumbnailSchema,
    monthlyListeners: z.number().int().min(0).nullable().optional(),
  })
  .strip();

export const parseTrackMeta = (raw: unknown): TrackMeta | null => {
  if (!raw || typeof raw !== 'object') return null;
  const result = trackMetaSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
};

export const parseAlbumMeta = (raw: unknown): AlbumMeta | null => {
  if (!raw || typeof raw !== 'object') return null;
  const result = albumMetaSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
};

export const parseArtistMeta = (raw: unknown): ArtistMeta | null => {
  if (!raw || typeof raw !== 'object') return null;
  const result = artistMetaSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
};

export const rememberCatalogItem = async (kind: CatalogKind, id: string, data: unknown): Promise<void> => {
  try {
    const rawId = id.startsWith('yt:') ? id.slice(3) : id;
    if (!rawId) return;
    await db
      .insert(catalogItems)
      .values({
        kind,
        id: rawId,
        data,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [catalogItems.kind, catalogItems.id],
        set: {
          data,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, kind, id }, 'Failed to remember catalog item');
  }
};

/** Most catalog rows kept (like lyrics_cache): the least recently written go beyond this. */
export const CATALOG_ITEMS_MAX_ROWS = 50_000;

/**
 * Drops the rows past the newest `maxRows` by updated_at. Songs in favourites and playlists keep
 * their own copy of the metadata in their rows, so a pruned row costs at most a Piped lookup.
 * Logged, never thrown.
 */
export const pruneCatalogItems = async (maxRows = CATALOG_ITEMS_MAX_ROWS): Promise<void> => {
  try {
    await db.execute(sql`
      DELETE FROM catalog_items WHERE (kind, id) IN (
        SELECT kind, id FROM catalog_items ORDER BY updated_at DESC OFFSET ${maxRows}
      )
    `);
  } catch (err) {
    logger.warn({ err }, 'Could not prune catalog items');
  }
};

export const getCatalogItems = async <T = unknown>(kind: CatalogKind, ids: string[]): Promise<Map<string, T>> => {
  const map = new Map<string, T>();
  const rawIds = [...new Set(ids.map((id) => (id.startsWith('yt:') ? id.slice(3) : id)))].filter(Boolean);
  if (rawIds.length === 0) return map;

  try {
    const rows = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, kind), inArray(catalogItems.id, rawIds)));

    for (const row of rows) {
      map.set(row.id, row.data as T);
      map.set(idHelpers.prefixYt(row.id), row.data as T);
    }
  } catch (err) {
    logger.warn({ err, kind, rawIds }, 'Failed to get catalog items');
  }

  return map;
};
