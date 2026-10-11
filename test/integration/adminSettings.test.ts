import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminUser } from '../factories.js';
import { db } from '../../src/db/index.js';
import { appSettings } from '../../src/db/schema.js';
import { config } from '../../src/config.js';
import { pipedApiUrl, setPipedApiUrl } from '../../src/services/settings.js';

describe('Admin: settings', () => {
  const app = createApp();

  beforeAll(async () => {
    await db.delete(appSettings);
  });

  afterAll(async () => {
    await db.delete(appSettings);
  });

  it('BE-ADM-SET-001: GET /admin/settings returns 401 without admin token', async () => {
    const res = await request(app).get('/api/v1/admin/settings');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-ADM-SET-002: GET /admin/settings default (saved null, effective = env default)', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/settings').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pipedApiUrl).toEqual({
      saved: null,
      effective: config.PIPED_API_URL,
      envDefault: config.PIPED_API_URL,
    });
  });

  it('BE-ADM-SET-003: PUT /admin/settings saves pipedApiUrl and GET reflects it', async () => {
    const { token } = await createAdminUser();
    const newUrl = 'https://pipedapi.example.com';

    const putRes = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: newUrl });

    expect(putRes.status).toBe(200);
    expect(putRes.body.pipedApiUrl).toEqual({
      saved: newUrl,
      effective: newUrl,
      envDefault: config.PIPED_API_URL,
    });

    // Verify GET returns the saved value
    const getRes = await request(app).get('/api/v1/admin/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.pipedApiUrl.saved).toBe(newUrl);
    expect(getRes.body.pipedApiUrl.effective).toBe(newUrl);
  });

  it('BE-ADM-SET-004: pipedApiUrl() returns the saved value', async () => {
    const savedUrl = 'https://custom.piped.example.com';
    await setPipedApiUrl(savedUrl);

    expect(pipedApiUrl()).toBe(savedUrl);

    await setPipedApiUrl(null);
    expect(pipedApiUrl()).toBe(config.PIPED_API_URL);
  });

  it('BE-ADM-SET-005: PUT /admin/settings with null resets to env default', async () => {
    const { token } = await createAdminUser();

    // First set a custom URL
    await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: 'https://custom.piped.example.com' });

    // Then reset to null
    const putRes = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: null });

    expect(putRes.status).toBe(200);
    expect(putRes.body.pipedApiUrl.saved).toBeNull();
    expect(putRes.body.pipedApiUrl.effective).toBe(config.PIPED_API_URL);
  });

  it('BE-ADM-SET-006: PUT /admin/settings rejects invalid URL ftp:// with 400', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: 'ftp://invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADM-SET-007: PUT /admin/settings rejects invalid URL "not a url" with 400', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: 'not a url' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADM-SET-008: POST /admin/settings/piped-test against a local http server that answers /healthcheck 200', async () => {
    const { token } = await createAdminUser();

    // Create a simple HTTP server to test against
    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/healthcheck' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 'test' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    const testUrl = `http://127.0.0.1:${address.port}`;

    try {
      const res = await request(app)
        .post('/api/v1/admin/settings/piped-test')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: testUrl });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.ms).toBe('number');
      expect(res.body.ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  it('BE-ADM-SET-009: POST /admin/settings/piped-test against a closed port returns ok=false', async () => {
    const { token } = await createAdminUser();

    // Use a port that's likely closed (but don't bind to it)
    const testUrl = 'http://127.0.0.1:55999';

    const res = await request(app)
      .post('/api/v1/admin/settings/piped-test')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: testUrl });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.ms).toBe('number');
    expect(typeof res.body.error).toBe('string');
  });
});

describe('Admin: settings - invalid URL variants', () => {
  const app = createApp();

  it('BE-ADM-SET-010: PUT /admin/settings with empty string clears to null', async () => {
    const { token } = await createAdminUser();

    // First set a value
    await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: 'https://test.example.com' });

    // Then clear with empty string
    const res = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: '' });

    expect(res.status).toBe(200);
    expect(res.body.pipedApiUrl.saved).toBeNull();
    expect(res.body.pipedApiUrl.effective).toBe(config.PIPED_API_URL);
  });

  it('BE-ADM-SET-011: PUT /admin/settings trims and strips trailing slashes', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: 'https://test.example.com///' });

    expect(res.status).toBe(200);
    expect(res.body.pipedApiUrl.saved).toBe('https://test.example.com');
    expect(res.body.pipedApiUrl.effective).toBe('https://test.example.com');
  });

  it('BE-ADM-SET-012: PUT /admin/settings rejects URL over 2048 chars with 400', async () => {
    const { token } = await createAdminUser();
    const longUrl = 'https://' + 'a'.repeat(2048) + '.example.com';

    const res = await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ pipedApiUrl: longUrl });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADM-SET-013: piped-test with URL that has trailing slash works correctly', async () => {
    const { token } = await createAdminUser();

    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/healthcheck' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 'test' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    const testUrl = `http://127.0.0.1:${address.port}/`;

    try {
      const res = await request(app)
        .post('/api/v1/admin/settings/piped-test')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: testUrl });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.ms).toBe('number');
      expect(res.body.ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });
});
