import { Router, type Request, type Response } from 'express';
import { db } from '../db/index.js';
import {
  users,
  favouriteTracks,
  favouriteAlbums,
  artistFollows,
  playHistory,
  playlists,
  playlistTracks,
  userSettings,
  playerState,
} from '../db/schema.js';
import { eq, and, desc, sql, gte, inArray } from 'drizzle-orm';
import { forgetAuthUser, requireAuth } from '../middleware/auth.js';
import bcrypt from 'bcrypt';
import { idHelpers } from '../ids.js';
import { hydrateTracks } from '../db/hydrate.js';
import { CachedPiped, PIPED_LOOKUP_CONCURRENCY } from '../services/cache.js';
import { mapLimit } from '../mapLimit.js';
import { prunePlayHistoryForUser } from '../services/playHistory.js';
import { normalizeChannelToArtist, normalizePlaylistToAlbum, normalizeStreamToTrack } from '../normalize/index.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { parseBody, parseQuery, queryInt } from '../validation.js';
import {
  parseTrackMeta,
  parseAlbumMeta,
  parseArtistMeta,
  rememberCatalogItem,
  getCatalogItems,
  toCatalogTrackData,
  type AlbumMeta,
  type ArtistMeta,
  type TrackMeta,
} from '../services/catalogMeta.js';

export const meRouter = Router();

// ---- Request schemas ----

const trackId = z.string().trim().min(1, 'Track ids must not be empty').max(200);
const trackRef = z.union([
  z.object({ kind: z.literal('server'), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('local'), fingerprint: z.string().min(1).max(200) }),
]);

/** Optional metadata passed when favouriting/following a track, album, or artist. */
const metaParam = z.unknown().optional();

/** The stored id: a YouTube video id for server tracks, the file fingerprint for local ones. */
const refId = (ref: z.infer<typeof trackRef>): string => {
  return ref.kind === 'server' ? ref.id : ref.fingerprint;
};

const libraryQuery = z.object({
  sort: z.enum(['addedAt', 'title', 'playCount']).default('addedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const recentlyPlayedQuery = z.object({ limit: queryInt(1, 100).default(10) });
const mostPlayedQuery = z.object({
  limit: queryInt(1, 100).default(20),
  window: z.enum(['30d', '365d']).optional(),
});

const playlistName = z
  .string({ required_error: 'Missing playlist name', invalid_type_error: 'Playlist name must be text' })
  .trim()
  .min(1, 'Missing playlist name')
  .max(100, 'Playlist name must be at most 100 characters');
const playlistDescription = z.string().max(500, 'Description must be at most 500 characters');
// `offline` predates the contract's local | synced | online and is still accepted.
const createPlaylistSchema = z.object({
  name: playlistName,
  kind: z.enum(['local', 'synced', 'online', 'offline']).default('online'),
  description: playlistDescription.optional(),
});
const updatePlaylistSchema = z.object({
  name: playlistName.optional(),
  description: playlistDescription.optional(),
});
const addTracksSchema = z.object({
  trackIds: z
    .array(trackId, { required_error: 'trackIds must be an array', invalid_type_error: 'trackIds must be an array' })
    .max(500, 'At most 500 tracks at a time'),
  metas: z.record(z.unknown()).optional(),
});
const removeTracksSchema = z.object({
  entryIds: z.array(z.string().uuid()).max(500).optional(),
  index: z.number().int().min(0).optional(),
  trackIds: z.array(trackId).max(500).optional(),
});
const position = z.number({ required_error: 'Missing from or to' }).int().min(0);
const reorderSchema = z
  .object({
    from: position.optional(),
    to: position,
    entryId: z.string().uuid().optional(),
  })
  .refine((b) => b.from !== undefined || b.entryId !== undefined, 'Send from or entryId');

const syncSchema = z.object({
  since: z.number().optional(),
  plays: z
    .array(
      z.object({
        trackRef,
        at: z.number().positive(),
        ms: z.number().min(0).transform(Math.round).optional(),
        // What the app knew about the song (it may have found it in-app, unknown to the backend).
        meta: metaParam,
      }),
    )
    .max(1000)
    .optional(),
  favourites: z
    .array(z.object({ trackRef, at: z.number().positive().optional(), meta: metaParam }))
    .max(1000)
    .optional(),
  // Sent by the desktop app; not used yet.
  playlists: z.array(z.unknown()).optional(),
});

const playerStateSchema = z.object({
  trackRef: trackRef.nullable().optional(),
  positionMs: z.number().int().min(0).optional(),
  queue: z.array(z.unknown()).max(5000).optional(),
  index: z.number().int().min(0).optional(),
  shuffle: z.boolean().optional(),
  repeat: z.enum(['off', 'all', 'one']).optional(),
});

// Protect all /me routes with requireAuth
meRouter.use(requireAuth);

/**
 * The account behind a request, or a 401 when it is gone: requireAuth caches users for a minute,
 * so an account deleted on another device can still get this far.
 */
const accountOr401 = async (req: Request, res: Response): Promise<typeof users.$inferSelect | null> => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (user) return user;
  forgetAuthUser(req.user!.id);
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User no longer exists' } });
  return null;
};

const userResponse = (user: typeof users.$inferSelect) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  emailVerified: user.emailVerifiedAt !== null,
  createdAt: user.createdAt,
});

meRouter.get('/', async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }
  res.json(userResponse(user));
});

const profileSchema = z.object({
  displayName: z
    .string({ required_error: 'Missing displayName' })
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Name must be at most 100 characters'),
});
const deleteAccountSchema = z.object({ password: z.string({ required_error: 'Enter your password' }).min(1).max(128) });

meRouter.patch('/', async (req, res) => {
  const { displayName } = parseBody(profileSchema, req);
  const [user] = await db.update(users).set({ displayName }).where(eq(users.id, req.user!.id)).returning();
  if (!user) {
    forgetAuthUser(req.user!.id);
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User no longer exists' } });
    return;
  }
  res.json(userResponse(user));
});

// Deleting the account takes its library, playlists, plays and settings with it (cascade).
// The password is asked again so a borrowed, signed-in phone can't do it.
meRouter.delete('/', async (req, res) => {
  const { password } = parseBody(deleteAccountSchema, req);
  const user = await accountOr401(req, res);
  if (!user) return;
  if (user.role !== 'user') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'The admin account cannot be deleted here' } });
    return;
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    res.status(400).json({ error: { code: 'WRONG_PASSWORD', message: "That isn't your password" } });
    return;
  }
  await db.delete(users).where(eq(users.id, user.id));
  forgetAuthUser(user.id);
  res.json({ ok: true });
});

// Library
meRouter.get('/library/tracks', async (req, res) => {
  const { sort, order } = parseQuery(libraryQuery, req);
  const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, req.user!.id));

  const items = await hydrateTracks(
    req.user!.id,
    favs.map((f) => ({
      trackRefKind: f.trackRefKind,
      trackRefId: f.trackRefId,
      addedAt: f.addedAt.getTime(),
      favourite: true,
      rowMeta: f.meta,
    })),
  );

  // Sort items
  const isAsc = order === 'asc';
  if (sort === 'title') {
    items.sort((a, b) => (isAsc ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title)));
  } else if (sort === 'playCount') {
    items.sort((a, b) => (isAsc ? a.playCount - b.playCount : b.playCount - a.playCount));
  } else {
    items.sort((a, b) => (isAsc ? a.addedAt - b.addedAt : b.addedAt - a.addedAt));
  }

  res.json({ items, meta: { total: items.length } });
});

meRouter.get('/library/albums', async (req, res) => {
  const favs = await db.select().from(favouriteAlbums).where(eq(favouriteAlbums.userId, req.user!.id));

  // 1. Check row meta; missing ones fetch from catalog_items in ONE batch query
  const missingCatalogIds = favs.filter((f) => !parseAlbumMeta(f.meta)).map((f) => f.albumId);

  const catalogMap =
    missingCatalogIds.length > 0
      ? await getCatalogItems<AlbumMeta>('album', missingCatalogIds)
      : new Map<string, AlbumMeta>();

  const items = await mapLimit(favs, PIPED_LOOKUP_CONCURRENCY, async (f) => {
    const base = { id: idHelpers.prefixYt(f.albumId), addedAt: f.addedAt.getTime() };
    const parsedRow = parseAlbumMeta(f.meta);
    const meta = parsedRow ?? catalogMap.get(f.albumId);

    if (meta) {
      return {
        id: base.id,
        title: meta.title,
        artist: meta.artist,
        artistId: meta.artistId ?? '',
        year: meta.year ?? null,
        trackCount: meta.trackCount ?? null,
        genre: null,
        source: 'server' as const,
        downloaded: false,
        thumbnail: meta.thumbnail || `/api/v1/albums/${base.id}/artwork`,
        addedAt: base.addedAt,
      };
    }

    // Fall back to Piped
    try {
      const playlist = await CachedPiped.playlist(f.albumId);
      const normalized = normalizePlaylistToAlbum(playlist, f.albumId);
      await rememberCatalogItem('album', f.albumId, normalized);
      return { ...normalized, ...base };
    } catch {
      return {
        ...base,
        title: 'Unavailable album',
        artist: '',
        artistId: '',
        year: null,
        trackCount: null,
        genre: null,
        source: 'server' as const,
        downloaded: false,
        thumbnail: `/api/v1/albums/${base.id}/artwork`,
      };
    }
  });
  res.json({ items, meta: { total: favs.length } });
});

// How many liked / playlisted songs are looked at to find artists. Their metadata comes
// through the stream cache, so this bounds the Piped calls on a cold cache.
const DERIVED_ARTIST_SCAN = 150;

// Followed artists first, then the artists of songs the user liked or put in a playlist,
// most songs first. Derived ones carry `following: false` and `songCount`.
meRouter.get('/library/artists', async (req, res) => {
  const userId = req.user!.id;
  const follows = await db.select().from(artistFollows).where(eq(artistFollows.userId, userId));

  // 1. Followed artists: row meta -> catalog_items (ONE batch query) -> Piped
  const missingArtistIds = follows.filter((f) => !parseArtistMeta(f.meta)).map((f) => f.artistId);

  const artistCatalogMap =
    missingArtistIds.length > 0
      ? await getCatalogItems<ArtistMeta>('artist', missingArtistIds)
      : new Map<string, ArtistMeta>();

  const followed = await mapLimit(follows, PIPED_LOOKUP_CONCURRENCY, async (f) => {
    const base = { id: idHelpers.prefixYt(f.artistId), following: true };
    const parsedRow = parseArtistMeta(f.meta);
    const meta = parsedRow ?? artistCatalogMap.get(f.artistId);

    if (meta) {
      return {
        id: base.id,
        name: meta.name,
        albumCount: 0,
        localTrackCount: 0,
        following: true,
        monthlyListeners: meta.monthlyListeners ?? null,
        thumbnail: meta.thumbnail || `/api/v1/artists/${base.id}/artwork`,
      };
    }

    try {
      const channel = await CachedPiped.channel(f.artistId);
      const normalized = normalizeChannelToArtist(channel, f.artistId);
      await rememberCatalogItem('artist', f.artistId, normalized);
      return { ...normalized, ...base };
    } catch {
      return { ...base, name: 'Unavailable artist', albumCount: 0, localTrackCount: 0 };
    }
  });

  // 2. Artists from liked / playlisted songs: row meta -> catalog_items -> Piped
  const [favs, listed] = await Promise.all([
    db
      .select({ id: favouriteTracks.trackRefId, meta: favouriteTracks.meta })
      .from(favouriteTracks)
      .where(and(eq(favouriteTracks.userId, userId), eq(favouriteTracks.trackRefKind, 'server')))
      .orderBy(desc(favouriteTracks.addedAt)),
    db
      .select({ id: playlistTracks.trackRefId, meta: playlistTracks.meta })
      .from(playlistTracks)
      .innerJoin(playlists, eq(playlists.id, playlistTracks.playlistId))
      .where(and(eq(playlists.userId, userId), eq(playlistTracks.trackRefKind, 'server')))
      .orderBy(desc(playlists.updatedAt)),
  ]);

  const rawRows = [...favs, ...listed];
  const uniqueTracks = new Map<string, unknown>();
  for (const r of rawRows) {
    const rawId = r.id.startsWith('yt:') ? r.id.slice(3) : r.id;
    if (!uniqueTracks.has(rawId)) {
      uniqueTracks.set(rawId, r.meta);
    }
    if (uniqueTracks.size >= DERIVED_ARTIST_SCAN) break;
  }

  // Check which tracks have artist info from row meta
  const trackArtistMap = new Map<string, { artistId: string; artist: string }>();
  const missingTrackIds: string[] = [];

  for (const [trackId, rowMeta] of uniqueTracks.entries()) {
    const parsed = parseTrackMeta(rowMeta);
    if (parsed && parsed.artist && parsed.artistId) {
      trackArtistMap.set(trackId, { artistId: parsed.artistId, artist: parsed.artist });
    } else {
      missingTrackIds.push(trackId);
    }
  }

  // Batch-fetch missing from catalog_items
  if (missingTrackIds.length > 0) {
    const trackCatalogMap = await getCatalogItems<TrackMeta>('track', missingTrackIds);
    for (const trackId of [...missingTrackIds]) {
      const cat = trackCatalogMap.get(trackId);
      if (cat && cat.artist && cat.artistId) {
        trackArtistMap.set(trackId, { artistId: cat.artistId, artist: cat.artist });
        const idx = missingTrackIds.indexOf(trackId);
        if (idx !== -1) missingTrackIds.splice(idx, 1);
      }
    }
  }

  // Only call Piped for ids it knows nothing about
  if (missingTrackIds.length > 0) {
    const streams = await mapLimit(missingTrackIds, PIPED_LOOKUP_CONCURRENCY, async (id) => {
      try {
        const s = await CachedPiped.getStream(id);
        const rawTrack = normalizeStreamToTrack(s, id);
        await rememberCatalogItem('track', id, toCatalogTrackData(rawTrack));
        return { id, stream: s };
      } catch {
        return null;
      }
    });

    for (const item of streams) {
      if (!item) continue;
      const artistId = idHelpers.artistIdFromUrl(item.stream.uploaderUrl);
      const artist = item.stream.uploader.replace(/\s*-\s*Topic$/i, '').trim();
      if (artistId && artist) {
        trackArtistMap.set(item.id, { artistId, artist });
      }
    }
  }

  const followedIds = new Set<string>(followed.map((a) => a.id));
  const derived = new Map<string, { id: string; name: string; songCount: number }>();

  for (const { artistId, artist } of trackArtistMap.values()) {
    if (!artistId || followedIds.has(artistId)) continue;
    const known = derived.get(artistId);
    if (known) {
      known.songCount += 1;
    } else {
      derived.set(artistId, { id: artistId, name: artist, songCount: 1 });
    }
  }

  const items = [
    ...followed,
    ...[...derived.values()]
      .sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name))
      .map((a) => ({
        ...a,
        albumCount: 0,
        localTrackCount: 0,
        following: false,
        thumbnail: `/api/v1/artists/${a.id}/artwork`,
      })),
  ];
  res.json({ items, meta: { total: items.length } });
});

// Placeholder: the apps call it, but tracks carry no genre yet.
meRouter.get('/library/genres', async (req, res) => {
  res.json({ items: [], meta: { total: 0 } });
});

// Favourites
meRouter.get('/favourites/tracks', async (req, res) => {
  const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, req.user!.id));
  const items = await hydrateTracks(
    req.user!.id,
    favs.map((f) => ({
      trackRefKind: f.trackRefKind,
      trackRefId: f.trackRefId,
      addedAt: f.addedAt.getTime(),
      favourite: true,
      rowMeta: f.meta,
    })),
  );

  res.json({
    items,
    meta: { total: items.length },
  });
});

// Ids only, for the apps' heart state: no metadata lookups, no Piped.
meRouter.get('/favourites/ids', async (req, res) => {
  const rows = await db
    .select({ trackRefKind: favouriteTracks.trackRefKind, trackRefId: favouriteTracks.trackRefId })
    .from(favouriteTracks)
    .where(eq(favouriteTracks.userId, req.user!.id))
    .orderBy(desc(favouriteTracks.addedAt));

  res.json({
    ids: rows.map((r) =>
      r.trackRefKind === 'server' ? idHelpers.prefixYt(r.trackRefId) : idHelpers.prefixLocal(r.trackRefId),
    ),
  });
});

meRouter.put('/favourites/tracks/:id', async (req, res) => {
  const fullId = req.params.id;
  const isYt = fullId.startsWith('yt:');
  const kind = isYt ? 'server' : 'local';
  const trackRefId = isYt ? idHelpers.extractYtId(fullId) : fullId.replace(/^local:/, '');

  const parsedMeta = parseTrackMeta(req.body?.meta);
  await db
    .insert(favouriteTracks)
    .values({
      userId: req.user!.id,
      trackRefKind: kind,
      trackRefId,
      addedAt: new Date(),
      meta: parsedMeta || null,
    })
    .onConflictDoUpdate({
      target: [favouriteTracks.userId, favouriteTracks.trackRefKind, favouriteTracks.trackRefId],
      set: {
        addedAt: new Date(),
        ...(parsedMeta ? { meta: parsedMeta } : {}),
      },
    });

  res.json({ ok: true });
});

meRouter.delete('/favourites/tracks/:id', async (req, res) => {
  const fullId = req.params.id;
  const isYt = fullId.startsWith('yt:');
  const trackRefId = isYt ? idHelpers.extractYtId(fullId) : fullId.replace(/^local:/, '');

  await db
    .delete(favouriteTracks)
    .where(and(eq(favouriteTracks.userId, req.user!.id), eq(favouriteTracks.trackRefId, trackRefId)));

  res.json({ ok: true });
});

meRouter.put('/favourites/albums/:id', async (req, res) => {
  const albumId = idHelpers.extractYtId(req.params.id);
  const parsedMeta = parseAlbumMeta(req.body?.meta);
  await db
    .insert(favouriteAlbums)
    .values({
      userId: req.user!.id,
      albumId,
      addedAt: new Date(),
      meta: parsedMeta || null,
    })
    .onConflictDoUpdate({
      target: [favouriteAlbums.userId, favouriteAlbums.albumId],
      set: {
        addedAt: new Date(),
        ...(parsedMeta ? { meta: parsedMeta } : {}),
      },
    });

  res.json({ ok: true });
});

meRouter.delete('/favourites/albums/:id', async (req, res) => {
  const albumId = idHelpers.extractYtId(req.params.id);
  await db
    .delete(favouriteAlbums)
    .where(and(eq(favouriteAlbums.userId, req.user!.id), eq(favouriteAlbums.albumId, albumId)));
  res.json({ ok: true });
});

meRouter.put('/following/artists/:id', async (req, res) => {
  const artistId = idHelpers.extractYtId(req.params.id);
  const parsedMeta = parseArtistMeta(req.body?.meta);
  await db
    .insert(artistFollows)
    .values({
      userId: req.user!.id,
      artistId,
      addedAt: new Date(),
      meta: parsedMeta || null,
    })
    .onConflictDoUpdate({
      target: [artistFollows.userId, artistFollows.artistId],
      set: {
        addedAt: new Date(),
        ...(parsedMeta ? { meta: parsedMeta } : {}),
      },
    });

  res.json({ ok: true });
});

meRouter.delete('/following/artists/:id', async (req, res) => {
  const artistId = idHelpers.extractYtId(req.params.id);
  await db
    .delete(artistFollows)
    .where(and(eq(artistFollows.userId, req.user!.id), eq(artistFollows.artistId, artistId)));
  res.json({ ok: true });
});

// Recently & Most Played
meRouter.get('/recently-played', async (req, res) => {
  const { limit } = parseQuery(recentlyPlayedQuery, req);
  const history = await db
    .select()
    .from(playHistory)
    .where(eq(playHistory.userId, req.user!.id))
    .orderBy(desc(playHistory.playedAt))
    .limit(limit);

  const items = await hydrateTracks(
    req.user!.id,
    history.map((h) => ({
      trackRefKind: h.trackRefKind,
      trackRefId: h.trackRefId,
      lastPlayedAt: h.playedAt.getTime(),
      rowMeta: h.meta,
    })),
    { failIfPipedDown: true },
  );

  res.json({
    items,
    meta: { total: items.length },
  });
});

meRouter.get('/most-played', async (req, res) => {
  const query = parseQuery(mostPlayedQuery, req);
  const limit = query.limit;
  const windowDays = query.window === '30d' ? 30 : 365;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const plays = await db
    .select({
      trackRefKind: playHistory.trackRefKind,
      trackRefId: playHistory.trackRefId,
      count: sql<number>`count(*)::int`,
      // The newest snapshot an app sent with a play, if any.
      meta: sql<unknown>`(array_agg(${playHistory.meta} order by ${playHistory.playedAt} desc) filter (where ${playHistory.meta} is not null))[1]`,
    })
    .from(playHistory)
    .where(and(eq(playHistory.userId, req.user!.id), gte(playHistory.playedAt, since)))
    .groupBy(playHistory.trackRefKind, playHistory.trackRefId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  const items = await hydrateTracks(
    req.user!.id,
    plays.map((p) => ({
      trackRefKind: p.trackRefKind,
      trackRefId: p.trackRefId,
      playCount: p.count,
      rowMeta: p.meta,
    })),
    { failIfPipedDown: true },
  );

  res.json({
    items,
    meta: { total: items.length },
  });
});

// Placeholder: the apps call it, but followed artists' releases aren't tracked yet.
meRouter.get('/new-releases', async (req, res) => {
  res.json({ items: [], meta: { total: 0 } });
});

// Playlists CRUD
meRouter.get('/playlists', async (req, res) => {
  const list = await db
    .select({
      id: playlists.id,
      name: playlists.name,
      description: playlists.description,
      kind: playlists.kind,
      updatedAt: playlists.updatedAt,
      trackCount: sql<number>`count(${playlistTracks.id})::int`,
    })
    .from(playlists)
    .leftJoin(playlistTracks, eq(playlists.id, playlistTracks.playlistId))
    .where(eq(playlists.userId, req.user!.id))
    .groupBy(playlists.id, playlists.name, playlists.description, playlists.kind, playlists.updatedAt)
    .orderBy(sql`lower(${playlists.name}) asc`, playlists.createdAt);

  res.json({
    items: list.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      updatedAt: p.updatedAt.getTime(),
      trackCount: p.trackCount,
      downloadedCount: 0,
    })),
    meta: { total: list.length },
  });
});

meRouter.post('/playlists', async (req, res) => {
  const { name, kind, description } = parseBody(createPlaylistSchema, req);

  const id = idHelpers.prefixSonare(crypto.randomUUID());
  const [p] = await db
    .insert(playlists)
    .values({
      id,
      userId: req.user!.id,
      name,
      description,
      kind,
    })
    .returning();

  res.status(201).json({
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.kind,
    trackCount: 0,
    downloadedCount: 0,
    updatedAt: p.updatedAt.getTime(),
  });
});

meRouter.get('/playlists/:id', async (req, res) => {
  const [p] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id)))
    .limit(1);

  if (!p) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  const [{ count }] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, p.id));

  res.json({
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.kind,
    trackCount: count,
    downloadedCount: 0,
    updatedAt: p.updatedAt.getTime(),
  });
});

meRouter.get('/playlists/:id/tracks', async (req, res) => {
  const [p] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id)))
    .limit(1);

  if (!p) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  const rows = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, p.id))
    .orderBy(playlistTracks.position, playlistTracks.id);

  const items = await hydrateTracks(
    req.user!.id,
    rows.map((r) => ({
      trackRefKind: r.trackRefKind,
      trackRefId: r.trackRefId,
      rowMeta: r.meta,
    })),
  );

  res.json({
    items: items.map((item, i) => ({ ...item, entryId: rows[i].id })),
    meta: { total: items.length },
  });
});

meRouter.patch('/playlists/:id', async (req, res) => {
  const { name, description } = parseBody(updatePlaylistSchema, req);
  const set: { name?: string; description?: string | null; updatedAt: Date } = { updatedAt: new Date() };
  if (name !== undefined) set.name = name;
  if (description !== undefined) set.description = description === '' ? null : description;
  const [updated] = await db
    .update(playlists)
    .set(set)
    .where(and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  const [{ count }] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, updated.id));

  res.json({
    id: updated.id,
    name: updated.name,
    description: updated.description,
    kind: updated.kind,
    trackCount: count,
    downloadedCount: 0,
    updatedAt: updated.updatedAt.getTime(),
  });
});

meRouter.delete('/playlists/:id', async (req, res) => {
  await db.delete(playlists).where(and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id)));
  res.json({ ok: true });
});

meRouter.post('/playlists/:id/tracks', async (req, res) => {
  const { trackIds, metas = {} } = parseBody(addTracksSchema, req);
  const playlistId = req.params.id;

  if (!(await ownsPlaylist(req.user!.id, playlistId))) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  await db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${playlistTracks.position}), -1)::int` })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId));
    if (trackIds.length > 0) {
      const rows = trackIds.map((fullId, i) => {
        const isYt = String(fullId).startsWith('yt:');
        const kind = isYt ? 'server' : 'local';
        const trackRefId = isYt ? idHelpers.extractYtId(fullId) : String(fullId).replace(/^local:/, '');
        const rawMeta = metas[fullId] ?? metas[trackRefId];
        const parsedMeta = parseTrackMeta(rawMeta);
        return {
          playlistId,
          position: max + 1 + i,
          trackRefKind: kind,
          trackRefId,
          meta: parsedMeta || null,
        };
      });
      await tx.insert(playlistTracks).values(rows);
    }
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  });
  res.json({ ok: true });
});

// Every playlist mutation must be scoped to the caller: ids are guessable once shared.
const ownsPlaylist = async (userId: string, playlistId: string): Promise<boolean> => {
  const [p] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
    .limit(1);
  return !!p;
};

meRouter.delete('/playlists/:id/tracks', async (req, res) => {
  const { entryIds, index, trackIds } = parseBody(removeTracksSchema, req);
  const playlistId = req.params.id;
  if (!(await ownsPlaylist(req.user!.id, playlistId))) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  await db.transaction(async (tx) => {
    if (entryIds) {
      await tx
        .delete(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, playlistId), inArray(playlistTracks.id, entryIds)));
    } else if (index !== undefined) {
      await tx
        .delete(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.position, index)));
    } else if (trackIds) {
      const rawIds = trackIds.map((id) =>
        String(id).startsWith('yt:') ? idHelpers.extractYtId(id) : String(id).replace(/^local:/, ''),
      );
      await tx
        .delete(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, playlistId), inArray(playlistTracks.trackRefId, rawIds)));
    }

    await tx.execute(sql`
      UPDATE playlist_tracks p SET position = r.rn
      FROM (
        SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS rn
        FROM playlist_tracks WHERE playlist_id = ${playlistId}
      ) r
      WHERE p.id = r.id AND p.position <> r.rn
    `);
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  });
  res.json({ ok: true });
});

meRouter.patch('/playlists/:id/tracks/order', async (req, res) => {
  const { from, to, entryId } = parseBody(reorderSchema, req);

  const playlistId = req.params.id;
  if (!(await ownsPlaylist(req.user!.id, playlistId))) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  let notFound = false;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: playlistTracks.id, position: playlistTracks.position })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(playlistTracks.position, playlistTracks.id);
    let fromIndex = from;
    if (entryId) {
      fromIndex = rows.findIndex((r) => r.id === entryId);
      if (fromIndex === -1) {
        notFound = true;
        return;
      }
    }
    if (fromIndex === undefined) {
      notFound = true;
      return;
    }
    if (!rows[fromIndex] || to < 0 || to >= rows.length) {
      return;
    }
    const reordered = rows.slice();
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(to, 0, moved);
    const moves = sql.join(
      reordered.map((r, i) => sql`(${r.id}::uuid, ${i}::int)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE playlist_tracks AS p SET position = v.pos
      FROM (VALUES ${moves}) AS v(id, pos)
      WHERE p.id = v.id AND p.position <> v.pos
    `);
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  });

  if (notFound) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist entry not found' } });
    return;
  }
  res.json({ ok: true });
});

// Sync & State
meRouter.post('/sync', async (req, res) => {
  const { plays, favourites } = parseBody(syncSchema, req);

  // Count a play on sync receipt from client, where playback met client-side duration threshold (≥30s or ≥50%), ensuring honest count instead of stream URL request.
  // Clients retry a sync whose response they never saw, so this is idempotent: all or
  // nothing, and a listen (user + track + start time) already recorded is skipped.
  if (plays) {
    await db.transaction(async (tx) => {
      for (const p of plays) {
        const trackRefKind = p.trackRef.kind;
        const trackRefId = refId(p.trackRef);
        const playedAt = new Date(p.at);
        const [seen] = await tx
          .select({ id: playHistory.id })
          .from(playHistory)
          .where(
            and(
              eq(playHistory.userId, req.user!.id),
              eq(playHistory.trackRefKind, trackRefKind),
              eq(playHistory.trackRefId, trackRefId),
              eq(playHistory.playedAt, playedAt),
            ),
          )
          .limit(1);
        if (seen) continue;
        await tx.insert(playHistory).values({
          userId: req.user!.id,
          trackRefKind,
          trackRefId,
          playedAt,
          msPlayed: p.ms || 0,
          meta: parseTrackMeta(p.meta),
        });
      }
    });
    await prunePlayHistoryForUser(req.user!.id);
  }

  if (favourites) {
    for (const f of favourites) {
      const parsedMeta = parseTrackMeta(f.meta);
      await db
        .insert(favouriteTracks)
        .values({
          userId: req.user!.id,
          trackRefKind: f.trackRef.kind,
          trackRefId: refId(f.trackRef),
          addedAt: new Date(f.at || Date.now()),
          meta: parsedMeta || null,
        })
        .onConflictDoUpdate({
          target: [favouriteTracks.userId, favouriteTracks.trackRefKind, favouriteTracks.trackRefId],
          set: {
            addedAt: new Date(f.at || Date.now()),
            ...(parsedMeta ? { meta: parsedMeta } : {}),
          },
        });
    }
  }

  res.json({ ok: true, syncedAt: Date.now() });
});

meRouter.get('/player-state', async (req, res) => {
  const [state] = await db.select().from(playerState).where(eq(playerState.userId, req.user!.id)).limit(1);
  let trackRef = null;
  if (state?.trackRefKind && state?.trackRefId) {
    trackRef =
      state.trackRefKind === 'server'
        ? { kind: 'server', id: state.trackRefId }
        : { kind: 'local', fingerprint: state.trackRefId };
  }
  res.json({
    trackRef,
    positionMs: state?.positionMs || 0,
    queue: state?.queue || [],
    index: state?.index || 0,
    shuffle: state?.shuffle || false,
    repeat: state?.repeat || 'off',
    updatedAt: state?.updatedAt ? state.updatedAt.getTime() : 0,
  });
});

meRouter.put('/player-state', async (req, res) => {
  const { positionMs, queue, index, shuffle, repeat, trackRef } = parseBody(playerStateSchema, req);
  await db
    .insert(playerState)
    .values({
      userId: req.user!.id,
      trackRefKind: trackRef?.kind,
      trackRefId: trackRef ? refId(trackRef) : undefined,
      positionMs,
      queue,
      index,
      shuffle,
      repeat,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [playerState.userId],
      set: {
        trackRefKind: trackRef?.kind,
        trackRefId: trackRef ? refId(trackRef) : undefined,
        positionMs,
        queue,
        index,
        shuffle,
        repeat,
        updatedAt: new Date(),
      },
    });

  res.json({ ok: true });
});

const QUALITIES = ['low', 'normal', 'high'] as const;
const DOWNLOAD_FORMATS = ['opus', 'm4a'] as const;

const DEFAULT_SETTINGS = {
  eqPreset: 'Sonare',
  gapless: true,
  normalization: true,
  downloadQuality: 'high',
  stayOffline: false,
  streamQuality: 'high',
  downloadFormat: 'opus',
};

// Apps send only what changed; a field that's missing keeps the stored value.
const settingsSchema = z.object({
  eqPreset: z.string().trim().min(1).max(50).optional(),
  gapless: z.boolean().optional(),
  normalization: z.boolean().optional(),
  stayOffline: z.boolean().optional(),
  // Older apps still send `lossless`, which is stored as `high`.
  downloadQuality: z
    .enum([...QUALITIES, 'lossless'])
    .transform((q) => (q === 'lossless' ? 'high' : q))
    .optional(),
  streamQuality: z.enum(QUALITIES).optional(),
  downloadFormat: z.enum(DOWNLOAD_FORMATS).optional(),
});

meRouter.get('/settings', async (req, res) => {
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, req.user!.id)).limit(1);
  res.json(
    settings
      ? {
          eqPreset: settings.eqPreset,
          gapless: settings.gapless,
          normalization: settings.normalization,
          downloadQuality: settings.downloadQuality,
          stayOffline: settings.stayOffline,
          streamQuality: settings.streamQuality ?? DEFAULT_SETTINGS.streamQuality,
          downloadFormat: settings.downloadFormat ?? DEFAULT_SETTINGS.downloadFormat,
        }
      : DEFAULT_SETTINGS,
  );
});

meRouter.put('/settings', async (req, res) => {
  const changes = parseBody(settingsSchema, req);
  const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  const insert = db.insert(userSettings).values({ userId: req.user!.id, ...set });
  // Nothing to change: still create the row with defaults, but don't touch an existing one.
  await (Object.keys(set).length > 0
    ? insert.onConflictDoUpdate({ target: [userSettings.userId], set })
    : insert.onConflictDoNothing({ target: [userSettings.userId] }));

  res.json({ ok: true });
});
