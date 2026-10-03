import fs from 'node:fs';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { Piped } from '../upstream/piped.js';
import { CachedPiped, isRedisAvailable } from '../services/cache.js';
import {
  normalizeStreamItemToTrack,
  normalizeStreamItemToArtist,
  normalizeStreamItemToAlbum,
  normalizeChannelTabAlbum,
  normalizeChannelToArtist,
  normalizePlaylistToAlbum,
} from '../normalize/index.js';
import { idHelpers } from '../ids.js';
import { z } from 'zod';
import { parseQuery, queryInt } from '../validation.js';
import { db, sql } from '../db/index.js';
import { artistFollows } from '../db/schema.js';

// Catalog: health, search, trending, genres, albums, artists and YouTube playlists.
export const catalogRouter = Router();

const searchText = z
  .string({ required_error: 'Missing query parameter: q', invalid_type_error: 'Missing query parameter: q' })
  .trim()
  .min(1, 'Missing query parameter: q')
  .max(200, 'Search text must be at most 200 characters');
const cursor = z.string().max(10_000).optional();
const suggestionsQuery = z.object({ q: searchText });
const searchQuery = z.object({
  q: searchText,
  type: z.enum(['songs', 'albums', 'artists', 'playlists', 'all']).default('all'),
  cursor,
});
const trendingQuery = z.object({
  region: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'region must be a two-letter country code')
    .default('IN'),
  limit: queryInt(1, 100).default(50),
});
const pageQuery = z.object({ cursor });
const topTracksQuery = z.object({ limit: queryInt(1, 100).default(20) });

const APP_VERSION: string = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

function encodeCursor(nextpage: string | null | undefined): string | undefined {
  if (!nextpage) return undefined;
  return Buffer.from(nextpage).toString('base64url');
}

function decodeCursor(cursor: any): string | undefined {
  if (typeof cursor !== 'string' || !cursor) return undefined;
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

// Auto-generated "- Topic" artist channels come back from the extractor with no videos
// and no tabs, so pull the artist's catalog from YouTube Music search instead, keeping
// only results credited to this exact channel.
async function searchArtistCatalog(
  channelId: string,
  channelName: string | undefined,
  filter: 'music_songs' | 'music_albums',
): Promise<any[]> {
  const name = (channelName || '').replace(/\s+-\s+Topic$/i, '').trim();
  if (!name) return [];
  const page = await CachedPiped.search(name, filter);
  return (page.items || []).filter((i: any) => i.uploaderUrl === `/channel/${channelId}`);
}

catalogRouter.get('/discover/made-for-you', (req, res) => {
  res.json({ items: [], meta: { total: 0 } });
});

catalogRouter.get('/healthz', async (req, res) => {
  const [dbUp, pipedUp] = await Promise.all([
    sql`SELECT 1`.then(
      () => true,
      () => false,
    ),
    Piped.healthcheck().then(
      () => true,
      () => false,
    ),
  ]);
  // Only the database is required; Redis is a cache and Piped outages are reported per request.
  res.status(dbUp ? 200 : 503).json({
    ok: dbUp,
    version: APP_VERSION,
    db: dbUp ? 'up' : 'down',
    redis: isRedisAvailable() ? 'up' : 'down',
    piped: pipedUp ? 'up' : 'down',
  });
});

catalogRouter.get('/search/suggestions', async (req, res) => {
  const { q } = parseQuery(suggestionsQuery, req);
  const suggestions = await CachedPiped.suggestions(q);
  res.json(suggestions);
});

catalogRouter.get('/search', async (req, res) => {
  const { q, type, cursor } = parseQuery(searchQuery, req);

  const nextpage = decodeCursor(cursor);

  const typeMap: Record<string, string> = {
    songs: 'music_songs',
    albums: 'music_albums',
    artists: 'music_artists',
    playlists: 'music_playlists',
    all: 'all',
  };

  const filter = typeMap[type];

  let results;

  if (filter === 'all' && !nextpage) {
    const [songs, albums, artists, playlists] = await Promise.all([
      CachedPiped.search(q, 'music_songs'),
      CachedPiped.search(q, 'music_albums'),
      CachedPiped.search(q, 'music_artists'),
      CachedPiped.search(q, 'music_playlists'),
    ]);

    const items = [
      ...songs.items.map((i) => ({ ...i, __sonareKind: 'track' })),
      ...albums.items.map((i) => ({ ...i, __sonareKind: 'album' })),
      ...artists.items.map((i) => ({ ...i, __sonareKind: 'artist' })),
      ...playlists.items.map((i) => ({ ...i, __sonareKind: 'playlist' })),
    ];
    results = { items, nextpage: null };
  } else {
    if (nextpage) {
      results = await CachedPiped.searchNextPage(q, nextpage, filter);
    } else {
      results = await CachedPiped.search(q, filter);
    }
  }

  const requestedKindMap: Record<string, string> = {
    music_songs: 'track',
    music_albums: 'album',
    music_artists: 'artist',
    music_playlists: 'playlist',
  };
  const expectedKind = filter !== 'all' ? requestedKindMap[filter] : undefined;

  const items = results.items.map((item) => {
    let mapped;
    let mappedKind = (item as any).__sonareKind || expectedKind;

    // Sniff fallback if somehow missing
    if (!mappedKind) {
      if (item.type === 'playlist') mappedKind = 'album';
      else if (item.type === 'channel') mappedKind = 'artist';
      else mappedKind = 'track';
    }

    if (mappedKind === 'album' || mappedKind === 'playlist') {
      // Contract: types playlists & albums return Albums natively for search display
      mapped = normalizeStreamItemToAlbum(item);
      mappedKind = 'album'; // Map playlist hit to album shape
    } else if (mappedKind === 'artist') {
      mapped = normalizeStreamItemToArtist(item);
    } else {
      mapped = normalizeStreamItemToTrack(item);
    }
    return { kind: mappedKind, ...mapped };
  });

  res.json({
    items,
    meta: {
      nextCursor: encodeCursor(results.nextpage),
    },
  });
});

catalogRouter.get('/trending', async (req, res) => {
  const { region, limit } = parseQuery(trendingQuery, req);

  let items: any[] = [];
  // The last upstream failure; reported only if it leaves nothing to show.
  let failure: unknown;
  try {
    const rawTrending = await CachedPiped.trending(region);
    const isMusicTrack = (t: any) => {
      if (!t || t.type !== 'stream') return false;
      if (t.isShort || !t.duration || t.duration <= 0) return false;
      if ((t as any).livestream) return false;

      const title = (t.title || '').toLowerCase();
      const uploader = (t.uploaderName || '').toLowerCase();

      // Exclude obvious non-music patterns (live news, streams, gaming, asmr, yoga)
      if (/\b(live|livestream|news|asmr|parkour|gameplay|minecraft|gta|vlog|roast|podcast|yoga)\b/i.test(title))
        return false;

      // Music channel indicators
      if (t.uploaderName?.includes('- Topic') || uploader.includes('topic')) return true;
      if (
        uploader.includes('vevo') ||
        uploader.includes('music') ||
        uploader.includes('records') ||
        uploader.includes('t-series') ||
        uploader.includes('saregama') ||
        uploader.includes('yrf') ||
        uploader.includes('sony') ||
        uploader.includes('zee') ||
        uploader.includes('audio')
      )
        return true;

      // Video title music indicators (official video, audio, song, lyrical, ft, feat)
      if (/\b(official video|official audio|music video|lyric video|lyrics|feat|ft\.|prod\.)\b/i.test(title))
        return true;

      return false;
    };

    items = rawTrending.filter(isMusicTrack);
  } catch (e) {
    failure = e;
  }

  // Ensure we always have sufficient high quality musical items for the Home carousel and trending shelf
  if (items.length < limit) {
    try {
      const musicSearch = await CachedPiped.search('trending music top songs', 'music_songs');
      const searchItems = musicSearch.items || [];
      const seenIds = new Set(items.map((i) => i.url));
      for (const item of searchItems) {
        if (items.length >= limit) break;
        if (item.url && !seenIds.has(item.url) && item.duration && item.duration > 0) {
          seenIds.add(item.url);
          items.push(item);
        }
      }
    } catch (e) {
      failure = e;
    }
  }

  // Both sources failing is an outage, not an empty chart. Answering 200 with no items
  // made the apps say "nothing trending" while Piped was down.
  if (items.length === 0 && failure) throw failure;

  res.json({
    items: items.slice(0, limit).map((item) => ({ kind: 'track', ...normalizeStreamItemToTrack(item) })),
    meta: {},
  });
});

catalogRouter.get('/genres', (req, res) => {
  res.json([
    { id: 'ambient', name: 'Ambient' },
    { id: 'electronica', name: 'Electronica' },
    { id: 'post-rock', name: 'Post-rock' },
    { id: 'indie', name: 'Indie' },
    { id: 'jazz', name: 'Jazz' },
    { id: 'classical', name: 'Classical' },
    { id: 'hip-hop', name: 'Hip-hop' },
    { id: 'folk', name: 'Folk' },
  ]);
});

catalogRouter.get('/albums/:id', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const playlist = await CachedPiped.playlist(rawId);
  res.json(normalizePlaylistToAlbum(playlist, rawId));
});

catalogRouter.get('/albums/:id/tracks', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { cursor } = parseQuery(pageQuery, req);
  const nextpage = decodeCursor(cursor);

  let tracks,
    nextCursor = undefined;

  if (nextpage) {
    const paged = await CachedPiped.playlistNextPage(rawId, nextpage);
    tracks = paged.relatedStreams || [];
    nextCursor = paged.nextpage;
  } else {
    const playlist = await CachedPiped.playlist(rawId);
    tracks = playlist.relatedStreams || [];
    nextCursor = playlist.nextpage;
  }

  res.json({
    items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
    meta: { nextCursor: encodeCursor(nextCursor) },
  });
});

catalogRouter.get('/artists/:id', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const channel = await CachedPiped.channel(rawId);
  const artist = normalizeChannelToArtist(channel, rawId);
  if (req.user) {
    const [follow] = await db
      .select({ artistId: artistFollows.artistId })
      .from(artistFollows)
      .where(and(eq(artistFollows.userId, req.user.id), eq(artistFollows.artistId, rawId)))
      .limit(1);
    artist.following = !!follow;
  }
  res.json(artist);
});

catalogRouter.get('/artists/:id/top-tracks', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { limit } = parseQuery(topTracksQuery, req);

  const channel = await CachedPiped.channel(rawId);
  let tracks = channel.relatedStreams || [];
  if (tracks.length === 0) tracks = await searchArtistCatalog(rawId, channel.name, 'music_songs');
  tracks = tracks.slice(0, limit);

  res.json({
    items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
    meta: {},
  });
});

catalogRouter.get('/artists/:id/albums', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { cursor } = parseQuery(pageQuery, req);

  let items = [],
    nextCursor = undefined;

  if (cursor) {
    const data = decodeCursor(cursor);
    if (data) {
      const tabData = await Piped.channelTabs(data);
      items = tabData.content || [];
      nextCursor = tabData.nextpage;
    }
  } else {
    const channel = await CachedPiped.channel(rawId);
    const albumsTab = channel.tabs?.find(
      (t: any) => t.name.toLowerCase() === 'albums' || t.name.toLowerCase() === 'releases',
    );
    if (albumsTab && albumsTab.data) {
      const tabData = await Piped.channelTabs(albumsTab.data);
      items = tabData.content || [];
      nextCursor = tabData.nextpage;
    } else {
      items = await searchArtistCatalog(rawId, channel.name, 'music_albums');
    }
  }

  res.json({
    items: items.map((i: any) => ({ kind: 'album', ...normalizeChannelTabAlbum(i) })),
    meta: { nextCursor: encodeCursor(nextCursor) },
  });
});

catalogRouter.get('/playlists/:id', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const playlist = await CachedPiped.playlist(rawId);
  res.json({
    id: idHelpers.prefixYt(rawId),
    name: playlist.name,
    kind: 'online',
    trackCount: playlist.videos >= 0 ? playlist.videos : null,
    downloadedCount: 0,
    updatedAt: Date.now(), // TODO(phase3): updatedAt will come from the Sonare DB
  });
});

catalogRouter.get('/playlists/:id/tracks', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { cursor } = parseQuery(pageQuery, req);
  const nextpage = decodeCursor(cursor);

  let tracks,
    nextCursor = undefined;
  if (nextpage) {
    const paged = await CachedPiped.playlistNextPage(rawId, nextpage);
    tracks = paged.relatedStreams || [];
    nextCursor = paged.nextpage;
  } else {
    const playlist = await CachedPiped.playlist(rawId);
    tracks = playlist.relatedStreams || [];
    nextCursor = playlist.nextpage;
  }

  res.json({
    items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
    meta: { nextCursor: encodeCursor(nextCursor) },
  });
});
