import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { LyricsResolver } from '../../src/services/lyrics.js';
import { PermanentCache } from '../../src/services/cache.js';

describe('CORS and Security Headers', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('allows requests with localhost origin in development/test', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz').set('Origin', 'http://localhost:5183');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5183');
  });

  it('rejects disallowed unanchored origin without 500 or CORS header', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz').set('Origin', 'http://localhost.evil.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no Origin header', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, piped: 'up' });
  });

  it('includes helmet security headers with cross-origin resource policy', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz');

    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns generic "Internal server error" for unexpected 500 exceptions', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/streams/crashTrack', method: 'GET' }).reply(200, {
      title: 'Crash Song',
      uploader: 'Crash Artist - Topic',
      duration: 200,
      audioStreams: [],
      videoStreams: [],
    });

    vi.spyOn(PermanentCache, 'getLyrics').mockResolvedValue(null);
    vi.spyOn(LyricsResolver, 'resolve').mockRejectedValueOnce(new Error('Secret DB connection string leaked'));

    const crashRes = await request(app).get('/api/v1/tracks/yt:crashTrack/lyrics');
    expect(crashRes.status).toBe(500);
    expect(crashRes.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    expect(crashRes.body.error.message).not.toContain('Secret DB connection string leaked');
  });
});
