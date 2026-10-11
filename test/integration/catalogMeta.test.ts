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
  playlistTracks,
  playlists,
  catalogItems,
} from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import {
  parseTrackMeta,
  parseAlbumMeta,
  parseArtistMeta,
  rememberCatalogItem,
  getCatalogItems,
  type TrackMeta,
  type AlbumMeta,
  type ArtistMeta,
} from '../../src/services/catalogMeta.js';

describe('Catalog metadata (Phase B2)', () => {
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

  it('BE-META-001: PUT /favourites/tracks/:id accepts and stores TrackMeta in row meta', async () => {
    const { user, token } = await createUser();
    const trackId = 'testTrackMeta001';

    const meta: TrackMeta = {
      title: 'Test Track',
      artist: 'Test Artist',
      artistId: 'yt:UCartist123',
      album: 'Test Album',
      albumId: 'yt:PLalbum456',
      durationMs: 180000,
      thumbnail: '/api/v1/test-thumb.jpg',
    };

    const res = await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db
      .select()
      .from(favouriteTracks)
      .where(and(eq(favouriteTracks.userId, user.id), eq(favouriteTracks.trackRefId, trackId)));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toEqual(meta);
  });

  it('BE-META-002: PUT /favourites/tracks/:id ignores invalid meta (stores null)', async () => {
    const { user, token } = await createUser();
    const trackId = 'testTrackInvalidMeta';

    const res = await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { title: 123, artist: null } });

    expect(res.status).toBe(200);

    const row = await db
      .select()
      .from(favouriteTracks)
      .where(and(eq(favouriteTracks.userId, user.id), eq(favouriteTracks.trackRefId, trackId)));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toBeNull();
  });

  it('BE-META-003: PUT /favourites/albums/:id accepts and stores AlbumMeta', async () => {
    const { user, token } = await createUser();
    const albumId = 'PLtestAlbum003';

    const meta: AlbumMeta = {
      title: 'Test Album',
      artist: 'Test Artist',
      artistId: 'yt:UCartist456',
      year: 2024,
      trackCount: 12,
      thumbnail: '/api/v1/test-album-art.jpg',
    };

    const res = await request(app)
      .put(`/api/v1/me/favourites/albums/yt:${albumId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db
      .select()
      .from(favouriteAlbums)
      .where(and(eq(favouriteAlbums.userId, user.id), eq(favouriteAlbums.albumId, albumId)));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toEqual(meta);
  });

  it('BE-META-004: PUT /following/artists/:id accepts and stores ArtistMeta', async () => {
    const { user, token } = await createUser();
    const artistId = 'UCtestArtist004';

    const meta: ArtistMeta = {
      name: 'Test Artist',
      thumbnail: '/api/v1/test-artist-thumb.jpg',
      monthlyListeners: 150000,
    };

    const res = await request(app)
      .put(`/api/v1/me/following/artists/yt:${artistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db
      .select()
      .from(artistFollows)
      .where(and(eq(artistFollows.userId, user.id), eq(artistFollows.artistId, artistId)));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toEqual(meta);
  });

  it('BE-META-005: POST /playlists/:id/tracks accepts metas keyed by track ID', async () => {
    const { user, token } = await createUser();
    const playlistId = 'sonare:plMetaTest005';
    await db.insert(playlists).values({ id: playlistId, userId: user.id, name: 'Meta Test', kind: 'online' });

    const trackId = 'metaTrack005';
    const meta: TrackMeta = {
      title: 'Meta Track 5',
      artist: 'Meta Artist 5',
      artistId: 'yt:UCmetaArtist5',
      durationMs: 240000,
    };

    const res = await request(app)
      .post(`/api/v1/me/playlists/${playlistId}/tracks`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        trackIds: [`yt:${trackId}`],
        metas: { [`yt:${trackId}`]: meta },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, playlistId));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toEqual(meta);
  });

  it('BE-META-006: POST /sync accepts optional meta on favourite items', async () => {
    const { user, token } = await createUser();

    const res = await request(app)
      .post(`/api/v1/me/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        favourites: [
          {
            trackRef: { kind: 'server', id: 'syncMetaTrack006' },
            at: Date.now(),
            meta: {
              title: 'Sync Meta Track',
              artist: 'Sync Meta Artist',
              artistId: 'yt:UCsyncArtist006',
              durationMs: 195000,
            },
          },
        ],
      });

    expect(res.status).toBe(200);

    const row = await db
      .select()
      .from(favouriteTracks)
      .where(and(eq(favouriteTracks.userId, user.id), eq(favouriteTracks.trackRefId, 'syncMetaTrack006')));
    expect(row).toHaveLength(1);
    expect(row[0].meta).toEqual({
      title: 'Sync Meta Track',
      artist: 'Sync Meta Artist',
      artistId: 'yt:UCsyncArtist006',
      durationMs: 195000,
    });
  });

  it('BE-META-007: GET /library/tracks uses row meta first, then catalog_items, then Piped', async () => {
    const { user, token } = await createUser();
    const trackId = 'metaTrack007';

    // Insert row with meta
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      meta: {
        title: 'Row Meta Track',
        artist: 'Row Meta Artist',
        artistId: 'yt:UCrowMetaArtist',
        durationMs: 123000,
      },
    });

    // Piped is NOT called at all
    const res = await request(app).get('/api/v1/me/library/tracks').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(`yt:${trackId}`);
    expect(res.body.items[0].title).toBe('Row Meta Track');
    expect(res.body.items[0].artist).toBe('Row Meta Artist');
    expect(res.body.items[0].artistId).toBe('yt:UCrowMetaArtist');
    expect(res.body.items[0].durationMs).toBe(123000);
    expect(res.body.items[0].codec).toBeNull();
    expect(res.body.items[0].bitrateKbps).toBeNull();
  });

  it('BE-META-008: Hydration falls back to catalog_items when row meta is null and works when Piped is DOWN', async () => {
    const { user, token } = await createUser();
    const trackId = 'catalogTrack008';

    // Insert row with NULL meta
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      meta: null,
    });

    // Seed catalog_items with metadata
    await db.insert(catalogItems).values({
      kind: 'track',
      id: trackId,
      data: {
        id: `yt:${trackId}`,
        title: 'Catalog Track',
        artist: 'Catalog Artist',
        artistId: 'yt:UCcatalogArtist',
        album: null,
        albumId: null,
        durationMs: 234000,
        source: 'server',
        codec: null,
        bitrateKbps: null,
        thumbnail: `/api/v1/tracks/yt:${trackId}/artwork`,
      },
      updatedAt: new Date(),
    });

    // Piped mock responds with 500 / error if called
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: `/streams/${trackId}`, method: 'GET' }).reply(500, { error: 'down' });

    const res = await request(app).get('/api/v1/me/favourites/tracks').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Catalog Track');
    expect(res.body.items[0].artist).toBe('Catalog Artist');
    expect(res.body.items[0].artistId).toBe('yt:UCcatalogArtist');
  });

  it('BE-META-009: GET /tracks/:id remembers normalized Track without user fields to catalog_items', async () => {
    const trackId = 'rememberTrack009';

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: `/streams/${trackId}`, method: 'GET' }).reply(200, samplePipedStream(trackId));

    await request(app).get(`/api/v1/tracks/yt:${trackId}`);

    const row = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'track'), eq(catalogItems.id, trackId)));
    expect(row).toHaveLength(1);
    const data = row[0].data as Record<string, unknown>;
    expect(data.title).toBe(samplePipedStream(trackId).title);
    expect(data.playCount).toBeUndefined();
    expect(data.favourite).toBeUndefined();
  });

  it('BE-META-010: GET /albums/:id remembers Album to catalog_items', async () => {
    const albumId = 'rememberAlbum010';

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: `/playlists/${albumId}`, method: 'GET' }).reply(200, samplePipedPlaylist(albumId));

    await request(app).get(`/api/v1/albums/yt:${albumId}`);

    const row = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'album'), eq(catalogItems.id, albumId)));
    expect(row).toHaveLength(1);
    const data = row[0].data as Record<string, unknown>;
    expect(data.title).toBe(samplePipedPlaylist(albumId).name.replace(/^Album\s+[–-]\s+/, ''));
  });

  it('BE-META-011: GET /artists/:id remembers Artist to catalog_items', async () => {
    const artistId = 'rememberArtist011';

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: `/channel/${artistId}`, method: 'GET' }).reply(200, samplePipedChannel(artistId));

    await request(app).get(`/api/v1/artists/yt:${artistId}`);

    const row = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'artist'), eq(catalogItems.id, artistId)));
    expect(row).toHaveLength(1);
    const data = row[0].data as Record<string, unknown>;
    expect(data.name).toBe(
      samplePipedChannel(artistId)
        .name.replace(/\s*-\s*Topic$/i, '')
        .trim(),
    );
  });

  it('BE-META-012: GET /tracks/:id/lyrics accepts optional title, artist, durationMs and skips Piped', async () => {
    const trackId = 'lyricsMeta012';

    // LRCLIB mock: not found (404)
    const lrclibMock = mockAgent!.get('https://lrclib.net');
    lrclibMock.intercept({ path: () => true, method: 'GET' }).reply(404, { message: 'Not found' });

    const res = await request(app).get(
      `/api/v1/tracks/yt:${trackId}/lyrics?title=Test%20Lyrics&artist=Test%20Artist&durationMs=180000`,
    );

    // Should not query Piped for stream metadata
    expect(res.status).toBe(404);
  });

  it('BE-META-013: GET /tracks/:id/lyrics with script param uses title and artist without Piped', async () => {
    const trackId = 'lyricsMeta013';

    // Mock LRCLIB returning lyrics
    const lrclibMock = mockAgent!.get('https://lrclib.net');
    lrclibMock.intercept({ path: () => true, method: 'GET' }).reply(200, {
      id: 1,
      trackName: 'Test Song',
      artistName: 'Test Artist',
      plainLyrics: 'Some lyrics in latin',
      syncedLyrics: '[00:01.00] Some lyrics in latin',
      duration: 180,
    });

    const res = await request(app).get(
      `/api/v1/tracks/yt:${trackId}/lyrics?title=Test%20Song&artist=Test%20Artist&durationMs=180000&script=latin`,
    );

    expect(res.status).toBe(200);
    expect(res.body.plain).toBeDefined();
  });

  it('BE-META-014: GET /tracks/:id/lyrics returns 404 when lyrics not found', async () => {
    const trackId = 'lyricsMeta014';

    const lrclibMock = mockAgent!.get('https://lrclib.net');
    lrclibMock.intercept({ path: () => true, method: 'GET' }).reply(404, { message: 'Not found' });

    const res = await request(app).get(`/api/v1/tracks/yt:${trackId}/lyrics?title=Nonexistent&artist=NoArtist`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('BE-META-015: parseTrackMeta validates required fields', () => {
    // Valid
    expect(parseTrackMeta({ title: 'T', artist: 'A', artistId: 'yt:UC123', durationMs: 1000 })).not.toBeNull();
    // Valid with empty artistId
    expect(parseTrackMeta({ title: 'T', artist: 'A', artistId: '', durationMs: 1000 })).not.toBeNull();
    // Invalid: missing title
    expect(parseTrackMeta({ artist: 'A', artistId: 'yt:UC123', durationMs: 1000 })).toBeNull();
    // Invalid: missing artist
    expect(parseTrackMeta({ title: 'T', artistId: 'yt:UC123', durationMs: 1000 })).toBeNull();
    // Invalid: missing artistId
    expect(parseTrackMeta({ title: 'T', artist: 'A', durationMs: 1000 })).toBeNull();
    // Invalid: missing durationMs
    expect(parseTrackMeta({ title: 'T', artist: 'A', artistId: 'yt:UC123' })).toBeNull();
  });

  it('BE-META-016: parseTrackMeta drops invalid thumbnails without rejecting', () => {
    // Invalid thumbnail URL should be dropped, not reject entire object
    const meta = parseTrackMeta({
      title: 'T',
      artist: 'A',
      artistId: 'yt:UC123',
      durationMs: 1000,
      thumbnail: 'http://evil.com/img.jpg',
    });
    expect(meta).not.toBeNull();
    expect(meta?.thumbnail).toBeUndefined();

    // Valid YouTube thumbnail should be accepted
    const meta2 = parseTrackMeta({
      title: 'T',
      artist: 'A',
      artistId: 'yt:UC123',
      durationMs: 1000,
      thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
    });
    expect(meta2?.thumbnail).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  });

  it('BE-META-017: parseAlbumMeta validates required fields and accepts optional ones', () => {
    expect(parseAlbumMeta({ title: 'Album 1', artist: 'Artist 1', artistId: 'yt:UC1' })).not.toBeNull();
    expect(
      parseAlbumMeta({ title: 'Album 2', artist: 'Artist 2', artistId: '', year: 2022, trackCount: 10 }),
    ).not.toBeNull();
    // Invalid: missing title
    expect(parseAlbumMeta({ artist: 'Artist', artistId: 'yt:UC1' })).toBeNull();
    // Invalid: missing artist
    expect(parseAlbumMeta({ title: 'Album', artistId: 'yt:UC1' })).toBeNull();
  });

  it('BE-META-018: parseArtistMeta validates required name', () => {
    expect(parseArtistMeta({ name: 'Artist 1' })).not.toBeNull();
    expect(parseArtistMeta({ name: 'Artist 2', monthlyListeners: 5000 })).not.toBeNull();
    // Invalid: missing name
    expect(parseArtistMeta({})).toBeNull();
    expect(parseArtistMeta({ name: '' })).toBeNull();
  });

  it('BE-META-019 & BE-META-020: rememberCatalogItem and getCatalogItems support raw and yt: prefixed IDs', async () => {
    const trackId = 'lookupTrack019';
    await rememberCatalogItem('track', trackId, { title: 'Raw Stored Track' });

    // Lookup by raw ID
    const map1 = await getCatalogItems<{ title: string }>('track', [trackId]);
    expect(map1.get(trackId)?.title).toBe('Raw Stored Track');
    expect(map1.get(`yt:${trackId}`)?.title).toBe('Raw Stored Track');

    // Lookup by prefixed ID
    const map2 = await getCatalogItems<{ title: string }>('track', [`yt:${trackId}`]);
    expect(map2.get(trackId)?.title).toBe('Raw Stored Track');
    expect(map2.get(`yt:${trackId}`)?.title).toBe('Raw Stored Track');
  });

  it('BE-META-021: GET /me/recently-played hydrates using row metadata when Piped is DOWN', async () => {
    const { user, token } = await createUser();
    const trackId = 'recentTrack021';

    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      playedAt: new Date(),
      msPlayed: 60000,
      meta: {
        title: 'Recent Stored Track',
        artist: 'Recent Stored Artist',
        artistId: 'yt:UCrecentArtist',
        durationMs: 180000,
      },
    });

    const res = await request(app).get('/api/v1/me/recently-played').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Recent Stored Track');
    expect(res.body.items[0].artist).toBe('Recent Stored Artist');
  });

  it('BE-META-022: GET /me/most-played falls back to catalog_items when Piped is DOWN', async () => {
    const { user, token } = await createUser();
    const trackId = 'mostPlayed022';

    // Insert play history with no meta
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      playedAt: new Date(),
      msPlayed: 120000,
      meta: null,
    });

    // Seed catalog_items
    await db.insert(catalogItems).values({
      kind: 'track',
      id: trackId,
      data: {
        id: `yt:${trackId}`,
        title: 'Most Played Catalog Track',
        artist: 'Most Played Catalog Artist',
        artistId: 'yt:UCmostArtist',
        album: null,
        albumId: null,
        durationMs: 200000,
        source: 'server',
        codec: null,
        bitrateKbps: null,
        thumbnail: `/api/v1/tracks/yt:${trackId}/artwork`,
      },
      updatedAt: new Date(),
    });

    const res = await request(app).get('/api/v1/me/most-played').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Most Played Catalog Track');
  });

  it('BE-META-023: GET /me/playlists/:id/tracks hydrates using row metadata when Piped is DOWN', async () => {
    const { user, token } = await createUser();
    const playlistId = 'sonare:plMetaDown023';
    await db.insert(playlists).values({ id: playlistId, userId: user.id, name: 'Offline Playlist', kind: 'online' });

    const trackId = 'plOfflineTrack023';
    await db.insert(playlistTracks).values({
      playlistId,
      position: 0,
      trackRefKind: 'server',
      trackRefId: trackId,
      meta: {
        title: 'Playlist Offline Track',
        artist: 'Playlist Offline Artist',
        artistId: 'yt:UCplArtist',
        durationMs: 210000,
      },
    });

    const res = await request(app)
      .get(`/api/v1/me/playlists/${playlistId}/tracks`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Playlist Offline Track');
    expect(res.body.items[0].artist).toBe('Playlist Offline Artist');
  });

  it('BE-META-024: Thumbnail validation only accepts /api/v1/ and https:// for allowed domains', () => {
    expect(
      parseTrackMeta({ title: 'T', artist: 'A', artistId: 'yt:UC1', durationMs: 1000, thumbnail: '/api/v1/img.jpg' }),
    ).not.toBeNull();
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
      }),
    ).not.toBeNull();
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'https://lh3.googleusercontent.com/x.jpg',
      }),
    ).not.toBeNull();
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'https://img.ggpht.com/x.jpg',
      }),
    ).not.toBeNull();

    // Rejected hosts
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'http://example.com/x.jpg',
      })?.thumbnail,
    ).toBeUndefined();
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'ftp://example.com/x.jpg',
      })?.thumbnail,
    ).toBeUndefined();
    expect(
      parseTrackMeta({
        title: 'T',
        artist: 'A',
        artistId: 'yt:UC1',
        durationMs: 1000,
        thumbnail: 'https://evil.com/x.jpg',
      })?.thumbnail,
    ).toBeUndefined();
  });

  it('BE-META-025: PUT /favourites/tracks/:id is idempotent (no duplicates)', async () => {
    const { user, token } = await createUser();
    const trackId = 'idemTrack025';

    const res1 = await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { title: 'T1', artist: 'A1', artistId: 'yt:UC1', durationMs: 1000 } });

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { title: 'T2', artist: 'A2', artistId: 'yt:UC2', durationMs: 2000 } });

    expect(res2.status).toBe(200);

    const rows = await db
      .select()
      .from(favouriteTracks)
      .where(and(eq(favouriteTracks.userId, user.id), eq(favouriteTracks.trackRefId, trackId)));
    expect(rows).toHaveLength(1);
    expect((rows[0].meta as Record<string, unknown>)?.title).toBe('T2');
  });

  it('BE-META-026: PUT /favourites/albums/:id is idempotent', async () => {
    const { user, token } = await createUser();
    const albumId = 'idemAlbum026';

    await request(app)
      .put(`/api/v1/me/favourites/albums/yt:${albumId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { title: 'T1', artist: 'A1', artistId: 'yt:UC1', year: 2020 } });

    await request(app)
      .put(`/api/v1/me/favourites/albums/yt:${albumId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { title: 'T2', artist: 'A2', artistId: 'yt:UC2', year: 2024 } });

    const rows = await db
      .select()
      .from(favouriteAlbums)
      .where(and(eq(favouriteAlbums.userId, user.id), eq(favouriteAlbums.albumId, albumId)));
    expect(rows).toHaveLength(1);
    expect((rows[0].meta as Record<string, unknown>)?.title).toBe('T2');
  });

  it('BE-META-027: PUT /following/artists/:id is idempotent', async () => {
    const { user, token } = await createUser();
    const artistId = 'idemArtist027';

    await request(app)
      .put(`/api/v1/me/following/artists/yt:${artistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { name: 'A1', thumbnail: '/t1.jpg' } });

    await request(app)
      .put(`/api/v1/me/following/artists/yt:${artistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ meta: { name: 'A2', thumbnail: '/t2.jpg' } });

    const rows = await db
      .select()
      .from(artistFollows)
      .where(and(eq(artistFollows.userId, user.id), eq(artistFollows.artistId, artistId)));
    expect(rows).toHaveLength(1);
    expect((rows[0].meta as Record<string, unknown>)?.name).toBe('A2');
  });

  it('BE-META-028: SECURITY: client meta never reaches catalog_items', async () => {
    const { token } = await createUser();
    const trackId = 'secClientTrack999';
    const albumId = 'secClientAlbum999';
    const artistId = 'secClientArtist999';

    // 1. Client favourite track with meta
    await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        meta: {
          title: 'Malicious Renamed Title',
          artist: 'Malicious Artist',
          artistId: 'yt:UCmalicious',
          durationMs: 123456,
        },
      });

    // 2. Client favourite album with meta
    await request(app)
      .put(`/api/v1/me/favourites/albums/yt:${albumId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        meta: {
          title: 'Malicious Album',
          artist: 'Malicious Artist',
          artistId: 'yt:UCmalicious',
        },
      });

    // 3. Client follow artist with meta
    await request(app)
      .put(`/api/v1/me/following/artists/yt:${artistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        meta: {
          name: 'Malicious Follow Artist',
        },
      });

    // Assert catalog_items has NO entry for any of these
    const trackCat = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'track'), eq(catalogItems.id, trackId)));
    expect(trackCat).toHaveLength(0);

    const albumCat = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'album'), eq(catalogItems.id, albumId)));
    expect(albumCat).toHaveLength(0);

    const artistCat = await db
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, 'artist'), eq(catalogItems.id, artistId)));
    expect(artistCat).toHaveLength(0);
  });

  it('BE-META-029: ISOLATION: another user meta is never used for a different user', async () => {
    const { token: tokenA } = await createUser();
    const { token: tokenB } = await createUser();
    const trackId = 'sharedTrackIso999';

    // User A favourites track with custom meta
    await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        meta: {
          title: 'User A Custom Title',
          artist: 'User A Custom Artist',
          artistId: 'yt:UCuserA',
          durationMs: 300000,
        },
      });

    // User B favourites the same track WITHOUT meta
    await request(app)
      .put(`/api/v1/me/favourites/tracks/yt:${trackId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({});

    // When User B requests their library, Piped will be called since User B has no meta and catalog_items has no entry
    const pipedMock = mockAgent!.get('http://localhost:8090');
    const realSample = samplePipedStream(trackId);
    pipedMock.intercept({ path: `/streams/${trackId}`, method: 'GET' }).reply(200, realSample);

    const resB = await request(app).get('/api/v1/me/library/tracks').set('Authorization', `Bearer ${tokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.items).toHaveLength(1);
    // User B receives the Piped title, NEVER User A's custom title
    expect(resB.body.items[0].title).toBe(realSample.title);
    expect(resB.body.items[0].title).not.toBe('User A Custom Title');
  });

  it('BE-META-030: PIPED DOWN: GET /library/albums and GET /library/artists succeed with row meta when Piped is offline', async () => {
    const { user, token } = await createUser();
    const albumId = 'offlineAlbum888';
    const artistId = 'offlineArtist888';

    // Add favourite album with row meta
    await db.insert(favouriteAlbums).values({
      userId: user.id,
      albumId,
      addedAt: new Date(),
      meta: {
        title: 'Offline Album Title',
        artist: 'Offline Album Artist',
        artistId: 'yt:UCalbumArtist',
        year: 2023,
        trackCount: 8,
      },
    });

    // Add artist follow with row meta
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId,
      addedAt: new Date(),
      meta: {
        name: 'Offline Followed Artist',
        monthlyListeners: 100000,
      },
    });

    // Piped is offline / returns 500
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: () => true, method: 'GET' }).reply(500, { error: 'down' });

    // Request library albums
    const albumsRes = await request(app).get('/api/v1/me/library/albums').set('Authorization', `Bearer ${token}`);
    expect(albumsRes.status).toBe(200);
    expect(albumsRes.body.items).toHaveLength(1);
    expect(albumsRes.body.items[0].title).toBe('Offline Album Title');
    expect(albumsRes.body.items[0].artist).toBe('Offline Album Artist');
    expect(albumsRes.body.items[0].artistId).toBe('yt:UCalbumArtist');

    // Request library artists
    const artistsRes = await request(app).get('/api/v1/me/library/artists').set('Authorization', `Bearer ${token}`);
    expect(artistsRes.status).toBe(200);
    const followedArtist = artistsRes.body.items.find((a: Record<string, unknown>) => a.id === `yt:${artistId}`);
    expect(followedArtist).toBeDefined();
    expect(followedArtist.name).toBe('Offline Followed Artist');
    expect(followedArtist.following).toBe(true);
  });

  it('BE-META-031: Tracks built from meta have same shape as normalizeStreamToTrack', async () => {
    const { user, token } = await createUser();
    const trackId = 'shapeTestTrack777';

    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      meta: {
        title: 'Shape Title',
        artist: 'Shape Artist',
        artistId: 'yt:UCshapeArtist',
        durationMs: null, // unknown duration
      },
    });

    const res = await request(app).get('/api/v1/me/library/tracks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const track = res.body.items[0];

    expect(track.id).toBe(`yt:${trackId}`);
    expect(track.title).toBe('Shape Title');
    expect(track.artistId).toBe('yt:UCshapeArtist');
    expect(track.artist).toBe('Shape Artist');
    expect(track.albumId).toBeNull();
    expect(track.album).toBeNull();
    expect(track.durationMs).toBeNull(); // null when unknown, not 0
    expect(track.source).toBe('server');
    expect(track.codec).toBeNull();
    expect(track.bitrateKbps).toBeNull();
    expect(track.bitDepth).toBeUndefined();
    expect(track.thumbnail).toBe(`/api/v1/tracks/yt:${trackId}/artwork`);
  });

  it('BE-META-032: Empty artistId in meta stays empty string without prefix corruption', async () => {
    const { user, token } = await createUser();
    const trackId = 'emptyArtistTrack666';

    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: trackId,
      meta: {
        title: 'No Channel Song',
        artist: 'Unknown Channel',
        artistId: '', // Empty channel
        durationMs: 150000,
      },
    });

    const res = await request(app).get('/api/v1/me/library/tracks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].artistId).toBe(''); // Must stay empty string, not yt: or yt:unknown
  });
});
