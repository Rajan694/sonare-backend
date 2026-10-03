import { Router } from 'express';
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
import { eq, and, desc, sql, gte } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { idHelpers } from '../ids.js';
import { hydrateTracks } from '../db/hydrate.js';
import { CachedPiped } from '../services/cache.js';
import { normalizeChannelToArtist, normalizePlaylistToAlbum } from '../normalize/index.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { parseBody, parseQuery, queryInt } from '../validation.js';

export const meRouter = Router();

// ---- Request schemas ----

const trackId = z.string().trim().min(1, 'Track ids must not be empty').max(200);
const trackRef = z.union([
  z.object({ kind: z.literal('server'), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('local'), fingerprint: z.string().min(1).max(200) }),
]);

/** The stored id: a YouTube video id for server tracks, the file fingerprint for local ones. */
function refId(ref: z.infer<typeof trackRef>): string {
  return ref.kind === 'server' ? ref.id : ref.fingerprint;
}

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
});
const removeTracksSchema = z.object({
  index: z.number().int().min(0).optional(),
  trackIds: z.array(trackId).max(500).optional(),
});
const position = z.number({ required_error: 'Missing from or to' }).int().min(0);
const reorderSchema = z.object({ from: position, to: position });

const syncSchema = z.object({
  since: z.number().optional(),
  plays: z
    .array(
      z.object({
        trackRef,
        at: z.number().positive(),
        ms: z.number().min(0).transform(Math.round).optional(),
      }),
    )
    .max(1000)
    .optional(),
  favourites: z
    .array(z.object({ trackRef, at: z.number().positive().optional() }))
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

meRouter.get('/', async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  });
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
  // The table only stores ids; the Library tab needs titles and artists to render cards.
  // Details come through the playlist cache, and one failing album must not sink the list.
  const items = await Promise.all(
    favs.map(async (f) => {
      const base = { id: idHelpers.prefixYt(f.albumId), addedAt: f.addedAt.getTime() };
      try {
        return { ...normalizePlaylistToAlbum(await CachedPiped.playlist(f.albumId), f.albumId), ...base };
      } catch {
        return {
          ...base,
          title: 'Unavailable album',
          artist: '',
          artistId: '',
          year: null,
          trackCount: null,
          genre: null,
          source: 'server',
          downloaded: false,
        };
      }
    }),
  );
  res.json({ items, meta: { total: favs.length } });
});

meRouter.get('/library/artists', async (req, res) => {
  const follows = await db.select().from(artistFollows).where(eq(artistFollows.userId, req.user!.id));
  const items = await Promise.all(
    follows.map(async (f) => {
      const base = { id: idHelpers.prefixYt(f.artistId), following: true };
      try {
        return { ...normalizeChannelToArtist(await CachedPiped.channel(f.artistId), f.artistId), ...base };
      } catch {
        return { ...base, name: 'Unavailable artist', albumCount: 0, localTrackCount: 0 };
      }
    }),
  );
  res.json({ items, meta: { total: follows.length } });
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
    })),
  );

  res.json({
    items,
    meta: { total: items.length },
  });
});

meRouter.put('/favourites/tracks/:id', async (req, res) => {
  const fullId = req.params.id;
  const isYt = fullId.startsWith('yt:');
  const kind = isYt ? 'server' : 'local';
  const trackRefId = isYt ? idHelpers.extractYtId(fullId) : fullId.replace(/^local:/, '');

  await db
    .insert(favouriteTracks)
    .values({
      userId: req.user!.id,
      trackRefKind: kind,
      trackRefId,
      addedAt: new Date(),
    })
    .onConflictDoNothing();

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
  await db
    .insert(favouriteAlbums)
    .values({
      userId: req.user!.id,
      albumId,
      addedAt: new Date(),
    })
    .onConflictDoNothing();
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
  await db
    .insert(artistFollows)
    .values({
      userId: req.user!.id,
      artistId,
      addedAt: new Date(),
    })
    .onConflictDoNothing();
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
    .groupBy(playlists.id, playlists.name, playlists.description, playlists.kind, playlists.updatedAt);

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
    .orderBy(playlistTracks.position);

  const items = await hydrateTracks(
    req.user!.id,
    rows.map((r) => ({
      trackRefKind: r.trackRefKind,
      trackRefId: r.trackRefId,
    })),
  );

  res.json({
    items,
    meta: { total: items.length },
  });
});

meRouter.patch('/playlists/:id', async (req, res) => {
  const { name, description } = parseBody(updatePlaylistSchema, req);
  const [updated] = await db
    .update(playlists)
    .set({
      name: name || undefined,
      description: description || undefined,
      updatedAt: new Date(),
    })
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
  const { trackIds } = parseBody(addTracksSchema, req);

  const [p] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id)))
    .limit(1);

  if (!p) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  const current = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, p.id));
  let pos = current.length;

  for (const fullId of trackIds) {
    const isYt = String(fullId).startsWith('yt:');
    const kind = isYt ? 'server' : 'local';
    const trackRefId = isYt ? idHelpers.extractYtId(fullId) : String(fullId).replace(/^local:/, '');

    await db.insert(playlistTracks).values({
      playlistId: p.id,
      position: pos++,
      trackRefKind: kind,
      trackRefId,
    });
  }

  await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, p.id));
  res.json({ ok: true });
});

// Every playlist mutation must be scoped to the caller: ids are guessable once shared.
async function ownsPlaylist(userId: string, playlistId: string): Promise<boolean> {
  const [p] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
    .limit(1);
  return !!p;
}

meRouter.delete('/playlists/:id/tracks', async (req, res) => {
  const { index, trackIds } = parseBody(removeTracksSchema, req);
  const playlistId = req.params.id;
  if (!(await ownsPlaylist(req.user!.id, playlistId))) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }

  if (index !== undefined) {
    await db
      .delete(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.position, index)));
  } else if (trackIds) {
    for (const id of trackIds) {
      const rawId = id.startsWith('yt:') ? idHelpers.extractYtId(id) : id.replace(/^local:/, '');
      await db
        .delete(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackRefId, rawId)));
    }
  }

  // Re-index remaining positions
  const remaining = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(playlistTracks.position);

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].position !== i) {
      await db.update(playlistTracks).set({ position: i }).where(eq(playlistTracks.id, remaining[i].id));
    }
  }

  await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  res.json({ ok: true });
});

meRouter.patch('/playlists/:id/tracks/order', async (req, res) => {
  const { from, to } = parseBody(reorderSchema, req);

  const playlistId = req.params.id;
  if (!(await ownsPlaylist(req.user!.id, playlistId))) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
    return;
  }
  const tracks = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(playlistTracks.position);

  if (tracks[from] && tracks[to]) {
    // Reorder in memory and update positions
    const [moved] = tracks.splice(from, 1);
    tracks.splice(to, 0, moved);

    for (let i = 0; i < tracks.length; i++) {
      await db.update(playlistTracks).set({ position: i }).where(eq(playlistTracks.id, tracks[i].id));
    }
  }

  await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
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
        });
      }
    });
  }

  if (favourites) {
    for (const f of favourites) {
      await db
        .insert(favouriteTracks)
        .values({
          userId: req.user!.id,
          trackRefKind: f.trackRef.kind,
          trackRefId: refId(f.trackRef),
          addedAt: new Date(f.at || Date.now()),
        })
        .onConflictDoNothing();
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
  eqPreset: 'Flat',
  gapless: false,
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
