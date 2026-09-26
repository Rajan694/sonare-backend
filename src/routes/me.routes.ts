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
  playerState 
} from '../db/schema.js';
import { eq, and, desc, sql, gte } from 'drizzle-orm';
import { requireAuth } from '../auth.js';
import { idHelpers } from '../ids.js';
import { BadRequestError } from '../errors.js';
import { hydrateTracks } from '../db/hydrate.js';
import { CachedPiped } from '../cache.js';
import { normalizeChannelToArtist, normalizePlaylistToAlbum } from '../normalize/index.js';
import crypto from 'node:crypto';

export const meRouter = Router();

// Protect all /me routes with requireAuth
meRouter.use(requireAuth);

meRouter.get('/', async (req, res, next) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!user) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
    });
  } catch (e) {
    next(e);
  }
});

// Library
meRouter.get('/library/tracks', async (req, res, next) => {
  try {
    const { sort = 'addedAt', order = 'desc' } = req.query;
    const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, req.user!.id));
    
    let items = await hydrateTracks(req.user!.id, favs.map(f => ({
      trackRefKind: f.trackRefKind,
      trackRefId: f.trackRefId,
      addedAt: f.addedAt.getTime(),
      favourite: true,
    })));

    // Sort items
    const isAsc = order === 'asc';
    if (sort === 'title') {
      items.sort((a, b) => isAsc ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title));
    } else if (sort === 'playCount') {
      items.sort((a, b) => isAsc ? a.playCount - b.playCount : b.playCount - a.playCount);
    } else {
      items.sort((a, b) => isAsc ? a.addedAt - b.addedAt : b.addedAt - a.addedAt);
    }

    res.json({ items, meta: { total: items.length } });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/library/albums', async (req, res, next) => {
  try {
    const favs = await db.select().from(favouriteAlbums).where(eq(favouriteAlbums.userId, req.user!.id));
    // The table only stores ids; the Library tab needs titles and artists to render cards.
    // Details come through the playlist cache, and one failing album must not sink the list.
    const items = await Promise.all(favs.map(async f => {
      const base = { id: idHelpers.prefixYt(f.albumId), addedAt: f.addedAt.getTime() };
      try {
        return { ...normalizePlaylistToAlbum(await CachedPiped.playlist(f.albumId), f.albumId), ...base };
      } catch {
        return { ...base, title: 'Unavailable album', artist: '', artistId: '', year: null, trackCount: null, genre: null, source: 'server', downloaded: false };
      }
    }));
    res.json({ items, meta: { total: favs.length } });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/library/artists', async (req, res, next) => {
  try {
    const follows = await db.select().from(artistFollows).where(eq(artistFollows.userId, req.user!.id));
    const items = await Promise.all(follows.map(async f => {
      const base = { id: idHelpers.prefixYt(f.artistId), following: true };
      try {
        return { ...normalizeChannelToArtist(await CachedPiped.channel(f.artistId), f.artistId), ...base };
      } catch {
        return { ...base, name: 'Unavailable artist', albumCount: 0, localTrackCount: 0 };
      }
    }));
    res.json({ items, meta: { total: follows.length } });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/library/genres', async (req, res) => {
  res.json({ items: [], meta: { total: 0 } });
});

// Favourites
meRouter.get('/favourites/tracks', async (req, res, next) => {
  try {
    const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, req.user!.id));
    const items = await hydrateTracks(req.user!.id, favs.map(f => ({
      trackRefKind: f.trackRefKind,
      trackRefId: f.trackRefId,
      addedAt: f.addedAt.getTime(),
      favourite: true,
    })));

    res.json({
      items,
      meta: { total: items.length }
    });
  } catch (e) {
    next(e);
  }
});

meRouter.put('/favourites/tracks/:id', async (req, res, next) => {
  try {
    const fullId = req.params.id;
    const isYt = fullId.startsWith('yt:');
    const kind = isYt ? 'server' : 'local';
    const trackRefId = isYt ? idHelpers.extractYtId(fullId) : fullId.replace(/^local:/, '');

    await db.insert(favouriteTracks).values({
      userId: req.user!.id,
      trackRefKind: kind,
      trackRefId,
      addedAt: new Date(),
    }).onConflictDoNothing();

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.delete('/favourites/tracks/:id', async (req, res, next) => {
  try {
    const fullId = req.params.id;
    const isYt = fullId.startsWith('yt:');
    const trackRefId = isYt ? idHelpers.extractYtId(fullId) : fullId.replace(/^local:/, '');

    await db.delete(favouriteTracks).where(
      and(
        eq(favouriteTracks.userId, req.user!.id),
        eq(favouriteTracks.trackRefId, trackRefId)
      )
    );

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.put('/favourites/albums/:id', async (req, res, next) => {
  try {
    const albumId = idHelpers.extractYtId(req.params.id);
    await db.insert(favouriteAlbums).values({
      userId: req.user!.id,
      albumId,
      addedAt: new Date(),
    }).onConflictDoNothing();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.delete('/favourites/albums/:id', async (req, res, next) => {
  try {
    const albumId = idHelpers.extractYtId(req.params.id);
    await db.delete(favouriteAlbums).where(
      and(eq(favouriteAlbums.userId, req.user!.id), eq(favouriteAlbums.albumId, albumId))
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.put('/following/artists/:id', async (req, res, next) => {
  try {
    const artistId = idHelpers.extractYtId(req.params.id);
    await db.insert(artistFollows).values({
      userId: req.user!.id,
      artistId,
      addedAt: new Date(),
    }).onConflictDoNothing();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.delete('/following/artists/:id', async (req, res, next) => {
  try {
    const artistId = idHelpers.extractYtId(req.params.id);
    await db.delete(artistFollows).where(
      and(eq(artistFollows.userId, req.user!.id), eq(artistFollows.artistId, artistId))
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Recently & Most Played
meRouter.get('/recently-played', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const history = await db.select().from(playHistory).where(
      eq(playHistory.userId, req.user!.id)
    ).orderBy(desc(playHistory.playedAt)).limit(limit);

    const items = await hydrateTracks(req.user!.id, history.map(h => ({
      trackRefKind: h.trackRefKind,
      trackRefId: h.trackRefId,
      lastPlayedAt: h.playedAt.getTime(),
    })), { failIfPipedDown: true });

    res.json({
      items,
      meta: { total: items.length }
    });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/most-played', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const windowDays = req.query.window === '30d' ? 30 : 365;
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

    const plays = await db.select({
      trackRefKind: playHistory.trackRefKind,
      trackRefId: playHistory.trackRefId,
      count: sql<number>`count(*)::int`,
    }).from(playHistory).where(
      and(
        eq(playHistory.userId, req.user!.id),
        gte(playHistory.playedAt, since)
      )
    ).groupBy(playHistory.trackRefKind, playHistory.trackRefId)
     .orderBy(desc(sql`count(*)`))
     .limit(limit);

    const items = await hydrateTracks(req.user!.id, plays.map(p => ({
      trackRefKind: p.trackRefKind,
      trackRefId: p.trackRefId,
      playCount: p.count,
    })), { failIfPipedDown: true });

    res.json({
      items,
      meta: { total: items.length }
    });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/new-releases', async (req, res) => {
  res.json({ items: [], meta: { total: 0 } });
});

// Playlists CRUD
meRouter.get('/playlists', async (req, res, next) => {
  try {
    const list = await db.select({
      id: playlists.id,
      name: playlists.name,
      description: playlists.description,
      kind: playlists.kind,
      updatedAt: playlists.updatedAt,
      trackCount: sql<number>`count(${playlistTracks.id})::int`,
    }).from(playlists)
      .leftJoin(playlistTracks, eq(playlists.id, playlistTracks.playlistId))
      .where(eq(playlists.userId, req.user!.id))
      .groupBy(playlists.id, playlists.name, playlists.description, playlists.kind, playlists.updatedAt);

    res.json({
      items: list.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        kind: p.kind,
        updatedAt: p.updatedAt.getTime(),
        trackCount: p.trackCount,
        downloadedCount: 0,
      })),
      meta: { total: list.length }
    });
  } catch (e) {
    next(e);
  }
});

meRouter.post('/playlists', async (req, res, next) => {
  try {
    const { name, kind = 'online', description } = req.body;
    if (!name) throw new BadRequestError('Missing playlist name');

    const id = idHelpers.prefixSonare(crypto.randomUUID());
    const [p] = await db.insert(playlists).values({
      id,
      userId: req.user!.id,
      name,
      description,
      kind,
    }).returning();

    res.status(201).json({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      trackCount: 0,
      downloadedCount: 0,
      updatedAt: p.updatedAt.getTime(),
    });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/playlists/:id', async (req, res, next) => {
  try {
    const [p] = await db.select().from(playlists).where(
      and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id))
    ).limit(1);

    if (!p) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
      return;
    }

    const [{ count }] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(playlistTracks).where(eq(playlistTracks.playlistId, p.id));

    res.json({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      trackCount: count,
      downloadedCount: 0,
      updatedAt: p.updatedAt.getTime(),
    });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/playlists/:id/tracks', async (req, res, next) => {
  try {
    const [p] = await db.select().from(playlists).where(
      and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id))
    ).limit(1);

    if (!p) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
      return;
    }

    const rows = await db.select().from(playlistTracks).where(
      eq(playlistTracks.playlistId, p.id)
    ).orderBy(playlistTracks.position);

    const items = await hydrateTracks(req.user!.id, rows.map(r => ({
      trackRefKind: r.trackRefKind,
      trackRefId: r.trackRefId,
    })));

    res.json({
      items,
      meta: { total: items.length }
    });
  } catch (e) {
    next(e);
  }
});

meRouter.patch('/playlists/:id', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const [updated] = await db.update(playlists).set({
      name: name || undefined,
      description: description || undefined,
      updatedAt: new Date(),
    }).where(
      and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id))
    ).returning();

    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
      return;
    }

    const [{ count }] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(playlistTracks).where(eq(playlistTracks.playlistId, updated.id));

    res.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      kind: updated.kind,
      trackCount: count,
      downloadedCount: 0,
      updatedAt: updated.updatedAt.getTime(),
    });
  } catch (e) {
    next(e);
  }
});

meRouter.delete('/playlists/:id', async (req, res, next) => {
  try {
    await db.delete(playlists).where(
      and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id))
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.post('/playlists/:id/tracks', async (req, res, next) => {
  try {
    const { trackIds } = req.body;
    if (!Array.isArray(trackIds)) throw new BadRequestError('trackIds must be an array');

    const [p] = await db.select().from(playlists).where(
      and(eq(playlists.id, req.params.id), eq(playlists.userId, req.user!.id))
    ).limit(1);

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
  } catch (e) {
    next(e);
  }
});

// Every playlist mutation must be scoped to the caller: ids are guessable once shared.
async function ownsPlaylist(userId: string, playlistId: string): Promise<boolean> {
  const [p] = await db.select({ id: playlists.id }).from(playlists).where(
    and(eq(playlists.id, playlistId), eq(playlists.userId, userId))
  ).limit(1);
  return !!p;
}

meRouter.delete('/playlists/:id/tracks', async (req, res, next) => {
  try {
    const { index, trackIds } = req.body;
    const playlistId = req.params.id;
    if (!(await ownsPlaylist(req.user!.id, playlistId))) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
      return;
    }

    if (index !== undefined) {
      await db.delete(playlistTracks).where(
        and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.position, index))
      );
    } else if (Array.isArray(trackIds)) {
      for (const id of trackIds) {
        const rawId = id.startsWith('yt:') ? idHelpers.extractYtId(id) : id.replace(/^local:/, '');
        await db.delete(playlistTracks).where(
          and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackRefId, rawId))
        );
      }
    }

    // Re-index remaining positions
    const remaining = await db.select().from(playlistTracks).where(
      eq(playlistTracks.playlistId, playlistId)
    ).orderBy(playlistTracks.position);

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].position !== i) {
        await db.update(playlistTracks).set({ position: i }).where(eq(playlistTracks.id, remaining[i].id));
      }
    }

    await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.patch('/playlists/:id/tracks/order', async (req, res, next) => {
  try {
    const { from, to } = req.body;
    if (from === undefined || to === undefined) throw new BadRequestError('Missing from or to');

    const playlistId = req.params.id;
    if (!(await ownsPlaylist(req.user!.id, playlistId))) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Playlist not found' } });
      return;
    }
    const tracks = await db.select().from(playlistTracks).where(
      eq(playlistTracks.playlistId, playlistId)
    ).orderBy(playlistTracks.position);

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
  } catch (e) {
    next(e);
  }
});

// Sync & State
meRouter.post('/sync', async (req, res, next) => {
  try {
    const { plays, favourites } = req.body;

    // Count a play on sync receipt from client, where playback met client-side duration threshold (≥30s or ≥50%), ensuring honest count instead of stream URL request.
    // Clients retry a sync whose response they never saw, so this is idempotent: all or
    // nothing, and a listen (user + track + start time) already recorded is skipped.
    if (Array.isArray(plays)) {
      await db.transaction(async (tx) => {
        for (const p of plays) {
          if (!p.trackRef || !p.at) continue;
          const trackRefKind = p.trackRef.kind || 'server';
          const trackRefId = p.trackRef.id || p.trackRef.fingerprint;
          const playedAt = new Date(p.at);
          const [seen] = await tx.select({ id: playHistory.id }).from(playHistory).where(and(
            eq(playHistory.userId, req.user!.id),
            eq(playHistory.trackRefKind, trackRefKind),
            eq(playHistory.trackRefId, trackRefId),
            eq(playHistory.playedAt, playedAt),
          )).limit(1);
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

    if (Array.isArray(favourites)) {
      for (const f of favourites) {
        if (f.trackRef) {
          await db.insert(favouriteTracks).values({
            userId: req.user!.id,
            trackRefKind: f.trackRef.kind || 'server',
            trackRefId: f.trackRef.id || f.trackRef.fingerprint,
            addedAt: new Date(f.at || Date.now()),
          }).onConflictDoNothing();
        }
      }
    }

    res.json({ ok: true, syncedAt: Date.now() });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/player-state', async (req, res, next) => {
  try {
    const [state] = await db.select().from(playerState).where(eq(playerState.userId, req.user!.id)).limit(1);
    let trackRef = null;
    if (state?.trackRefKind && state?.trackRefId) {
      trackRef = state.trackRefKind === 'server'
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
  } catch (e) {
    next(e);
  }
});

meRouter.put('/player-state', async (req, res, next) => {
  try {
    const { positionMs, queue, index, shuffle, repeat, trackRef } = req.body;
    await db.insert(playerState).values({
      userId: req.user!.id,
      trackRefKind: trackRef?.kind,
      trackRefId: trackRef?.id || trackRef?.fingerprint,
      positionMs,
      queue,
      index,
      shuffle,
      repeat,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [playerState.userId],
      set: {
        trackRefKind: trackRef?.kind,
        trackRefId: trackRef?.id || trackRef?.fingerprint,
        positionMs,
        queue,
        index,
        shuffle,
        repeat,
        updatedAt: new Date(),
      }
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

meRouter.get('/settings', async (req, res, next) => {
  try {
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, req.user!.id)).limit(1);
    res.json(settings ? {
      eqPreset: settings.eqPreset,
      gapless: settings.gapless,
      normalization: settings.normalization,
      downloadQuality: settings.downloadQuality,
      stayOffline: settings.stayOffline,
    } : {
      eqPreset: 'Flat',
      gapless: false,
      normalization: true,
      downloadQuality: 'high',
      stayOffline: false,
    });
  } catch (e) {
    next(e);
  }
});

meRouter.put('/settings', async (req, res, next) => {
  try {
    const { eqPreset, gapless, normalization, downloadQuality, stayOffline } = req.body;
    await db.insert(userSettings).values({
      userId: req.user!.id,
      eqPreset,
      gapless,
      normalization,
      downloadQuality,
      stayOffline,
    }).onConflictDoUpdate({
      target: [userSettings.userId],
      set: {
        eqPreset,
        gapless,
        normalization,
        downloadQuality,
        stayOffline,
      }
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
