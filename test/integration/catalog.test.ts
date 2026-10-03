import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  createUser,
  samplePipedChannel,
  samplePipedPlaylist,
  samplePipedSearchItem,
  samplePipedStream,
} from '../factories.js';
import { db } from '../../src/db/index.js';
import { artistFollows, favouriteTracks } from '../../src/db/schema.js';
import { signStreamToken } from '../../src/token.js';

describe('Catalog & public endpoints', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-CATALOG-001: GET /api/v1/healthz reports database, Redis and Piped up with the package version', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '1.0.0', db: 'up', redis: 'up', piped: 'up' });
  });

  it('BE-CATALOG-002: GET /api/v1/healthz reports piped down when healthcheck fails', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(500, { error: 'Internal error' });

    const res = await request(app).get('/api/v1/healthz');
    // Piped being down is reported but does not fail the check; only the database does.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: 'up', piped: 'down' });
  });

  it('BE-CATALOG-003: GET /api/v1/discover/made-for-you returns empty recommendation list for guest', async () => {
    const res = await request(app).get('/api/v1/discover/made-for-you');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], meta: { total: 0 } });
  });

  it('BE-CATALOG-004: GET /api/v1/search/suggestions returns suggestions array from piped', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/suggestions?query=queen', method: 'GET' })
      .reply(200, ['queen bohemian rhapsody', 'queen greatest hits', 'queen live']);

    const res = await request(app).get('/api/v1/search/suggestions?q=queen');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['queen bohemian rhapsody', 'queen greatest hits', 'queen live']);
  });

  it('BE-CATALOG-005: GET /api/v1/search/suggestions validates missing q query param with 400', async () => {
    const res = await request(app).get('/api/v1/search/suggestions');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-CATALOG-006: GET /api/v1/search handles songs query with filter mapping', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/search?q=bohemian&filter=music_songs', method: 'GET' }).reply(200, {
      items: [samplePipedSearchItem('bohemian123')],
      nextpage: 'cursor123',
    });

    const res = await request(app).get('/api/v1/search?q=bohemian&type=songs');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].kind).toBe('track');
    expect(res.body.items[0].id).toBe('yt:bohemian123');
    expect(res.body.meta.nextCursor).toBe(Buffer.from('cursor123').toString('base64url'));
  });

  it('BE-CATALOG-007: GET /api/v1/search handles albums query type', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/search?q=nightattheopera&filter=music_albums', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/playlist?list=OLAK5uy_opera',
          title: 'A Night at the Opera',
          uploaderName: 'Queen',
          uploaderUrl: '/channel/UCqueen',
          thumbnail: 'https://thumb.jpg',
          videos: 12,
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get('/api/v1/search?q=nightattheopera&type=albums');
    expect(res.status).toBe(200);
    expect(res.body.items[0].kind).toBe('album');
    expect(res.body.items[0].id).toBe('yt:OLAK5uy_opera');
  });

  it('BE-CATALOG-008: GET /api/v1/search handles artists query type', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/search?q=queen&filter=music_artists', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/channel/UCqueen123',
          name: 'Queen Official',
          thumbnail: 'https://queen.jpg',
          subscribers: 15000000,
          verified: true,
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get('/api/v1/search?q=queen&type=artists');
    expect(res.status).toBe(200);
    expect(res.body.items[0].kind).toBe('artist');
    expect(res.body.items[0].id).toBe('yt:UCqueen123');
  });

  it('BE-CATALOG-009: GET /api/v1/search handles playlists query type', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/search?q=rockhits&filter=music_playlists', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/playlist?list=PLrockhits1',
          title: 'Rock Hits Collection',
          uploaderName: 'Curator',
          uploaderUrl: '/channel/UCcurator',
          thumbnail: 'https://rock.jpg',
          videos: 50,
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get('/api/v1/search?q=rockhits&type=playlists');
    expect(res.status).toBe(200);
    expect(res.body.items[0].kind).toBe('album');
    expect(res.body.items[0].id).toBe('yt:PLrockhits1');
  });

  it('BE-CATALOG-010: GET /api/v1/search handles type=all aggregating multi-category search results', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/search?q=beatles&filter=music_songs', method: 'GET' })
      .reply(200, { items: [samplePipedSearchItem('beatles1')], nextpage: null });
    pipedMock.intercept({ path: '/search?q=beatles&filter=music_albums', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/playlist?list=OLAK5uy_abbey',
          title: 'Abbey Road',
          uploaderName: 'The Beatles',
          uploaderUrl: '/channel/UCbeatles',
          thumbnail: 'https://abbey.jpg',
          videos: 17,
        },
      ],
      nextpage: null,
    });
    pipedMock.intercept({ path: '/search?q=beatles&filter=music_artists', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/channel/UCbeatles',
          name: 'The Beatles',
          thumbnail: 'https://beatles.jpg',
          subscribers: 20000000,
          verified: true,
        },
      ],
      nextpage: null,
    });
    pipedMock
      .intercept({ path: '/search?q=beatles&filter=music_playlists', method: 'GET' })
      .reply(200, { items: [], nextpage: null });

    const res = await request(app).get('/api/v1/search?q=beatles&type=all');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3);
  });

  it('BE-CATALOG-011: GET /api/v1/search handles cursor pagination', async () => {
    const rawNext = 'nextpage_token_abc';
    const cursor = Buffer.from(rawNext).toString('base64url');

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({
        path: `/nextpage/search?nextpage=${encodeURIComponent(rawNext)}&q=queen&filter=music_songs`,
        method: 'GET',
      })
      .reply(200, {
        items: [samplePipedSearchItem('pagedTrack1')],
        nextpage: null,
      });

    const res = await request(app).get(`/api/v1/search?q=queen&type=songs&cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe('yt:pagedTrack1');
  });

  it('BE-CATALOG-012: GET /api/v1/search returns 400 when query q is missing', async () => {
    const res = await request(app).get('/api/v1/search');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-CATALOG-013: GET /api/v1/tracks/:id returns normalized track with user metadata', async () => {
    const { user, token } = await createUser();
    // Mark as favourite
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'server',
      trackRefId: 'dQw4w9WgXcQ',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/dQw4w9WgXcQ', method: 'GET' }).reply(200, samplePipedStream('dQw4w9WgXcQ'));

    const res = await request(app).get('/api/v1/tracks/yt:dQw4w9WgXcQ').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('yt:dQw4w9WgXcQ');
    expect(res.body.title).toBe('Never Gonna Give You Up');
    expect(res.body.favourite).toBe(true);
  });

  it('BE-CATALOG-014: GET /api/v1/tracks/:id handles unauthenticated guest access', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/guestTrack1', method: 'GET' }).reply(200, samplePipedStream('guestTrack1'));

    const res = await request(app).get('/api/v1/tracks/yt:guestTrack1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('yt:guestTrack1');
    expect(res.body.favourite).toBe(false);
  });

  it('BE-CATALOG-015: GET /api/v1/tracks/:id returns 502 for upstream errors', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/missing123', method: 'GET' }).reply(500, { message: 'Internal error' });

    const res = await request(app).get('/api/v1/tracks/yt:missing123');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('BE-CATALOG-016: GET /api/v1/tracks/:id/peaks returns audio peaks array', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/peakTrack1', method: 'GET' }).reply(200, samplePipedStream('peakTrack1'));

    const res = await request(app).get('/api/v1/tracks/yt:peakTrack1/peaks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('peaks');
    expect(Array.isArray(res.body.peaks)).toBe(true);
  });

  it('BE-CATALOG-017: GET /api/v1/albums/:id returns normalized album details', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PL1234567890', method: 'GET' })
      .reply(200, samplePipedPlaylist('PL1234567890'));

    const res = await request(app).get('/api/v1/albums/yt:PL1234567890');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('yt:PL1234567890');
    expect(res.body.title).toBe('Greatest Hits Album');
    expect(res.body.artist).toBe('Rick Astley');
  });

  it('BE-CATALOG-018: GET /api/v1/albums/:id/tracks returns track list of album', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PL1234567890', method: 'GET' })
      .reply(200, samplePipedPlaylist('PL1234567890'));

    const res = await request(app).get('/api/v1/albums/yt:PL1234567890/tracks');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:dQw4w9WgXcQ');
  });

  it('BE-CATALOG-019: GET /api/v1/artists/:id returns normalized artist metadata', async () => {
    const { user, token } = await createUser();
    // Follow artist
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    });

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw', method: 'GET' })
      .reply(200, samplePipedChannel('UCuAXFkgsw1L7xaCfnd5JJOw'));

    const res = await request(app)
      .get('/api/v1/artists/yt:UCuAXFkgsw1L7xaCfnd5JJOw')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('yt:UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(res.body.name).toBe('Rick Astley');
    expect(res.body.following).toBe(true);
  });

  it('BE-CATALOG-020: GET /api/v1/artists/:id/top-tracks returns channel top related tracks', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw', method: 'GET' })
      .reply(200, samplePipedChannel('UCuAXFkgsw1L7xaCfnd5JJOw'));

    const res = await request(app).get('/api/v1/artists/yt:UCuAXFkgsw1L7xaCfnd5JJOw/top-tracks');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:dQw4w9WgXcQ');
  });

  it('BE-CATALOG-021: GET /api/v1/artists/:id/albums returns albums from artist channel tab', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw', method: 'GET' })
      .reply(200, samplePipedChannel('UCuAXFkgsw1L7xaCfnd5JJOw'));
    pipedMock.intercept({ path: '/channels/tabs?data=tab_data_albums', method: 'GET' }).reply(200, {
      content: [
        {
          url: '/playlist?list=OLAK5uy_sample',
          title: 'Whenever You Need Somebody',
          thumbnail: 'https://piped.video/album_thumb.jpg',
          videos: 10,
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get('/api/v1/artists/yt:UCuAXFkgsw1L7xaCfnd5JJOw/albums');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:OLAK5uy_sample');
    expect(res.body.items[0].title).toBe('Whenever You Need Somebody');
  });

  it('BE-CATALOG-022: GET /api/v1/playlists/:id returns public playlist metadata', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PLpublicList1', method: 'GET' })
      .reply(200, samplePipedPlaylist('PLpublicList1'));

    const res = await request(app).get('/api/v1/playlists/yt:PLpublicList1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('yt:PLpublicList1');
    expect(res.body.name).toBe('Greatest Hits Album');
  });
});

describe('Catalog: edge cases & upstream errors', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-CAT-EDGE-001: GET /api/v1/artists/:id/albums handles cursor pagination through channelTabs', async () => {
    const rawCursor = 'tab_nextpage_abc';
    const cursor = Buffer.from(rawCursor).toString('base64url');

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: `/channels/tabs?data=${encodeURIComponent(rawCursor)}`, method: 'GET' }).reply(200, {
      content: [
        {
          url: '/playlist?list=OLAK5uy_pagedAlb',
          title: 'Paged Album',
          thumbnail: 'https://thumb.jpg',
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get(`/api/v1/artists/yt:UC123/albums?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:OLAK5uy_pagedAlb');
  });

  it('BE-CAT-EDGE-002: GET /api/v1/albums/:id/tracks handles cursor pagination', async () => {
    const rawCursor = 'playlist_next_token';
    const cursor = Buffer.from(rawCursor).toString('base64url');

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({
        path: `/nextpage/playlists/PLalbumPage?nextpage=${encodeURIComponent(rawCursor)}`,
        method: 'GET',
      })
      .reply(200, {
        relatedStreams: [
          {
            url: '/watch?v=pagedSong1',
            title: 'Paged Song',
            uploaderName: 'Artist',
            duration: 180,
          },
        ],
        nextpage: null,
      });

    const res = await request(app).get(`/api/v1/albums/yt:PLalbumPage/tracks?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:pagedSong1');
  });

  it('BE-CAT-EDGE-003: GET /api/v1/playlists/:id/tracks handles cursor pagination', async () => {
    const rawCursor = 'pl_next_token';
    const cursor = Buffer.from(rawCursor).toString('base64url');

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({
        path: `/nextpage/playlists/PLpublicPage?nextpage=${encodeURIComponent(rawCursor)}`,
        method: 'GET',
      })
      .reply(200, {
        relatedStreams: [
          {
            url: '/watch?v=plSong1',
            title: 'Playlist Song 1',
            uploaderName: 'Artist',
            duration: 200,
          },
        ],
        nextpage: null,
      });

    const res = await request(app).get(`/api/v1/playlists/yt:PLpublicPage/tracks?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:plSong1');
  });
});

describe('Catalog: trending, artwork & image proxy', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-APP-001: GET /api/v1/trending returns filtered music items', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/trending?region=IN', method: 'GET' }).reply(200, [
      {
        url: '/watch?v=trend1',
        title: 'Official Music Video Song',
        uploaderName: 'Artist - Topic',
        duration: 210,
        type: 'stream',
      },
      {
        url: '/watch?v=news1',
        title: 'Live News Today',
        uploaderName: 'News Channel',
        duration: 1000,
        type: 'stream',
      },
    ]);
    client
      .intercept({ path: '/search?q=trending%20music%20top%20songs&filter=music_songs', method: 'GET' })
      .reply(200, { items: [], nextpage: null });

    const res = await request(app).get('/api/v1/trending?region=IN&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:trend1');
  });

  it('BE-APP-002: GET /api/v1/tracks/:id/artwork redirects to thumbnail image', async () => {
    const res = await request(app).get('/api/v1/tracks/yt:artTrack1/artwork');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('mqdefault.jpg');
  });

  it('BE-APP-003: GET /api/v1/tracks/:id/artwork?size=640 redirects to maxres or hq thumbnail', async () => {
    const imgMock = mockAgent!.get('https://i.ytimg.com');
    imgMock.intercept({ path: '/vi/artTrack2/maxresdefault.jpg', method: 'HEAD' }).reply(200, '');

    const res = await request(app).get('/api/v1/tracks/yt:artTrack2/artwork?size=640');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('maxresdefault.jpg');
  });

  it('BE-APP-004: GET /api/v1/albums/:id/artwork redirects to proxy image route', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/playlists/PLalbumArt1', method: 'GET' })
      .reply(200, samplePipedPlaylist('PLalbumArt1'));

    const res = await request(app).get('/api/v1/albums/yt:PLalbumArt1/artwork?size=300');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/api\/v1\/image\//);
  });

  it('BE-APP-005: GET /api/v1/artists/:id/artwork redirects to signed channel avatar image', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/channel/UCartistArt1', method: 'GET' })
      .reply(200, samplePipedChannel('UCartistArt1'));

    const res = await request(app).get('/api/v1/artists/yt:UCartistArt1/artwork?size=140');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/api\/v1\/image\//);
  });

  it('BE-APP-006: GET /api/v1/image/:token proxies image buffer from upstream', async () => {
    const targetUrl = 'https://images.mock/artwork.jpg';
    const token = signStreamToken(targetUrl, 3600000);

    const imgMock = mockAgent!.get('https://images.mock');
    imgMock.intercept({ path: '/artwork.jpg', method: 'GET' }).reply(200, Buffer.from('JPEG_DATA'), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '9' },
    });

    const res = await request(app).get(`/api/v1/image/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('BE-APP-007: GET /api/v1/image/:token returns 502 if upstream fails', async () => {
    const targetUrl = 'https://images.mock/fail.jpg';
    const token = signStreamToken(targetUrl, 3600000);

    const imgMock = mockAgent!.get('https://images.mock');
    imgMock.intercept({ path: '/fail.jpg', method: 'GET' }).reply(500, '');

    const res = await request(app).get(`/api/v1/image/${token}`);
    expect(res.status).toBe(502);
  });

  it('BE-APP-010: Returns 404 for unmatched route path', async () => {
    const res = await request(app).get('/api/v1/nonexistent/path/here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Catalog: track formats & artist album fallback', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-RESIL-003: GET /api/v1/tracks/:id handles single audio format correctly', async () => {
    const singleStream = samplePipedStream('singleTrack');
    singleStream.audioStreams = [singleStream.audioStreams[0]];

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/singleTrack', method: 'GET' }).reply(200, singleStream);

    const res = await request(app).get('/api/v1/tracks/yt:singleTrack');
    expect(res.status).toBe(200);
    expect(res.body.codec).toBe('OPUS');
  });

  it('BE-RESIL-007: GET /api/v1/artists/:id/albums searches music_albums when albums tab is absent', async () => {
    const channelNoTabs = samplePipedChannel('UCartistNoTabs');
    channelNoTabs.tabs = [];

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/channel/UCartistNoTabs', method: 'GET' }).reply(200, channelNoTabs);

    pipedMock.intercept({ path: '/search?q=Rick%20Astley&filter=music_albums', method: 'GET' }).reply(200, {
      items: [
        {
          url: '/playlist?list=OLAK5uy_dyn1',
          name: 'Dynamic Album 1',
          uploaderName: 'Rick Astley',
          uploaderUrl: '/channel/UCartistNoTabs',
          thumbnail: 'https://thumb.jpg',
          videos: 8,
        },
      ],
      nextpage: null,
    });

    const res = await request(app).get('/api/v1/artists/yt:UCartistNoTabs/albums');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('yt:OLAK5uy_dyn1');
  });
});

describe('Catalog: image token errors', () => {
  const app = createApp();

  it('BE-ERR-BR-001: handles invalid tokens returning 403 FORBIDDEN', async () => {
    const res = await request(app).get('/api/v1/image/corrupted.invalid.token');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
