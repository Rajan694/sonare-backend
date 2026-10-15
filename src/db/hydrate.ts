import { CachedPiped, PIPED_LOOKUP_CONCURRENCY } from '../services/cache.js';
import { normalizeStreamToTrack, withUserFields } from '../normalize/index.js';
import { idHelpers } from '../ids.js';
import { mapLimit } from '../mapLimit.js';
import type { Track } from '../types.js';
import { UpstreamError } from '../upstream/piped.js';
import { getUserTrackDataMap, UserTrackFields } from './userData.js';
import {
  getCatalogItems,
  parseTrackMeta,
  rememberCatalogItem,
  toCatalogTrackData,
  type TrackMeta,
} from '../services/catalogMeta.js';

export interface TrackRefInput {
  trackRefKind: string;
  trackRefId: string;
  addedAt?: number;
  favourite?: boolean;
  playCount?: number;
  lastPlayedAt?: number;
  /** Optional metadata from the row (favourite_tracks, playlist_tracks, play_history). */
  rowMeta?: unknown;
}

export interface HydrateOptions {
  /**
   * Fail the request when Piped is unreachable, instead of stubbing every server track.
   * The history shelves pass true: their rows are plays, and a list reading "Unknown Title"
   * would look like data rather than an outage. Favourites and library lists keep the stubs.
   */
  failIfPipedDown?: boolean;
}

export const hydrateTracks = async (
  userId: string | undefined,
  inputs: TrackRefInput[],
  { failIfPipedDown = false }: HydrateOptions = {},
) => {
  const serverInputs = inputs.filter((i) => i.trackRefKind === 'server');
  const serverIds = serverInputs.map((i) => i.trackRefId);

  // Batch-fetch catalog items for all server tracks
  const catalogMap =
    serverIds.length > 0 ? await getCatalogItems<TrackMeta>('track', serverIds) : new Map<string, TrackMeta>();

  // Resolve metadata per track: row.meta -> catalog_items -> null. A track can have several
  // rows (history); callers list them newest first, so its newest snapshot wins, and a row
  // without one never hides another row's.
  const rowMetaMap = new Map<string, TrackMeta | null>();
  for (const input of serverInputs) {
    const parsed = input.rowMeta ? parseTrackMeta(input.rowMeta) : null;
    if (parsed && !rowMetaMap.has(input.trackRefId)) rowMetaMap.set(input.trackRefId, parsed);
  }
  for (const input of serverInputs) {
    if (!rowMetaMap.has(input.trackRefId)) rowMetaMap.set(input.trackRefId, catalogMap.get(input.trackRefId) ?? null);
  }

  const allIds = inputs.map((i) =>
    i.trackRefKind === 'server' ? idHelpers.prefixYt(i.trackRefId) : idHelpers.prefixLocal(i.trackRefId),
  );
  const userDataMap = userId ? await getUserTrackDataMap(userId, allIds) : new Map<string, UserTrackFields>();

  const results = new Array<Track>(inputs.length);
  const pending: number[] = [];

  inputs.forEach((input, index) => {
    const fullId =
      input.trackRefKind === 'server' ? idHelpers.prefixYt(input.trackRefId) : idHelpers.prefixLocal(input.trackRefId);

    const userFields = userDataMap.get(fullId) || {
      playCount: input.playCount ?? 0,
      favourite: input.favourite ?? false,
      addedAt: input.addedAt ?? Date.now(),
      lastPlayedAt: input.lastPlayedAt,
    };

    if (input.trackRefKind === 'server') {
      // Read order: row meta -> catalog_items -> Piped
      const cachedMeta = rowMetaMap.get(input.trackRefId);
      if (cachedMeta) {
        // Meta IDs already have prefixes (yt:UC... or ''). Use them as-is.
        results[index] = {
          id: fullId,
          title: cachedMeta.title,
          artistId: cachedMeta.artistId ?? '',
          artist: cachedMeta.artist,
          albumId: cachedMeta.albumId || null,
          album: cachedMeta.album || null,
          durationMs: cachedMeta.durationMs ?? null,
          source: 'server' as const,
          codec: null,
          bitrateKbps: null,
          bitDepth: undefined,
          thumbnail: cachedMeta.thumbnail || `/api/v1/tracks/${fullId}/artwork`,
          playCount: userFields.playCount,
          favourite: userFields.favourite,
          addedAt: userFields.addedAt,
          lastPlayedAt: userFields.lastPlayedAt,
        };
        return;
      }
      // No stored metadata: the item needs Piped, so it goes through the limiter below.
      pending.push(index);
      return;
    }

    results[index] = {
      id: fullId,
      title: 'Local Track',
      artistId: idHelpers.prefixLocal('unknown'),
      artist: 'Local Artist',
      albumId: null,
      album: null,
      durationMs: null,
      source: 'local' as const,
      codec: null,
      bitrateKbps: null,
      bitDepth: undefined,
      playCount: userFields.playCount,
      favourite: userFields.favourite,
      addedAt: userFields.addedAt,
      lastPlayedAt: userFields.lastPlayedAt,
    };
  });

  // Only the items without stored meta wait for Piped, at most a few at a time.
  await mapLimit(pending, PIPED_LOOKUP_CONCURRENCY, async (index) => {
    const input = inputs[index];
    const fullId = idHelpers.prefixYt(input.trackRefId);
    const userFields = userDataMap.get(fullId) || {
      playCount: input.playCount ?? 0,
      favourite: input.favourite ?? false,
      addedAt: input.addedAt ?? Date.now(),
      lastPlayedAt: input.lastPlayedAt,
    };

    try {
      const streams = await CachedPiped.getStream(input.trackRefId);
      const rawTrack = normalizeStreamToTrack(streams, input.trackRefId);
      await rememberCatalogItem('track', input.trackRefId, toCatalogTrackData(rawTrack));
      results[index] = withUserFields(rawTrack, userFields);
    } catch (e) {
      if (failIfPipedDown && e instanceof UpstreamError && e.unreachable) throw e;
      // Degrade to safe stub when Piped is offline or metadata unavailable
      results[index] = {
        id: fullId,
        title: 'Unknown Title',
        artistId: '',
        artist: 'Unknown Artist',
        albumId: null,
        album: null,
        durationMs: null,
        source: 'server' as const,
        codec: null,
        bitrateKbps: null,
        bitDepth: undefined,
        thumbnail: `/api/v1/tracks/${fullId}/artwork`,
        playCount: userFields.playCount,
        favourite: userFields.favourite,
        addedAt: userFields.addedAt,
        lastPlayedAt: userFields.lastPlayedAt,
      };
    }
  });

  return results;
};
