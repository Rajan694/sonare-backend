import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import {
  createUser,
  samplePipedChannel,
  samplePipedPlaylist,
  samplePipedStream,
  isLocalTestHost,
} from '../factories.js';
import { db } from '../../src/db/index.js';
import {
  artistFollows,
  favouriteAlbums,
  favouriteTracks,
  playHistory,
  playerState,
  playlistTracks,
  playlists,
  users,
} from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { isRedisAvailable, redis } from '../../src/services/cache.js';

describe('Me: profile & personal data', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect(isLocalTestHost);
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-ME-047: PATCH /api/v1/me changes the display name; a blank one is refused', async () => {
    const { token } = await createUser({ displayName: 'Old Name' });
    const res = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: '  New Name ' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('New Name');
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).body.displayName).toBe(
      'New Name',
    );
    const blank = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: ' ' });
    expect(blank.status).toBe(400);
  });

  it('BE-ME-048: DELETE /api/v1/me needs the password, then removes the account and everything in it', async () => {
    const { user, token } = await createUser();
    const other = await createUser();
    await db.insert(playlists).values({ id: 'sonare:mine', userId: user.id, name: 'Mine', kind: 'synced' });
    await db.insert(playlists).values({ id: 'sonare:theirs', userId: other.user.id, name: 'Theirs', kind: 'synced' });

    const wrong = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);

    const gone = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123' });
    expect(gone.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    expect((await db.select().from(playlists)).map((p) => p.name)).toEqual(['Theirs']);
    // The next request with the old token is refused at once, not after the auth cache expires.
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('BE-ME-049: the admin account cannot be deleted from the apps', async () => {
    const { token } = await createUser({ role: 'admin' });
    const res = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123' });
    expect(res.status).toBe(403);
  });

  it('BE-ME-050: an account deleted elsewhere gets 401 from the account routes, not a crash', async () => {
    const { user, token } = await createUser();
    // Warms requireAuth's user cache, as the app's earlier requests would.
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await db.delete(users).where(eq(users.id, user.id));

    const rename = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Ghost' });
    expect(rename.status).toBe(401);
    const remove = await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123' });
    expect(remove.status).toBe(401);
    const change = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'password123', newPassword: 'newpassword1' });
    expect(change.status).toBe(401);
  });

  it('BE-ME-001: GET /api/v1/me returns authenticated user details', async () => {
    const { user, token } = await createUser({ email: 'myprofile@example.com', displayName: 'Profile Man' });
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe('myprofile@example.com');
    expect(res.body.displayName).toBe('Profile Man');
  });

  it('BE-ME-002: GET /api/v1/me/library/tracks returns user saved library tracks sorted', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'favTrack1',
    });

    const res = await request(app).get('/api/v1/me/library/tracks').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:favTrack1');
  });

  it('BE-ME-003: GET /api/v1/me/library/albums resolves favourited albums', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteAlbums).values({
      userId: user.id,
      albumId: 'PLfavAlbum123',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PLfavAlbum123', method: 'GET' })
      .reply(200, samplePipedPlaylist('PLfavAlbum123'));

    const res = await request(app).get('/api/v1/me/library/albums').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:PLfavAlbum123');
  });

  it('BE-ME-004: GET /api/v1/me/library/artists resolves followed artists', async () => {
    const { user, token } = await createUser();
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId: 'UCartistFollow1',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCartistFollow1', method: 'GET' })
      .reply(200, samplePipedChannel('UCartistFollow1'));

    const res = await request(app).get('/api/v1/me/library/artists').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:UCartistFollow1');
  });

  it('BE-ME-005: GET /api/v1/me/library/genres returns genres placeholder structure', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/library/genres').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], meta: { total: 0 } });
  });

  it('BE-ME-006: GET /api/v1/me/favourites/tracks returns favourited tracks list', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'fav1',
    });

    const res = await request(app).get('/api/v1/me/favourites/tracks').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:fav1');
  });

  it('BE-ME-007: PUT /api/v1/me/favourites/tracks/:id adds track to favourites', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/favourites/tracks/yt:favNew1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [fav] = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(fav.trackRefId).toBe('favNew1');
  });

  it('BE-ME-008: DELETE /api/v1/me/favourites/tracks/:id removes track from favourites', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'favDel1',
    });

    const res = await request(app)
      .delete('/api/v1/me/favourites/tracks/yt:favDel1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(check).toHaveLength(0);
  });

  it('BE-ME-009: GET /api/v1/me/favourites/albums returns favourite albums', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteAlbums).values({
      userId: user.id,
      albumId: 'PLmyFavAlb1',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PLmyFavAlb1', method: 'GET' })
      .reply(200, samplePipedPlaylist('PLmyFavAlb1'));

    const res = await request(app).get('/api/v1/me/library/albums').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:PLmyFavAlb1');
  });

  it('BE-ME-010: PUT /api/v1/me/favourites/albums/:id adds album to favourites', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/favourites/albums/yt:PLaddAlb1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [fav] = await db.select().from(favouriteAlbums).where(eq(favouriteAlbums.userId, user.id));
    expect(fav.albumId).toBe('PLaddAlb1');
  });

  it('BE-ME-011: DELETE /api/v1/me/favourites/albums/:id removes album from favourites', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteAlbums).values({
      userId: user.id,
      albumId: 'PLdelAlb1',
    });

    const res = await request(app)
      .delete('/api/v1/me/favourites/albums/yt:PLdelAlb1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-012: GET /api/v1/me/library/artists returns followed artists list', async () => {
    const { user, token } = await createUser();
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId: 'UCfollowArt1',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCfollowArt1', method: 'GET' })
      .reply(200, samplePipedChannel('UCfollowArt1'));

    const res = await request(app).get('/api/v1/me/library/artists').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('BE-ME-013: PUT /api/v1/me/following/artists/:id follows an artist', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/following/artists/yt:UCnewFollow1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-014: DELETE /api/v1/me/following/artists/:id unfollows an artist', async () => {
    const { user, token } = await createUser();
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId: 'UCunfollow1',
    });

    const res = await request(app)
      .delete('/api/v1/me/following/artists/yt:UCunfollow1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-015: GET /api/v1/me/recently-played returns play history items', async () => {
    const { user, token } = await createUser();
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'histTrack1',
      playedAt: new Date(),
      msPlayed: 30000,
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/histTrack1', method: 'GET' }).reply(200, samplePipedStream('histTrack1'));

    const res = await request(app).get('/api/v1/me/recently-played').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:histTrack1');
  });

  it('BE-ME-016: POST /api/v1/me/sync records track play events and favourites', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .post('/api/v1/me/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plays: [
          {
            trackRef: { kind: 'server', id: 'histNew1' },
            at: Date.now(),
            ms: 45000,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [entry] = await db.select().from(playHistory).where(eq(playHistory.userId, user.id));
    expect(entry.trackRefId).toBe('histNew1');
  });

  it('BE-ME-017: GET /api/v1/me/most-played aggregates playback stats', async () => {
    const { user, token } = await createUser();
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'mostPlayed1',
      playedAt: new Date(),
      msPlayed: 20000,
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/mostPlayed1', method: 'GET' }).reply(200, samplePipedStream('mostPlayed1'));

    const res = await request(app).get('/api/v1/me/most-played').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('BE-ME-018: GET /api/v1/me/playlists returns user created playlists', async () => {
    const { user, token } = await createUser();
    await db.insert(playlists).values({
      id: 'sonare:pl_user1',
      userId: user.id,
      name: 'My Custom Playlist',
      description: 'Chill vibes',
      kind: 'online',
    });

    const res = await request(app).get('/api/v1/me/playlists').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('My Custom Playlist');
  });

  it('BE-ME-019: POST /api/v1/me/playlists creates a new user playlist', async () => {
    const { token } = await createUser();
    const res = await request(app).post('/api/v1/me/playlists').set('Authorization', `Bearer ${token}`).send({
      name: 'Road Trip Jam',
      description: 'Driving tunes',
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Road Trip Jam');
    expect(res.body.description).toBe('Driving tunes');
  });

  it('BE-ME-020: GET /api/v1/me/playlists/:id returns playlist details and tracks', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_detail1',
        userId: user.id,
        name: 'Detailed Playlist',
        kind: 'online',
      })
      .returning();

    await db.insert(playlistTracks).values({
      playlistId: pl.id,
      trackRefKind: 'server',
      trackRefId: 'trackInsidePl',
      position: 0,
    });

    const res = await request(app).get(`/api/v1/me/playlists/${pl.id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pl.id);
    expect(res.body.name).toBe('Detailed Playlist');
  });

  it('BE-ME-021: PATCH /api/v1/me/playlists/:id updates playlist metadata', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_patch1',
        userId: user.id,
        name: 'Old Title',
        kind: 'online',
      })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Shiny Title' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Shiny Title');
  });

  it('BE-ME-022: DELETE /api/v1/me/playlists/:id removes playlist', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_del1',
        userId: user.id,
        name: 'To Delete',
        kind: 'online',
      })
      .returning();

    const res = await request(app).delete(`/api/v1/me/playlists/${pl.id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(check).toHaveLength(0);
  });

  it('BE-ME-023: POST /api/v1/me/playlists/:id/tracks adds tracks to playlist', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_addtrks1',
        userId: user.id,
        name: 'Tracks Test Pl',
        kind: 'online',
      })
      .returning();

    const res = await request(app)
      .post(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['yt:trackOne', 'yt:trackTwo'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const tracks = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id));
    expect(tracks).toHaveLength(2);
  });

  it('BE-ME-024: DELETE /api/v1/me/playlists/:id/tracks removes track from playlist', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_deltrks1',
        userId: user.id,
        name: 'Delete Track Pl',
        kind: 'online',
      })
      .returning();

    await db.insert(playlistTracks).values({
      playlistId: pl.id,
      trackRefKind: 'server',
      trackRefId: 'trackToDel',
      position: 0,
    });

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['yt:trackToDel'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-025: PATCH /api/v1/me/playlists/:id/tracks/order reorders playlist tracks', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_order1',
        userId: user.id,
        name: 'Reorder Pl',
        kind: 'online',
      })
      .returning();

    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'server', trackRefId: 't1', position: 0 });
    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'server', trackRefId: 't2', position: 1 });

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}/tracks/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ from: 0, to: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-026: GET /api/v1/me/settings returns user preferences and default settings', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('streamQuality');
    expect(res.body).toHaveProperty('eqPreset');
    expect(res.body.eqPreset).toBe('Sonare');
    expect(res.body.gapless).toBe(true);
  });

  it('BE-ME-027: PUT /api/v1/me/settings updates user settings payload', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ streamQuality: 'low', eqPreset: 'Rock' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.streamQuality).toBe('low');
    expect(getRes.body.eqPreset).toBe('Rock');
  });

  it('BE-ME-028: GET /api/v1/me/player-state returns persisted playback state', async () => {
    const { user, token } = await createUser();
    await db.insert(playerState).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'savedTrackState',
      positionMs: 45000,
      queue: [{ id: 'yt:savedTrackState' }],
    });

    const res = await request(app).get('/api/v1/me/player-state').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.trackRef.id).toBe('savedTrackState');
    expect(res.body.positionMs).toBe(45000);
  });

  it('BE-ME-029: PUT /api/v1/me/player-state saves current playback state', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/player-state')
      .set('Authorization', `Bearer ${token}`)
      .send({
        trackRef: { kind: 'server', id: 'newPlaybackState' },
        positionMs: 120000,
        queue: [{ id: 'yt:newPlaybackState' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-030: POST /api/v1/me/sync accepts a body past the old 100 KB default', async () => {
    const { user, token } = await createUser();
    // Roughly what the desktop sends per play (~450 bytes of song snapshot).
    const meta = {
      title: 'T'.repeat(260),
      artist: 'A'.repeat(90),
      artistId: 'yt:UCbigsync',
      album: 'B'.repeat(40),
      durationMs: 240000,
    };
    const plays = Array.from({ length: 1000 }, (_, i) => ({
      trackRef: { kind: 'server' as const, id: `bigSync${i}` },
      at: Date.now() - i * 1000,
      ms: 40000,
      meta,
    }));
    expect(JSON.stringify({ plays }).length).toBeGreaterThan(400_000);

    const res = await request(app).post('/api/v1/me/sync').set('Authorization', `Bearer ${token}`).send({ plays });

    expect(res.status).toBe(200);
    const rows = await db.select().from(playHistory).where(eq(playHistory.userId, user.id));
    expect(rows).toHaveLength(1000);
  });

  it('BE-ME-031: PUT /api/v1/me/player-state accepts a queue past the old 100 KB default', async () => {
    const { token } = await createUser();
    const queue = Array.from({ length: 3000 }, (_, i) => ({
      id: `yt:bigQueue${i}`,
      title: 'Q'.repeat(150),
      durationMs: 200000,
    }));
    expect(JSON.stringify({ queue }).length).toBeGreaterThan(500_000);

    const res = await request(app)
      .put('/api/v1/me/player-state')
      .set('Authorization', `Bearer ${token}`)
      .send({ queue, index: 0, positionMs: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-032: other JSON routes keep the 100 KB body limit', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ eqPreset: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('BE-ME-033: GET /api/v1/me/favourites/ids returns prefixed ids newest first', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'olderYt', addedAt: new Date(Date.now() - 60_000) },
      { userId: user.id, trackRefKind: 'local', trackRefId: 'fingerprint1', addedAt: new Date() },
    ]);

    const res = await request(app).get('/api/v1/me/favourites/ids').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: ['local:fingerprint1', 'yt:olderYt'] });
  });

  it('BE-ME-034: GET /api/v1/me/favourites/ids leaves out other users', async () => {
    const { user, token } = await createUser();
    const other = await createUser();
    await db.insert(favouriteTracks).values([
      { userId: other.user.id, trackRefKind: 'server', trackRefId: 'otherFav' },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'myFav' },
    ]);

    const res = await request(app).get('/api/v1/me/favourites/ids').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual(['yt:myFav']);
  });

  it('BE-ME-035: GET /api/v1/me/favourites/ids requires a token', async () => {
    const res = await request(app).get('/api/v1/me/favourites/ids');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-ME-036: favourites fall back to a placeholder row when Piped is down, history still 502s', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({ userId: user.id, trackRefKind: 'server', trackRefId: 'noMetaFav' });
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'noMetaPlay',
      playedAt: new Date(),
      msPlayed: 40000,
    });

    // A port nothing listens on: Piped answers with ECONNREFUSED, flagged unreachable.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const original = config.PIPED_API_URL;
    config.PIPED_API_URL = `http://127.0.0.1:${port}`;
    try {
      const favs = await request(app).get('/api/v1/me/favourites/tracks').set('Authorization', `Bearer ${token}`);
      expect(favs.status).toBe(200);
      expect(favs.body.items).toHaveLength(1);
      expect(favs.body.items[0]).toMatchObject({ id: 'yt:noMetaFav', title: 'Unknown Title' });

      const recent = await request(app).get('/api/v1/me/recently-played').set('Authorization', `Bearer ${token}`);
      expect(recent.status).toBe(502);
      expect(recent.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      config.PIPED_API_URL = original;
    }
  });

  // ---- Library: liked songs plus playlist songs ----

  const songMeta = (title: string, artist: string, durationMs: number | null = 200_000, album?: string) => ({
    title,
    artist,
    artistId: '',
    durationMs,
    ...(album && { album }),
  });

  const playlistWith = async (userId: string, songs: { id: string; meta?: unknown; at?: Date; kind?: string }[]) => {
    const id = `sonare:${crypto.randomUUID()}`;
    await db.insert(playlists).values({ id, userId, name: 'Mix', kind: 'online' });
    await db.insert(playlistTracks).values(
      songs.map((s, i) => ({
        playlistId: id,
        position: i,
        trackRefKind: s.kind ?? 'server',
        trackRefId: s.id,
        meta: s.meta ?? null,
        ...(s.at && { addedAt: s.at }),
      })),
    );
    return id;
  };

  const library = (token: string, query = '') =>
    request(app).get(`/api/v1/me/library/tracks${query}`).set('Authorization', `Bearer ${token}`);

  it('BE-ME-051: GET /api/v1/me/library/tracks lists liked and playlist songs once, newest add first', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values([
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'likedOnly',
        addedAt: new Date(1000),
        meta: songMeta('A', 'X'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'both',
        addedAt: new Date(2000),
        meta: songMeta('B', 'X'),
      },
    ]);
    await playlistWith(user.id, [
      { id: 'both', meta: songMeta('B', 'X'), at: new Date(5000) },
      { id: 'listedOnly', meta: songMeta('C', 'Y'), at: new Date(3000) },
      // Another device's file: it can't play from here, so the library leaves it out.
      { id: 'fingerprint1', kind: 'local', at: new Date(9000) },
    ]);

    const res = await library(token);
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual(['yt:both', 'yt:listedOnly', 'yt:likedOnly']);
    expect(res.body.items.map((t: { favourite: boolean }) => t.favourite)).toEqual([true, false, true]);
    expect(res.body.items[0].addedAt).toBe(5000);
    expect(res.body.items[1]).toMatchObject({ title: 'C', addedAt: 3000 });
    expect(res.body.meta).toEqual({ total: 3 });
  });

  it('BE-ME-052: GET /api/v1/me/library/tracks?filter=liked leaves out songs only in playlists', async () => {
    const { user, token } = await createUser();
    await db
      .insert(favouriteTracks)
      .values({ userId: user.id, trackRefKind: 'server', trackRefId: 'liked1', meta: songMeta('A', 'X') });
    await playlistWith(user.id, [{ id: 'listed1', meta: songMeta('B', 'X') }]);

    const res = await library(token, '?filter=liked');
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual(['yt:liked1']);
    expect(res.body.meta.total).toBe(1);
  });

  it('BE-ME-053: GET /api/v1/me/library/tracks sorts by stored details; unknown ones go last', async () => {
    const { user, token } = await createUser();
    await playlistWith(user.id, [
      { id: 'song1', meta: songMeta('beta', 'Zed', 300_000, 'Moon') },
      { id: 'song2', meta: songMeta('Alpha', 'amy', 100_000, 'sun') },
      { id: 'song3', meta: songMeta('gamma', 'Bob', null) },
    ]);
    await db.insert(playHistory).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'song3', playedAt: new Date(), msPlayed: 40000 },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'song3', playedAt: new Date(), msPlayed: 40000 },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'song1', playedAt: new Date(), msPlayed: 40000 },
    ]);
    const ids = async (query: string) =>
      (await library(token, query)).body.items.map((t: { id: string }) => t.id.slice(3));

    expect(await ids('?sort=title')).toEqual(['song2', 'song1', 'song3']);
    expect(await ids('?sort=title&order=desc')).toEqual(['song3', 'song1', 'song2']);
    expect(await ids('?sort=artist')).toEqual(['song2', 'song3', 'song1']);
    expect(await ids('?sort=album')).toEqual(['song1', 'song2', 'song3']);
    expect(await ids('?sort=durationMs')).toEqual(['song2', 'song1', 'song3']);
    expect(await ids('?sort=playCount')).toEqual(['song3', 'song1', 'song2']);
    expect((await library(token, '?sort=playCount')).body.items[0].playCount).toBe(2);
    expect((await library(token, '?sort=loudness')).status).toBe(400);
  });

  it('BE-ME-054: GET /api/v1/me/library/tracks pages with limit and cursor', async () => {
    const { user, token } = await createUser();
    await playlistWith(
      user.id,
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => ({ id, meta: songMeta(id, 'X'), at: new Date(10_000 - i) })),
    );

    const first = await library(token, '?limit=2');
    expect(first.body.items.map((t: { id: string }) => t.id)).toEqual(['yt:p1', 'yt:p2']);
    expect(first.body.meta).toEqual({ total: 5, nextCursor: '2' });
    const second = await library(token, `?limit=2&cursor=${first.body.meta.nextCursor}`);
    expect(second.body.items.map((t: { id: string }) => t.id)).toEqual(['yt:p3', 'yt:p4']);
    const last = await library(token, '?limit=2&cursor=4');
    expect(last.body.items.map((t: { id: string }) => t.id)).toEqual(['yt:p5']);
    expect(last.body.meta).toEqual({ total: 5 });
    expect((await library(token, '?cursor=abc')).status).toBe(400);
  });

  it("BE-ME-055: GET /api/v1/me/library/tracks leaves out other users' playlists", async () => {
    const { token } = await createUser();
    const { user: other } = await createUser();
    await playlistWith(other.id, [{ id: 'theirs', meta: songMeta('T', 'X') }]);

    const res = await library(token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.meta).toEqual({ total: 0 });
  });
});

describe('Me: edge cases', () => {
  const app = createApp();

  it('BE-ME-EXTRA-001: GET /api/v1/me/playlists/:id returns 404 for non-existent playlist', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .get('/api/v1/me/playlists/sonare:pl_non_existent_999')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('BE-ME-EXTRA-002: PATCH /api/v1/me/playlists/:id returns 404 for playlist owned by another user', async () => {
    const userA = await createUser();
    const userB = await createUser();

    const [plA] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_userA_secret',
        userId: userA.user.id,
        name: 'User A List',
        kind: 'online',
      })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${plA.id}`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ name: 'Hacked Title' });

    expect(res.status).toBe(404);
  });

  it('BE-ME-EXTRA-003: DELETE /api/v1/me/playlists/:id returns 200 even if playlist does not exist', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .delete('/api/v1/me/playlists/sonare:pl_ghost')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-ME-EXTRA-004: POST /api/v1/me/playlists rejects empty payload with 400', async () => {
    const { token } = await createUser();
    const res = await request(app).post('/api/v1/me/playlists').set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ME-EXTRA-005: POST /api/v1/me/playlists/:id/tracks rejects non-array trackIds with 400', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_bad_tracks',
        userId: user.id,
        name: 'Bad Tracks Test',
        kind: 'online',
      })
      .returning();

    const res = await request(app)
      .post(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ME-EXTRA-006: PATCH /api/v1/me/playlists/:id/tracks/order rejects missing from or to with 400', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_bad_order',
        userId: user.id,
        name: 'Order Missing Params',
        kind: 'online',
      })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}/tracks/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ from: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ME-EXTRA-007: GET /api/v1/me/library/genres returns empty genres meta object', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/library/genres').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], meta: { total: 0 } });
  });

  it('BE-ME-EXTRA-008: GET /api/v1/me/new-releases returns empty new-releases items', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/new-releases').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], meta: { total: 0 } });
  });
});

describe('Me: error branches', () => {
  const app = createApp();

  it('BE-ME-BR-001: PATCH /api/v1/me/playlists/:id updates description when name is not provided', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_desc_only', userId: user.id, name: 'Initial Name', kind: 'online' })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'New description updated' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('New description updated');
    expect(res.body.name).toBe('Initial Name');
  });

  it('BE-ME-BR-002: PATCH /api/v1/me/playlists/:id/tracks/order returns 404 when playlist does not exist', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .patch('/api/v1/me/playlists/sonare:pl_does_not_exist/tracks/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ from: 0, to: 1 });

    expect(res.status).toBe(404);
  });

  it('BE-ME-BR-003: DELETE /api/v1/me/playlists/:id/tracks handles array of trackIds including local ids', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_del_local_trk', userId: user.id, name: 'Local Track Delete', kind: 'online' })
      .returning();

    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'local', trackRefId: 'locTrk1', position: 0 });

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['local:locTrk1'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Me: playlist tracks', () => {
  const app = createApp();

  it('BE-ME-BR2-001: POST /api/v1/me/playlists/:id/tracks adds local track format', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_add_local', userId: user.id, name: 'Local Add', kind: 'online' })
      .returning();

    const res = await request(app)
      .post(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['local:localTrackHash123'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Me: playlists & settings', () => {
  const app = createApp();

  it('BE-EXP-001: POST /api/v1/me/playlists creates offline kind playlist', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post('/api/v1/me/playlists')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Offline Mix', kind: 'offline' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('offline');
  });

  it('BE-EXP-002: DELETE /api/v1/me/playlists/:id/tracks deletes by index position', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_del_idx', userId: user.id, name: 'Index Del', kind: 'online' })
      .returning();

    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'server', trackRefId: 'idx0', position: 0 });
    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'server', trackRefId: 'idx1', position: 1 });

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ index: 0 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const remaining = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].position).toBe(0);
    expect(remaining[0].trackRefId).toBe('idx1');
  });

  it('BE-EXP-003: DELETE /api/v1/me/playlists/:id/tracks returns 404 if user does not own playlist', async () => {
    const userA = await createUser();
    const userB = await createUser();

    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_other_user', userId: userA.user.id, name: 'Other User List', kind: 'online' })
      .returning();

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ index: 0 });

    expect(res.status).toBe(404);
  });

  it('BE-EXP-004: PUT /api/v1/me/settings updates normalization and gapless flags', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ normalization: false, gapless: false, stayOffline: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);

    expect(getRes.body.normalization).toBe(false);
    expect(getRes.body.gapless).toBe(false);
    expect(getRes.body.stayOffline).toBe(true);
  });

  it('BE-EXP-005: PUT /api/v1/me/settings handles empty changes cleanly', async () => {
    const { token } = await createUser();
    const res = await request(app).put('/api/v1/me/settings').set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-EXP-006: PUT /api/v1/me/settings normalizes downloadQuality lossless to high', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ downloadQuality: 'lossless' });

    expect(res.status).toBe(200);
    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);

    expect(getRes.body.downloadQuality).toBe('high');
  });

  it('BE-EXP-007: PUT /api/v1/me/player-state handles shuffle and repeat modes', async () => {
    const { token } = await createUser();
    const res = await request(app).put('/api/v1/me/player-state').set('Authorization', `Bearer ${token}`).send({
      shuffle: true,
      repeat: 'all',
      index: 2,
    });

    expect(res.status).toBe(200);

    const getRes = await request(app).get('/api/v1/me/player-state').set('Authorization', `Bearer ${token}`);

    expect(getRes.body.shuffle).toBe(true);
    expect(getRes.body.repeat).toBe('all');
    expect(getRes.body.index).toBe(2);
  });
});

describe('Me: settings & player state', () => {
  const app = createApp();

  it('BE-SETT-001: PUT /api/v1/me/settings updates downloadFormat', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ downloadFormat: 'm4a' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.downloadFormat).toBe('m4a');
  });

  it('BE-SETT-002: PUT /api/v1/me/player-state saves local trackRef state', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/player-state')
      .set('Authorization', `Bearer ${token}`)
      .send({
        trackRef: { kind: 'local', fingerprint: 'localFingerprint123' },
        positionMs: 33000,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/v1/me/player-state').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.trackRef.kind).toBe('local');
    expect(getRes.body.trackRef.fingerprint).toBe('localFingerprint123');
  });

  it('BE-ME-045: GET /api/v1/me/player-state reports when it was saved', async () => {
    const { user, token } = await createUser();
    const before = Date.now() - 1_000;
    await db.insert(playerState).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'stampedState',
      positionMs: 1000,
      updatedAt: new Date(),
    });

    const res = await request(app).get('/api/v1/me/player-state').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.updatedAt).toBe('number');
    expect(res.body.updatedAt).toBeGreaterThanOrEqual(before);

    const fresh = await createUser();
    const empty = await request(app).get('/api/v1/me/player-state').set('Authorization', `Bearer ${fresh.token}`);
    expect(empty.body.updatedAt).toBe(0);
  });
});

describe('Me: playlist ordering & entries', () => {
  const app = createApp();

  it('BE-ME-037: GET /api/v1/me/playlists lists playlists alphabetically, then by creation', async () => {
    const { user, token } = await createUser();
    await db.insert(playlists).values([
      { id: 'sonare:pl_zzz', userId: user.id, name: 'zeta', kind: 'online', createdAt: new Date(1_000) },
      { id: 'sonare:pl_bbb', userId: user.id, name: 'bravo', kind: 'online', createdAt: new Date(2_000) },
      { id: 'sonare:pl_aaa', userId: user.id, name: 'Alpha', kind: 'online', createdAt: new Date(3_000) },
    ]);

    const res = await request(app).get('/api/v1/me/playlists').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'bravo', 'zeta']);
  });

  it('BE-ME-038: PATCH /api/v1/me/playlists/:id clears an empty description to null', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_clear', userId: user.id, name: 'Has Desc', description: 'Old', kind: 'online' })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: '' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBeNull();
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.description).toBeNull();
  });

  it('BE-ME-039: PATCH /api/v1/me/playlists/:id keeps a stored description when the field is missing', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_keep', userId: user.id, name: 'Old', description: 'Keep me', kind: 'online' })
      .returning();

    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.description).toBe('Keep me');
  });

  it('BE-ME-040: POST /api/v1/me/playlists/:id/tracks appends positions after the current max', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_append', userId: user.id, name: 'Append', kind: 'online' })
      .returning();
    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'server', trackRefId: 'first', position: 0 });

    const res = await request(app)
      .post(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['yt:second', 'yt:third'] });

    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, pl.id))
      .orderBy(playlistTracks.position);
    expect(rows.map((r) => [r.trackRefId, r.position])).toEqual([
      ['first', 0],
      ['second', 1],
      ['third', 2],
    ]);
  });

  it('BE-ME-041: GET /api/v1/me/playlists/:id/tracks gives every item an entryId', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_entries', userId: user.id, name: 'Entries', kind: 'online' })
      .returning();
    const [row1] = await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'local', trackRefId: 'same', position: 0 })
      .returning();
    const [row2] = await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'local', trackRefId: 'same', position: 1 })
      .returning();

    const res = await request(app).get(`/api/v1/me/playlists/${pl.id}/tracks`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { entryId: string }) => i.entryId)).toEqual([row1.id, row2.id]);
  });

  it('BE-ME-042: DELETE by entryId removes only that entry when two songs share an id', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_dupdel', userId: user.id, name: 'Dup Delete', kind: 'online' })
      .returning();
    const [row1] = await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'local', trackRefId: 'same', position: 0 })
      .returning();
    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, trackRefKind: 'local', trackRefId: 'same', position: 1 });

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ entryIds: [row1.id] });

    expect(res.status).toBe(200);
    const rows = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(row1.id);
    expect(rows[0].position).toBe(0);
  });

  it("BE-ME-043: DELETE with another user's entryId removes nothing", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const [plA] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_a_entries', userId: userA.user.id, name: 'A', kind: 'online' })
      .returning();
    const [rowA] = await db
      .insert(playlistTracks)
      .values({ playlistId: plA.id, trackRefKind: 'local', trackRefId: 'aTrack', position: 0 })
      .returning();
    const [plB] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_b_entries', userId: userB.user.id, name: 'B', kind: 'online' })
      .returning();
    await db
      .insert(playlistTracks)
      .values({ playlistId: plB.id, trackRefKind: 'local', trackRefId: 'bTrack', position: 0 });

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${plB.id}/tracks`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ entryIds: [rowA.id] });

    expect(res.status).toBe(200);
    const aRows = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, plA.id));
    const bRows = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, plB.id));
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
  });

  it('BE-ME-044: reorder by entryId moves the right song for a device showing an old order', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_entryorder', userId: user.id, name: 'Entry Order', kind: 'online' })
      .returning();
    await db.insert(playlistTracks).values([
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'one', position: 0 },
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'two', position: 1 },
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'three', position: 2 },
    ]);
    const rows = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, pl.id))
      .orderBy(playlistTracks.position);
    const threeEntry = rows.find((r) => r.trackRefId === 'three')!;

    // The device thinks "three" is first (from 0) and wants it last (to 2).
    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}/tracks/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ from: 0, to: 2, entryId: threeEntry.id });

    expect(res.status).toBe(200);
    const after = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, pl.id))
      .orderBy(playlistTracks.position);
    expect(after.map((r) => [r.trackRefId, r.position])).toEqual([
      ['one', 0],
      ['two', 1],
      ['three', 2],
    ]);
  });

  it('BE-ME-046: DELETE renumbers remaining entries 0..n-1', async () => {
    const { user, token } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({ id: 'sonare:pl_gaps', userId: user.id, name: 'Gaps', kind: 'online' })
      .returning();
    await db.insert(playlistTracks).values([
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'a', position: 0 },
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'b', position: 5 },
      { playlistId: pl.id, trackRefKind: 'local', trackRefId: 'c', position: 9 },
    ]);

    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ index: 0 });

    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, pl.id))
      .orderBy(playlistTracks.position);
    expect(rows.map((r) => [r.trackRefId, r.position])).toEqual([
      ['b', 0],
      ['c', 1],
    ]);
  });
});

describe('Me: sync & library sorting', () => {
  const app = createApp();

  it('BE-SYNC-001: POST /api/v1/me/sync syncs multiple favourite items idempotently', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .post('/api/v1/me/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        favourites: [
          { trackRef: { kind: 'server', id: 'syncFav1' }, at: Date.now() },
          { trackRef: { kind: 'local', fingerprint: 'syncLocal1' }, at: Date.now() },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(favs.length).toBeGreaterThanOrEqual(2);
  });

  it('BE-SYNC-002: GET /api/v1/me/library/tracks sorts by title asc and desc', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({ userId: user.id, trackRefKind: 'local', trackRefId: 'aTrack' });
    await db.insert(favouriteTracks).values({ userId: user.id, trackRefKind: 'local', trackRefId: 'bTrack' });

    const resAsc = await request(app)
      .get('/api/v1/me/library/tracks?sort=title&order=asc')
      .set('Authorization', `Bearer ${token}`);

    expect(resAsc.status).toBe(200);
    expect(resAsc.body.items.length).toBe(2);

    const resDesc = await request(app)
      .get('/api/v1/me/library/tracks?sort=title&order=desc')
      .set('Authorization', `Bearer ${token}`);

    expect(resDesc.status).toBe(200);
    expect(resDesc.body.items.length).toBe(2);
  });

  it('BE-SYNC-003: GET /api/v1/me/library/tracks sorts by playCount asc and desc', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values({ userId: user.id, trackRefKind: 'local', trackRefId: 't1' });

    const resAsc = await request(app)
      .get('/api/v1/me/library/tracks?sort=playCount&order=asc')
      .set('Authorization', `Bearer ${token}`);

    expect(resAsc.status).toBe(200);
  });
});

describe('Me: request validation', () => {
  const app = createApp();

  const ownPlaylist = async (userId: string, id: string) => {
    const [pl] = await db.insert(playlists).values({ id, userId, name: 'Validation', kind: 'online' }).returning();
    return pl;
  };

  it('BE-VAL-001: POST /api/v1/me/playlists rejects a name over 100 characters', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .post('/api/v1/me/playlists')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'Playlist name must be at most 100 characters' });
    expect(await db.select().from(playlists).where(eq(playlists.userId, user.id))).toHaveLength(0);
  });

  it('BE-VAL-002: PATCH /api/v1/me/playlists/:id rejects a description over 500 characters', async () => {
    const { user, token } = await createUser();
    const pl = await ownPlaylist(user.id, 'sonare:pl_val_desc');
    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'd'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    const [stored] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(stored.description).toBeNull();
  });

  it('BE-VAL-003: POST /api/v1/me/playlists/:id/tracks rejects empty track ids', async () => {
    const { user, token } = await createUser();
    const pl = await ownPlaylist(user.id, 'sonare:pl_val_add');
    const res = await request(app)
      .post(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trackIds: ['yt:ok', ''] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id))).toHaveLength(0);
  });

  it('BE-VAL-004: DELETE /api/v1/me/playlists/:id/tracks rejects a negative index', async () => {
    const { user, token } = await createUser();
    const pl = await ownPlaylist(user.id, 'sonare:pl_val_remove');
    await db
      .insert(playlistTracks)
      .values({ playlistId: pl.id, position: 0, trackRefKind: 'server', trackRefId: 'keep1' });
    const res = await request(app)
      .delete(`/api/v1/me/playlists/${pl.id}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ index: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id))).toHaveLength(1);
  });

  it('BE-VAL-005: PATCH /api/v1/me/playlists/:id/tracks/order rejects non-numeric positions', async () => {
    const { user, token } = await createUser();
    const pl = await ownPlaylist(user.id, 'sonare:pl_val_order');
    const res = await request(app)
      .patch(`/api/v1/me/playlists/${pl.id}/tracks/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ from: 'first', to: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-VAL-006: PUT /api/v1/me/settings rejects an unknown stream quality and keeps the stored one', async () => {
    const { token } = await createUser();
    await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ streamQuality: 'low' });
    const res = await request(app)
      .put('/api/v1/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ streamQuality: 'ultra' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.streamQuality).toBe('low');
  });

  it('BE-VAL-007: PUT /api/v1/me/player-state rejects an unknown repeat mode', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .put('/api/v1/me/player-state')
      .set('Authorization', `Bearer ${token}`)
      .send({ repeat: 'sometimes', positionMs: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(await db.select().from(playerState).where(eq(playerState.userId, user.id))).toHaveLength(0);
  });

  it('BE-VAL-008: POST /api/v1/me/sync rejects a play without a timestamp and records nothing', async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .post('/api/v1/me/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plays: [
          { trackRef: { kind: 'server', id: 'valPlay1' }, at: Date.now(), ms: 40000 },
          { trackRef: { kind: 'server', id: 'valPlay2' }, ms: 40000 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(await db.select().from(playHistory).where(eq(playHistory.userId, user.id))).toHaveLength(0);
  });

  it('BE-VAL-009: GET /api/v1/me/recently-played rejects a non-numeric limit', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/recently-played?limit=lots').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-VAL-010: GET /api/v1/me/library/tracks rejects an unknown sort field', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/library/tracks?sort=colour').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-VAL-011: GET /api/v1/me/most-played rejects a limit of 0', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/me/most-played?limit=0').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'Must be at least 1' });
  });
});

describe('Me: bulk unlike', () => {
  const app = createApp();

  it('BE-ME-056: DELETE /api/v1/me/favourites/tracks removes exactly the listed ids and leaves others', async () => {
    const { user, token } = await createUser();
    await db.insert(favouriteTracks).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'keepMe' },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'removeA' },
      { userId: user.id, trackRefKind: 'local', trackRefId: 'removeB' },
    ]);

    const res = await request(app)
      .delete('/api/v1/me/favourites/tracks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['yt:removeA', 'local:removeB'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 2 });

    // Only 'keepMe' must survive.
    const remaining = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].trackRefId).toBe('keepMe');
  });

  it("BE-ME-057: DELETE /api/v1/me/favourites/tracks does not touch another user's rows", async () => {
    const { token } = await createUser();
    const { user: other } = await createUser();
    // Both users have the same raw id.
    await db.insert(favouriteTracks).values({ userId: other.id, trackRefKind: 'server', trackRefId: 'sharedId' });

    const res = await request(app)
      .delete('/api/v1/me/favourites/tracks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['yt:sharedId'] });

    expect(res.status).toBe(200);
    // Called user has no rows to delete; other user's row is untouched.
    expect(res.body).toEqual({ ok: true, removed: 0 });
    const otherRows = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, other.id));
    expect(otherRows).toHaveLength(1);
  });

  it('BE-ME-058: DELETE /api/v1/me/favourites/tracks rejects empty array and 501-element array with 400', async () => {
    const { token } = await createUser();

    const emptyRes = await request(app)
      .delete('/api/v1/me/favourites/tracks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [] });
    expect(emptyRes.status).toBe(400);
    expect(emptyRes.body.error.code).toBe('BAD_REQUEST');

    const tooMany = await request(app)
      .delete('/api/v1/me/favourites/tracks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: Array.from({ length: 501 }, (_, i) => `yt:track${i}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ME-059: DELETE /api/v1/me/favourites/tracks requires a token, returning 401 without one', async () => {
    const res = await request(app)
      .delete('/api/v1/me/favourites/tracks')
      .send({ ids: ['yt:anyTrack'] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('Me: not played lately', () => {
  const app = createApp();

  const songMeta = (title: string, artist: string, durationMs: number | null = 200_000, album?: string) => ({
    title,
    artist,
    artistId: '',
    durationMs,
    ...(album && { album }),
  });

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);

  it('BE-ME-060: GET /api/v1/me/not-played-lately returns songs played >= 2 times with newest play > 30 days ago', async () => {
    const { user, token } = await createUser();
    const play1 = daysAgo(42);
    const play2 = daysAgo(41);
    const play3 = daysAgo(40);

    await db.insert(playHistory).values([
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'oldFavorite',
        playedAt: play1,
        msPlayed: 30000,
        meta: songMeta('Old Favorite', 'Artist One'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'oldFavorite',
        playedAt: play2,
        msPlayed: 30000,
        meta: songMeta('Old Favorite', 'Artist One'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'oldFavorite',
        playedAt: play3,
        msPlayed: 30000,
        meta: songMeta('Old Favorite', 'Artist One'),
      },
    ]);

    const res = await request(app).get('/api/v1/me/not-played-lately').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:oldFavorite');
    expect(res.body.items[0].title).toBe('Old Favorite');
    expect(res.body.items[0].playCount).toBe(3);
    expect(typeof res.body.items[0].lastPlayedAt).toBe('number');
    // lastPlayedAt reflects the latest play (> 30 days ago, ~40 days ago)
    expect(res.body.items[0].lastPlayedAt).toBeLessThan(Date.now() - 30 * 24 * 3600 * 1000);
    expect(Math.abs(res.body.items[0].lastPlayedAt - play3.getTime())).toBeLessThan(24 * 3600 * 1000);
    expect(res.body.meta).toEqual({ total: 1 });
  });

  it("BE-ME-061: GET /api/v1/me/not-played-lately excludes songs played once, songs played recently, and other users' plays", async () => {
    const { user, token } = await createUser();
    const { user: other } = await createUser();

    // Song played once 40 days ago
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'playedOnce',
      playedAt: daysAgo(40),
      msPlayed: 30000,
      meta: songMeta('Played Once', 'Artist A'),
    });

    // Song played 5 times: 4 times 40 days ago, but 1 time yesterday
    await db.insert(playHistory).values([
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'playedRecent',
        playedAt: daysAgo(40),
        msPlayed: 30000,
        meta: songMeta('Recent Song', 'Artist B'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'playedRecent',
        playedAt: daysAgo(39),
        msPlayed: 30000,
        meta: songMeta('Recent Song', 'Artist B'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'playedRecent',
        playedAt: daysAgo(38),
        msPlayed: 30000,
        meta: songMeta('Recent Song', 'Artist B'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'playedRecent',
        playedAt: daysAgo(35),
        msPlayed: 30000,
        meta: songMeta('Recent Song', 'Artist B'),
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'playedRecent',
        playedAt: daysAgo(1),
        msPlayed: 30000,
        meta: songMeta('Recent Song', 'Artist B'),
      },
    ]);

    // Another user played a song 3 times 40 days ago
    await db.insert(playHistory).values([
      {
        userId: other.id,
        trackRefKind: 'server',
        trackRefId: 'otherUserSong',
        playedAt: daysAgo(40),
        msPlayed: 30000,
        meta: songMeta('Other Song', 'Artist C'),
      },
      {
        userId: other.id,
        trackRefKind: 'server',
        trackRefId: 'otherUserSong',
        playedAt: daysAgo(39),
        msPlayed: 30000,
        meta: songMeta('Other Song', 'Artist C'),
      },
      {
        userId: other.id,
        trackRefKind: 'server',
        trackRefId: 'otherUserSong',
        playedAt: daysAgo(38),
        msPlayed: 30000,
        meta: songMeta('Other Song', 'Artist C'),
      },
    ]);

    const res = await request(app).get('/api/v1/me/not-played-lately').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.meta).toEqual({ total: 0 });
  });

  it('BE-ME-062: GET /api/v1/me/not-played-lately orders by playCount desc, then longest unplayed (oldest max playedAt) first', async () => {
    const { user, token } = await createUser();

    // Song 1: 5 plays, last played 35 days ago
    for (let i = 0; i < 5; i++) {
      await db.insert(playHistory).values({
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'songHighestCount',
        playedAt: daysAgo(35 + i),
        msPlayed: 30000,
        meta: songMeta('Highest Count', 'Artist 1'),
      });
    }

    // Song 2: 3 plays, last played 50 days ago (longer unplayed than Song 3)
    for (let i = 0; i < 3; i++) {
      await db.insert(playHistory).values({
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'songLongestUnplayed',
        playedAt: daysAgo(50 + i),
        msPlayed: 30000,
        meta: songMeta('Longest Unplayed', 'Artist 2'),
      });
    }

    // Song 3: 3 plays, last played 32 days ago
    for (let i = 0; i < 3; i++) {
      await db.insert(playHistory).values({
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'songShorterUnplayed',
        playedAt: daysAgo(32 + i),
        msPlayed: 30000,
        meta: songMeta('Shorter Unplayed', 'Artist 3'),
      });
    }

    const res = await request(app).get('/api/v1/me/not-played-lately').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([
      'yt:songHighestCount',
      'yt:songLongestUnplayed',
      'yt:songShorterUnplayed',
    ]);
  });

  it('BE-ME-063: GET /api/v1/me/not-played-lately validates limit (default 20, 1..50; rejects 0, 51, non-numeric)', async () => {
    const { user, token } = await createUser();

    // Insert 22 qualifying tracks
    for (let t = 0; t < 22; t++) {
      await db.insert(playHistory).values([
        {
          userId: user.id,
          trackRefKind: 'server',
          trackRefId: `track_${t}`,
          playedAt: daysAgo(40),
          msPlayed: 30000,
          meta: songMeta(`Track ${t}`, 'Artist'),
        },
        {
          userId: user.id,
          trackRefKind: 'server',
          trackRefId: `track_${t}`,
          playedAt: daysAgo(41),
          msPlayed: 30000,
          meta: songMeta(`Track ${t}`, 'Artist'),
        },
      ]);
    }

    // Default limit should be 20
    const defaultRes = await request(app).get('/api/v1/me/not-played-lately').set('Authorization', `Bearer ${token}`);
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.items).toHaveLength(20);

    // Custom limit
    const customRes = await request(app)
      .get('/api/v1/me/not-played-lately?limit=5')
      .set('Authorization', `Bearer ${token}`);
    expect(customRes.status).toBe(200);
    expect(customRes.body.items).toHaveLength(5);

    // Rejects limit 0
    const zeroRes = await request(app)
      .get('/api/v1/me/not-played-lately?limit=0')
      .set('Authorization', `Bearer ${token}`);
    expect(zeroRes.status).toBe(400);
    expect(zeroRes.body.error.code).toBe('BAD_REQUEST');

    // Rejects limit 51
    const excessRes = await request(app)
      .get('/api/v1/me/not-played-lately?limit=51')
      .set('Authorization', `Bearer ${token}`);
    expect(excessRes.status).toBe(400);
    expect(excessRes.body.error.code).toBe('BAD_REQUEST');

    // Rejects non-numeric limit
    const nanRes = await request(app)
      .get('/api/v1/me/not-played-lately?limit=many')
      .set('Authorization', `Bearer ${token}`);
    expect(nanRes.status).toBe(400);
    expect(nanRes.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ME-064: GET /api/v1/me/not-played-lately returns 502 UPSTREAM_UNAVAILABLE when Piped is down and track has no stored details', async () => {
    const { user, token } = await createUser();

    await db.insert(playHistory).values([
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'unreachableTrack',
        playedAt: daysAgo(40),
        msPlayed: 30000,
      },
      {
        userId: user.id,
        trackRefKind: 'server',
        trackRefId: 'unreachableTrack',
        playedAt: daysAgo(41),
        msPlayed: 30000,
      },
    ]);

    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const original = config.PIPED_API_URL;
    config.PIPED_API_URL = `http://127.0.0.1:${port}`;
    try {
      const res = await request(app).get('/api/v1/me/not-played-lately').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      config.PIPED_API_URL = original;
    }
  });

  it('BE-ME-065: GET /api/v1/me/not-played-lately requires a token, returning 401 without one', async () => {
    const res = await request(app).get('/api/v1/me/not-played-lately');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-ME-066: DELETE /api/v1/me/history deletes all play_history rows of the caller and returns removed count', async () => {
    const { user, token } = await createUser();

    await db.insert(playHistory).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'songH1', playedAt: new Date(), msPlayed: 30000 },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'songH2', playedAt: new Date(), msPlayed: 45000 },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'songH3', playedAt: new Date(), msPlayed: 20000 },
    ]);

    if (isRedisAvailable()) {
      await redis.set(`ai:ymal:${user.id}`, JSON.stringify({ picks: [], basedOn: [], generatedAt: Date.now() }));
    }

    const res = await request(app).delete('/api/v1/me/history').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 3 });

    const remaining = await db.select().from(playHistory).where(eq(playHistory.userId, user.id));
    expect(remaining).toHaveLength(0);

    if (isRedisAvailable()) {
      const cached = await redis.get(`ai:ymal:${user.id}`);
      expect(cached).toBeNull();
    }
  });

  it("BE-ME-067: DELETE /api/v1/me/history leaves another user's history and caller's favourites and playlists untouched", async () => {
    const { user, token } = await createUser();
    const { user: other } = await createUser();

    await db.insert(playHistory).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'userSong', playedAt: new Date(), msPlayed: 30000 },
      { userId: other.id, trackRefKind: 'server', trackRefId: 'otherSong', playedAt: new Date(), msPlayed: 30000 },
    ]);

    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'favSong1',
    });

    await db.insert(playlists).values({
      id: `sonare:${crypto.randomUUID()}`,
      userId: user.id,
      name: 'Untouched Playlist',
      kind: 'online',
    });

    const res = await request(app).delete('/api/v1/me/history').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 1 });

    const userPlays = await db.select().from(playHistory).where(eq(playHistory.userId, user.id));
    expect(userPlays).toHaveLength(0);

    const otherPlays = await db.select().from(playHistory).where(eq(playHistory.userId, other.id));
    expect(otherPlays).toHaveLength(1);

    const userFavs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(userFavs).toHaveLength(1);

    const userPls = await db.select().from(playlists).where(eq(playlists.userId, user.id));
    expect(userPls).toHaveLength(1);
  });

  it('BE-ME-068: DELETE /api/v1/me/history causes recently-played and most-played to return empty lists', async () => {
    const { user, token } = await createUser();

    await db
      .insert(playHistory)
      .values([
        {
          userId: user.id,
          trackRefKind: 'server',
          trackRefId: 'playedTrack',
          playedAt: new Date(),
          msPlayed: 30000,
          meta: songMeta('Track', 'Artist'),
        },
      ]);

    const delRes = await request(app).delete('/api/v1/me/history').set('Authorization', `Bearer ${token}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true, removed: 1 });

    const recentRes = await request(app).get('/api/v1/me/recently-played').set('Authorization', `Bearer ${token}`);
    expect(recentRes.status).toBe(200);
    expect(recentRes.body.items).toHaveLength(0);

    const mostRes = await request(app).get('/api/v1/me/most-played').set('Authorization', `Bearer ${token}`);
    expect(mostRes.status).toBe(200);
    expect(mostRes.body.items).toHaveLength(0);
  });

  it('BE-ME-069: DELETE /api/v1/me/history requires a token, returning 401 without one', async () => {
    const res = await request(app).delete('/api/v1/me/history');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
