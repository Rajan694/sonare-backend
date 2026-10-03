import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalTestHost } from '../factories.js';
import net from 'node:net';
import request from 'supertest';
import { saveSetting } from '../../src/services/systemConfig.js';
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
    mockAgent.enableNetConnect(isLocalTestHost);
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

  it('BE-SEC-001: allows requests with localhost origin in development/test', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz').set('Origin', 'http://localhost:5183');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5183');
  });

  it('BE-SEC-002: rejects disallowed unanchored origin without 500 or CORS header', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz').set('Origin', 'http://localhost.evil.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('BE-SEC-003: allows requests with no Origin header', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, piped: 'up' });
  });

  it('BE-SEC-004: includes helmet security headers with cross-origin resource policy', async () => {
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const res = await request(app).get('/api/v1/healthz');

    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('BE-SEC-005: returns generic "Internal server error" for unexpected 500 exceptions', async () => {
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

  it('BE-SEC-006: a malformed JSON body gets 400, not 500', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'The request body is not valid JSON' } });
  });

  it('BE-SEC-007: /healthz answers within the Docker health check timeout when Piped hangs', async () => {
    // A server that accepts the connection and never answers, like an overloaded Piped.
    const sockets: net.Socket[] = [];
    const hanging = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const { port } = hanging.address() as net.AddressInfo;
    await saveSetting('piped.apiUrl', `http://127.0.0.1:${port}`, 'test');
    try {
      const started = Date.now();
      const res = await request(app).get('/api/v1/healthz');
      expect(Date.now() - started).toBeLessThan(4000);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, db: 'up', piped: 'down' });
    } finally {
      await saveSetting('piped.apiUrl', null, 'test');
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => hanging.close(resolve));
    }
  });
});
