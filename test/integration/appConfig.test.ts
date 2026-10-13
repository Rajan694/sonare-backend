import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminUser } from '../factories.js';
import { db } from '../../src/db/index.js';
import { appSettings } from '../../src/db/schema.js';
import { DEFAULT_YOUTUBE_CLIENTS } from '../../src/services/settings.js';

describe('Public app-config', () => {
  const app = createApp();

  beforeAll(async () => {
    await db.delete(appSettings);
  });

  afterAll(async () => {
    await db.delete(appSettings);
  });

  it('BE-CFG-001: GET /api/v1/app-config requires no auth and returns 200', async () => {
    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('BE-CFG-002: GET /api/v1/app-config returns default config when no settings saved', async () => {
    await db.delete(appSettings);
    // Reload/clear settings in memory
    const { loadSettings } = await import('../../src/services/settings.js');
    await loadSettings();

    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      inAppYoutube: true,
      youtubeClients: DEFAULT_YOUTUBE_CLIENTS,
      updatedAt: 0,
    });
  });

  it('BE-CFG-003: GET /api/v1/app-config reflects admin updates and updatedAt timestamp', async () => {
    const { token } = await createAdminUser();
    const newClients = ['WEB', 'VISIONOS'];

    const beforeTime = Date.now();
    await request(app)
      .put('/api/v1/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ inAppYoutube: false, youtubeClients: newClients });

    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(res.body.inAppYoutube).toBe(false);
    expect(res.body.youtubeClients).toEqual(newClients);
    expect(typeof res.body.updatedAt).toBe('number');
    expect(res.body.updatedAt).toBeGreaterThanOrEqual(beforeTime - 2000);
    expect(res.body.updatedAt).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('BE-CFG-004: GET /api/v1/app-config sets Cache-Control: public, max-age=60 header', async () => {
    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });
});
