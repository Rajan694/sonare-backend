import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createUser, samplePipedStream, isLocalTestHost } from '../factories.js';

describe('Lyrics endpoints & overrides', () => {
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

  it('BE-LYRICS-001: GET /api/v1/tracks/:id/lyrics fetches synced lyrics from LRCLIB', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/lyricsTrack1', method: 'GET' }).reply(200, samplePipedStream('lyricsTrack1'));

    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/get?track_name=Never%20Gonna%20Give%20You%20Up&artist_name=Rick%20Astley&album_name=&duration=213',
        method: 'GET',
      })
      .reply(200, {
        id: 12345,
        trackName: 'Never Gonna Give You Up',
        artistName: 'Rick Astley',
        syncedLyrics: '[00:18.50]Never gonna give you up\n[00:22.00]Never gonna let you down',
        plainLyrics: 'Never gonna give you up\nNever gonna let you down',
      });

    const res = await request(app).get('/api/v1/tracks/yt:lyricsTrack1/lyrics');
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('lrclib');
    expect(res.body.synced).toBe(true);
    expect(res.body.lines.length).toBe(2);
    expect(res.body.lines[0].text).toBe('Never gonna give you up');
  });

  it('BE-LYRICS-002: GET /api/v1/tracks/:id/lyrics returns plain lyrics if synced lyrics are not available', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/plainLyrics1', method: 'GET' }).reply(200, samplePipedStream('plainLyrics1'));

    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/get?track_name=Never%20Gonna%20Give%20You%20Up&artist_name=Rick%20Astley&album_name=&duration=213',
        method: 'GET',
      })
      .reply(200, {
        id: 12346,
        trackName: 'Never Gonna Give You Up',
        artistName: 'Rick Astley',
        syncedLyrics: null,
        plainLyrics: 'Line 1\nLine 2',
      });

    const res = await request(app).get('/api/v1/tracks/yt:plainLyrics1/lyrics');
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(false);
    expect(res.body.plain).toBe('Line 1\nLine 2');
  });

  it('BE-LYRICS-003: GET /api/v1/tracks/:id/lyrics returns 404 when no lyrics can be found anywhere', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock
      .intercept({ path: '/streams/notFoundLyrics1', method: 'GET' })
      .reply(200, samplePipedStream('notFoundLyrics1'));

    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/get?track_name=Never%20Gonna%20Give%20You%20Up&artist_name=Rick%20Astley&album_name=&duration=213',
        method: 'GET',
      })
      .reply(404, { message: 'Not found' });
    lrcMock
      .intercept({
        path: '/api/search?track_name=Never%20Gonna%20Give%20You%20Up&artist_name=Rick%20Astley&album_name=',
        method: 'GET',
      })
      .reply(200, []);

    const res = await request(app).get('/api/v1/tracks/yt:notFoundLyrics1/lyrics');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('BE-LYRICS-004: POST /api/v1/tracks/:id/lyrics stores custom override text for authenticated user', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post('/api/v1/tracks/yt:overrideTrack1/lyrics')
      .set('Authorization', `Bearer ${token}`)
      .send({
        lrc: '[00:10.50] Custom override line 1\n[00:15.00] Custom override line 2',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Fetching the lyrics should now return the override
    const fetchRes = await request(app)
      .get('/api/v1/tracks/yt:overrideTrack1/lyrics')
      .set('Authorization', `Bearer ${token}`);

    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.provider).toBe('user');
    expect(fetchRes.body.lines).toHaveLength(2);
    expect(fetchRes.body.lines[0].text).toBe('Custom override line 1');
  });

  it('BE-LYRICS-005: PATCH /api/v1/tracks/:id/lyrics/offset updates user timing offset', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .patch('/api/v1/tracks/yt:offsetTrack1/lyrics/offset')
      .set('Authorization', `Bearer ${token}`)
      .send({ offsetMs: 500 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-LYRICS-006: DELETE /api/v1/tracks/:id/lyrics removes custom override for user', async () => {
    const { token } = await createUser();
    await request(app).post('/api/v1/tracks/yt:delOverrideTrack1/lyrics').set('Authorization', `Bearer ${token}`).send({
      plain: 'Some temporary text',
    });

    const delRes = await request(app)
      .delete('/api/v1/tracks/yt:delOverrideTrack1/lyrics')
      .set('Authorization', `Bearer ${token}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });
});

describe('Lyrics search', () => {
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

  it('BE-APP-008: GET /api/v1/lyrics/search searches LRCLIB database', async () => {
    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/search?track_name=Bohemian&artist_name=Queen&album_name=Opera',
        method: 'GET',
      })
      .reply(200, [
        {
          id: 55,
          trackName: 'Bohemian Rhapsody',
          artistName: 'Queen',
        },
      ]);

    const res = await request(app).get('/api/v1/lyrics/search?track=Bohemian&artist=Queen&album=Opera');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].trackName).toBe('Bohemian Rhapsody');
  });

  it('BE-APP-009: GET /api/v1/lyrics/search validates missing track param with 400', async () => {
    const res = await request(app).get('/api/v1/lyrics/search');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('Lyrics: request validation', () => {
  const app = createApp();

  it('BE-VAL-012: POST /api/v1/tracks/:id/lyrics rejects a body with neither lrc nor plain', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post('/api/v1/tracks/yt:valLyrics1/lyrics')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'Send lrc or plain lyrics' });
  });

  it('BE-VAL-013: PATCH /api/v1/tracks/:id/lyrics/offset rejects a non-numeric offset', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .patch('/api/v1/tracks/yt:valLyrics2/lyrics/offset')
      .set('Authorization', `Bearer ${token}`)
      .send({ offsetMs: 'late' });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'offsetMs must be a number' });
  });

  it('BE-VAL-014: GET /api/v1/tracks/:id/lyrics rejects an unknown prefer value', async () => {
    const res = await request(app).get('/api/v1/tracks/yt:valLyrics3/lyrics?prefer=karaoke');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
