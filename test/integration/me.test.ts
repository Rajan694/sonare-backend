import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
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
} from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

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
      .send({ normalization: false, gapless: true, stayOffline: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/v1/me/settings').set('Authorization', `Bearer ${token}`);

    expect(getRes.body.normalization).toBe(false);
    expect(getRes.body.gapless).toBe(true);
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

  async function ownPlaylist(userId: string, id: string) {
    const [pl] = await db.insert(playlists).values({ id, userId, name: 'Validation', kind: 'online' }).returning();
    return pl;
  }

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
