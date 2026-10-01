import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { samplePipedStream } from '../factories.js';
import { signStreamToken } from '../../src/token.js';

describe('Stream relay & stream tokens', () => {
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

  it('BE-STREAM-001: GET /api/v1/tracks/:id/stream returns signed stream URL and stream metadata', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/streamTrack1', method: 'GET' }).reply(200, samplePipedStream('streamTrack1'));

    const res = await request(app).get('/api/v1/tracks/yt:streamTrack1/stream');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('mimeType');
    expect(res.body).toHaveProperty('bitrateKbps');
    expect(res.body).toHaveProperty('expiresAt');
    expect(res.body.url).toMatch(/^\/api\/v1\/stream\//);
  });

  it('BE-STREAM-002: GET /api/v1/tracks/:id/stream respects quality=low query parameter', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/streamLow', method: 'GET' }).reply(200, samplePipedStream('streamLow'));

    const res = await request(app).get('/api/v1/tracks/yt:streamLow/stream?quality=low');
    expect(res.status).toBe(200);
    expect(res.body.bitrateKbps).toBeLessThanOrEqual(160);
  });

  it('BE-STREAM-003: GET /api/v1/tracks/:id/stream respects format=mp4a query parameter', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/streamMp4a', method: 'GET' }).reply(200, samplePipedStream('streamMp4a'));

    const res = await request(app).get('/api/v1/tracks/yt:streamMp4a/stream?format=mp4a');
    expect(res.status).toBe(200);
    expect(res.body.mimeType).toContain('mp4');
  });

  it('BE-STREAM-004: GET /api/v1/tracks/:id/stream throws 503 if no audio streams are present', async () => {
    const emptyStream = samplePipedStream('noAudio');
    emptyStream.audioStreams = [];
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/noAudio', method: 'GET' }).reply(200, emptyStream);

    const res = await request(app).get('/api/v1/tracks/yt:noAudio/stream');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NO_AUDIO_STREAM');
  });

  it('BE-STREAM-005: GET /api/v1/stream/:token streams audio chunks from upstream', async () => {
    const targetUrl = 'https://googlevideo.mock/audio/stream1.opus';
    const streamToken = signStreamToken(targetUrl, 3600000);

    const audioMock = mockAgent!.get('https://googlevideo.mock');
    audioMock
      .intercept({ path: '/audio/stream1.opus', method: 'GET' })
      .reply(200, Buffer.from('RIFF....mockaudiobytes'), {
        headers: {
          'content-type': 'audio/webm',
          'content-length': '22',
        },
      });

    const res = await request(app).get(`/api/v1/stream/${streamToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio');
  });

  it('BE-STREAM-006: GET /api/v1/stream/:token forwards HTTP Range header to upstream for audio seeking', async () => {
    const targetUrl = 'https://googlevideo.mock/audio/range.opus';
    const streamToken = signStreamToken(targetUrl, 3600000);

    const audioMock = mockAgent!.get('https://googlevideo.mock');
    audioMock
      .intercept({
        path: '/audio/range.opus',
        method: 'GET',
        headers: { range: 'bytes=100-200' },
      })
      .reply(206, Buffer.alloc(101), {
        headers: {
          'content-type': 'audio/webm',
          'content-range': 'bytes 100-200/1000',
          'content-length': '101',
        },
      });

    const res = await request(app).get(`/api/v1/stream/${streamToken}`).set('Range', 'bytes=100-200');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-200/1000');
  });

  it('BE-STREAM-007: GET /api/v1/stream/:token rejects invalid or forged stream token with 500 or error handler', async () => {
    const res = await request(app).get('/api/v1/stream/invalid_or_corrupt_stream_token');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Stream relay: mid-stream failover', () => {
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

  it('BE-STREAM-MID-001: stream relay handles 403 by refreshing stream from piped and swapping url', async () => {
    const originalDeadUrl = 'https://googlevideo.mock/audio/dead.opus';
    const streamToken = signStreamToken(originalDeadUrl, 3600000, { vid: 'failVid1', itag: 251 });

    const deadMock = mockAgent!.get('https://googlevideo.mock');
    deadMock.intercept({ path: '/audio/dead.opus', method: 'GET' }).reply(403, '');

    const pipedMock = mockAgent!.get('http://localhost:8090');
    const refreshed = samplePipedStream('failVid1');
    refreshed.audioStreams[0].url = 'https://googlevideo-fresh.mock/audio/fresh.opus';
    refreshed.audioStreams[0].itag = 251;
    pipedMock.intercept({ path: '/streams/failVid1', method: 'GET' }).reply(200, refreshed);

    const freshMock = mockAgent!.get('https://googlevideo-fresh.mock');
    freshMock.intercept({ path: '/audio/fresh.opus', method: 'GET' }).reply(200, Buffer.alloc(100), {
      headers: { 'content-type': 'audio/webm', 'content-length': '100' },
    });

    const res = await request(app).get(`/api/v1/stream/${streamToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/webm');
  });

  it('BE-STREAM-MID-002: stream relay handles upstream 500 cleanly with 502 UPSTREAM_ERROR', async () => {
    const url = 'https://googlevideo.mock/audio/error500.opus';
    const streamToken = signStreamToken(url, 3600000);

    const deadMock = mockAgent!.get('https://googlevideo.mock');
    deadMock.intercept({ path: '/audio/error500.opus', method: 'GET' }).reply(500, '');

    const res = await request(app).get(`/api/v1/stream/${streamToken}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('Stream: ranges & quality selection', () => {
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

  it('BE-RESIL-002: GET /api/v1/stream/:token with valid range request returns audio slice', async () => {
    const targetUrl = 'https://googlevideo.mock/audio/slice.opus';
    const streamToken = signStreamToken(targetUrl, 3600000);

    const audioMock = mockAgent!.get('https://googlevideo.mock');
    audioMock
      .intercept({
        path: '/audio/slice.opus',
        method: 'GET',
        headers: { range: 'bytes=0-1023' },
      })
      .reply(206, Buffer.alloc(1024), {
        headers: {
          'content-type': 'audio/webm',
          'content-range': 'bytes 0-1023/10000',
          'content-length': '1024',
        },
      });

    const res = await request(app).get(`/api/v1/stream/${streamToken}`).set('Range', 'bytes=0-1023');

    expect(res.status).toBe(206);
    expect(res.headers['content-length']).toBe('1024');
  });

  it('BE-RESIL-004: GET /api/v1/tracks/:id/stream handles quality=high request correctly', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/highQual', method: 'GET' }).reply(200, samplePipedStream('highQual'));

    const res = await request(app).get('/api/v1/tracks/yt:highQual/stream?quality=high');
    expect(res.status).toBe(200);
    expect(res.body.bitrateKbps).toBeGreaterThan(0);
  });

  it('BE-RESIL-005: GET /api/v1/tracks/:id/stream handles quality=normal request correctly', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/normalQual', method: 'GET' }).reply(200, samplePipedStream('normalQual'));

    const res = await request(app).get('/api/v1/tracks/yt:normalQual/stream?quality=normal');
    expect(res.status).toBe(200);
    expect(res.body.bitrateKbps).toBeGreaterThan(0);
  });

  it('BE-RESIL-006: GET /api/v1/tracks/:id/stream handles muxed video stream fallback when no separate audio streams exist', async () => {
    const videoOnly = samplePipedStream('muxedVid');
    videoOnly.audioStreams = [];
    videoOnly.videoStreams = [
      {
        url: 'https://video.google.mock/muxed.mp4',
        format: 'mp4',
        quality: '720p',
        mimeType: 'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
        codec: 'mp4a.40.2',
        videoOnly: false,
        itag: 18,
        bitrate: 500000,
        contentLength: 10000000,
      },
    ];

    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/muxedVid', method: 'GET' }).reply(200, videoOnly);

    const res = await request(app).get('/api/v1/tracks/yt:muxedVid/stream');
    expect(res.status).toBe(200);
    expect(res.body.muxed).toBe(true);
  });
});

describe('Stream: unsatisfiable ranges', () => {
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

  it('BE-APP-011: GET /api/v1/stream/:token handles 416 range requests correctly', async () => {
    const targetUrl = 'https://googlevideo.mock/audio/past_end.opus';
    const token = signStreamToken(targetUrl, 3600000);

    const audioMock = mockAgent!.get('https://googlevideo.mock');
    audioMock
      .intercept({
        path: '/audio/past_end.opus',
        method: 'GET',
        headers: { range: 'bytes=5000-' },
      })
      .reply(416, '');

    audioMock
      .intercept({
        path: '/audio/past_end.opus',
        method: 'GET',
        headers: { range: 'bytes=0-1' },
      })
      .reply(206, Buffer.alloc(2), {
        headers: {
          'content-range': 'bytes 0-1/5000',
        },
      });

    const res = await request(app).get(`/api/v1/stream/${token}`).set('Range', 'bytes=5000-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */5000');
  });
});
