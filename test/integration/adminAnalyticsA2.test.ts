import crypto from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db, sql } from '../../src/db/index.js';
import { users, activityDaily, apiUsageHourly, errorLogs } from '../../src/db/schema.js';
import { createAdminUser } from '../factories.js';
import { config } from '../../src/config.js';

describe('Admin Analytics Phase A2', () => {
  const app = createApp();
  beforeEach(async () => {
    await db.delete(activityDaily);
    await db.delete(apiUsageHourly);
    await db.delete(errorLogs);
  });

  it('BE-ANL-013: GET /analytics/overview returns totals, active DAU/WAU/MAU, and daily series', async () => {
    const { token } = await createAdminUser();
    const tz = config.ANALYTICS_TIME_ZONE;

    // Insert active daily rows for today
    const [todayRow] = await sql<{ today: string }[]>`SELECT (now() AT TIME ZONE ${tz})::date::text as today`;
    const today = todayRow.today;

    await db.insert(activityDaily).values([
      { day: today, actor: 'u-1', kind: 'user', client: 'web', install: 'inst-1' },
      { day: today, actor: 'u-2', kind: 'user', client: 'windows', install: 'inst-2' },
      { day: today, actor: 'guest-1', kind: 'guest', client: 'web', install: null },
      { day: today, actor: 'guest-signed-in', kind: 'guest', client: 'web', install: null },
      { day: today, actor: 'u-3', kind: 'user', client: 'web', install: 'guest-signed-in' },
    ]);

    // Insert API usage hourly for today
    const nowHour = new Date();
    nowHour.setUTCMinutes(0, 0, 0);
    await db.insert(apiUsageHourly).values({
      hour: nowHour,
      method: 'GET',
      route: '/api/v1/tracks',
      count: 20,
      s2xx: 18,
      s3xx: 0,
      s4xx: 1,
      s5xx: 1,
      totalMs: 500,
      maxMs: 80,
      hist: [5, 10, 5, 0, 0, 0, 0, 0, 0],
    });

    const res = await request(app)
      .get('/api/v1/admin/analytics/overview?days=7')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('daily');
    expect(res.body).toHaveProperty('clients');
    expect(res.body).toHaveProperty('signupsByClient');

    // Check totals
    expect(res.body.totals.activeUsers).toBe(3);
    // guest-signed-in must be excluded because u-3 has install = guest-signed-in
    expect(res.body.totals.activeGuests).toBe(1);
    expect(res.body.totals.requests).toBe(20);

    // Check active DAU/WAU/MAU
    expect(res.body.active.dau).toEqual({ users: 3, guests: 1 });
    expect(res.body.active.wau).toEqual({ users: 3, guests: 1 });
    expect(res.body.active.mau).toEqual({ users: 3, guests: 1 });

    // Check daily array
    expect(res.body.daily.length).toBe(7);
    const todayDaily = res.body.daily.find((d: { day: string }) => d.day === today);
    expect(todayDaily).toBeDefined();
    expect(todayDaily.users).toBe(3);
    expect(todayDaily.activeUsers).toBe(3);
    expect(todayDaily.guests).toBe(1);
    expect(todayDaily.requests).toBe(20);
    expect(todayDaily.serverErrors).toBe(1);

    // Check clients
    const windowsClient = res.body.clients.find((c: { client: string }) => c.client === 'windows');
    expect(windowsClient).toBeDefined();
    expect(windowsClient.users).toBe(1);

    const webClient = res.body.clients.find((c: { client: string }) => c.client === 'web');
    expect(webClient).toBeDefined();
    expect(webClient.users).toBe(2);
    expect(webClient.guests).toBe(1);
  });

  it('BE-ANL-014: GET /analytics/overview groups signups by client', async () => {
    const { token } = await createAdminUser();

    // Create a regular user with signupClient = windows
    const testEmail = `win-${crypto.randomUUID()}@example.com`;
    await db.insert(users).values({
      email: testEmail,
      displayName: 'Windows User',
      passwordHash: 'hash',
      role: 'user',
      signupClient: 'windows',
    });

    const res = await request(app)
      .get('/api/v1/admin/analytics/overview?days=7')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const windowsSignups = res.body.signupsByClient.find((s: { client: string }) => s.client === 'windows');
    expect(windowsSignups).toBeDefined();
    expect(windowsSignups.count).toBeGreaterThanOrEqual(1);
  });

  it('BE-ANL-015: GET /analytics/requests returns histogram-derived p50/p95, routes avg, and statusClasses', async () => {
    const { token } = await createAdminUser();

    const nowHour = new Date();
    nowHour.setUTCMinutes(0, 0, 0);
    await db.insert(apiUsageHourly).values({
      hour: nowHour,
      method: 'GET',
      route: '/api/v1/albums',
      count: 100,
      s2xx: 90,
      s3xx: 5,
      s4xx: 3,
      s5xx: 2,
      totalMs: 10000,
      maxMs: 300,
      // 50 requests in [0, 25], 50 in [25, 50]
      hist: [50, 50, 0, 0, 0, 0, 0, 0, 0],
    });

    const res = await request(app)
      .get('/api/v1/admin/analytics/requests?hours=24')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('series');
    expect(res.body).toHaveProperty('routes');
    expect(res.body).toHaveProperty('statusClasses');

    // summary check
    expect(res.body.summary.total).toBe(100);
    expect(res.body.summary.serverErrors).toBe(2);
    expect(res.body.summary.clientErrors).toBe(3);
    expect(res.body.summary.p50).toBe(25);
    expect(res.body.summary.p95).toBe(48);

    // routes check
    const route = res.body.routes.find((r: { route: string }) => r.route === '/api/v1/albums');
    expect(route).toBeDefined();
    expect(route.count).toBe(100);
    expect(route.avg).toBe(100); // 10000 ms / 100 count
    expect(route.p50).toBe(25);
    expect(route.p95).toBe(48);
    expect(route.max).toBe(300);

    // statusClasses check
    const s2xx = res.body.statusClasses.find((s: { class: string }) => s.class === '2xx');
    const s3xx = res.body.statusClasses.find((s: { class: string }) => s.class === '3xx');
    const s4xx = res.body.statusClasses.find((s: { class: string }) => s.class === '4xx');
    const s5xx = res.body.statusClasses.find((s: { class: string }) => s.class === '5xx');

    expect(s2xx?.count).toBe(90);
    expect(s3xx?.count).toBe(5);
    expect(s4xx?.count).toBe(3);
    expect(s5xx?.count).toBe(2);
  });

  it('BE-ANL-016: client errors endpoint and admin filter accept windows source', async () => {
    // 1. Post client error report with source = 'windows'
    const reportRes = await request(app).post('/api/v1/client-errors').send({
      source: 'windows',
      level: 'error',
      message: 'Windows native client exception',
    });
    expect(reportRes.status).toBe(204);

    // Flush telemetry buffer so error lands in DB
    const { flushTelemetry } = await import('../../src/services/telemetry.js');
    await flushTelemetry();

    // 2. Fetch admin error logs filtered by source = windows
    const { token } = await createAdminUser();
    const adminRes = await request(app)
      .get('/api/v1/admin/errors?source=windows')
      .set('Authorization', `Bearer ${token}`);

    expect(adminRes.status).toBe(200);
    expect(adminRes.body.items.length).toBeGreaterThanOrEqual(1);
    expect(adminRes.body.items[0].source).toBe('windows');
    expect(adminRes.body.items[0].message).toBe('Windows native client exception');
  });
});
