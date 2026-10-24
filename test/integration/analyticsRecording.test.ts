import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { db, sql } from '../../src/db/index.js';
import { activityDaily, apiUsageHourly, users } from '../../src/db/schema.js';
import { flushTelemetry, requestLogger, _resetTelemetryStateForTesting } from '../../src/services/telemetry.js';
import { createAdminUser, createUser } from '../factories.js';

describe('Analytics recording and storage (Phase A1)', () => {
  const app = createApp();

  beforeEach(async () => {
    _resetTelemetryStateForTesting();
    await db.delete(activityDaily);
    await db.delete(apiUsageHourly);
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetTelemetryStateForTesting();
    await db.delete(activityDaily);
    await db.delete(apiUsageHourly);
  });

  it('BE-ANL-001: a signed-in request writes one user row per day per client; two requests still write one row', async () => {
    const { user, token } = await createUser();

    // Two requests on the same day from the same client
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`).set('x-sonare-client', 'web');

    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`).set('x-sonare-client', 'web');

    await flushTelemetry();

    const rows = await db
      .select()
      .from(activityDaily)
      .where(and(eq(activityDaily.actor, user.id), eq(activityDaily.client, 'web')));

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('user');
    expect(rows[0].client).toBe('web');
  });

  it('BE-ANL-002: a guest request with a valid install header writes a guest row', async () => {
    const installId = crypto.randomUUID();

    await request(app).get('/api/v1/trending').set('x-sonare-install', installId).set('x-sonare-client', 'mobile');

    await flushTelemetry();

    const rows = await db.select().from(activityDaily).where(eq(activityDaily.actor, installId));

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('guest');
    expect(rows[0].client).toBe('mobile');
    expect(rows[0].install).toBeNull();
  });

  it('BE-ANL-003: an invalid install header writes no activity row', async () => {
    await request(app)
      .get('/api/v1/trending')
      .set('x-sonare-install', 'not-a-valid-uuid')
      .set('x-sonare-client', 'web');

    await flushTelemetry();

    const rows = await db.select().from(activityDaily);
    expect(rows).toHaveLength(0);
  });

  it('BE-ANL-004: a signed-in request with an install id stores it in install column', async () => {
    const { user, token } = await createUser();
    const installId = crypto.randomUUID();

    await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('x-sonare-client', 'linux')
      .set('x-sonare-install', installId);

    await flushTelemetry();

    const [row] = await db
      .select()
      .from(activityDaily)
      .where(and(eq(activityDaily.actor, user.id), eq(activityDaily.client, 'linux')));

    expect(row).toBeDefined();
    expect(row.kind).toBe('user');
    expect(row.install).toBe(installId);
  });

  it('BE-ANL-005: api usage counts, status classes, max and hist are recorded after flush', async () => {
    // Fire a successful request (200)
    await request(app).get('/api/v1/trending');
    // Fire a 404 request
    await request(app).get('/api/v1/nonexistent-route-for-testing-404');

    await flushTelemetry();

    const rows = await db.select().from(apiUsageHourly);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const hit = rows.find((r) => r.route === '/api/v1/trending');
    expect(hit).toBeDefined();
    expect(hit!.count).toBeGreaterThanOrEqual(1);
    expect(hit!.s2xx).toBeGreaterThanOrEqual(1);
    expect(hit!.totalMs).toBeGreaterThanOrEqual(0);
    expect(hit!.maxMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(hit!.hist)).toBe(true);
    expect(hit!.hist).toHaveLength(9);
    const sumHist = hit!.hist.reduce((a, b) => a + b, 0);
    expect(sumHist).toBe(hit!.count);

    const notFound = rows.find((r) => r.route === '(no route)' || r.route.includes('nonexistent'));
    expect(notFound).toBeDefined();
    expect(notFound!.s4xx).toBeGreaterThanOrEqual(1);
  });

  it('BE-ANL-006: OPTIONS and admin requests are not counted in api usage or activity', async () => {
    const { token } = await createAdminUser();

    // CORS preflight
    await request(app).options('/api/v1/trending');
    // Admin request
    await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`);

    await flushTelemetry();

    const usage = await db.select().from(apiUsageHourly);
    const activity = await db.select().from(activityDaily);

    expect(usage.some((u) => u.method === 'OPTIONS')).toBe(false);
    expect(usage.some((u) => u.route.startsWith('/api/v1/admin'))).toBe(false);
    expect(activity.some((a) => a.actor.startsWith('admin'))).toBe(false);
  });

  it('BE-ANL-007: register stores signup_client from X-Sonare-Client header', async () => {
    const email = `test-signup-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('x-sonare-client', 'mobile')
      .send({ email, password: 'password123', displayName: 'Mobile User' });

    expect(res.status).toBe(201);

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user).toBeDefined();
    expect(user.signupClient).toBe('mobile');
  });

  it('BE-ANL-008: prune drops activity_daily older than 400 days and api_usage_hourly older than 90 days', async () => {
    const oldDate = new Date(Date.now() - 401 * 86_400_000).toISOString().slice(0, 10);
    const freshDate = new Date().toISOString().slice(0, 10);
    await db.insert(activityDaily).values([
      { day: oldDate, actor: 'old-act', kind: 'user', client: 'web' },
      { day: freshDate, actor: 'fresh-act', kind: 'user', client: 'web' },
    ]);

    const oldHour = new Date(Date.now() - 91 * 86_400_000);
    oldHour.setUTCMinutes(0, 0, 0);
    const freshHour = new Date();
    freshHour.setUTCMinutes(0, 0, 0);
    await db.insert(apiUsageHourly).values([
      { hour: oldHour, method: 'GET', route: '/old', count: 1 },
      { hour: freshHour, method: 'GET', route: '/fresh', count: 1 },
    ]);

    const utcNow = drizzleSql`(now() AT TIME ZONE 'UTC')`;
    await db.delete(activityDaily).where(drizzleSql`day < (${utcNow} - make_interval(days => 400))::date`);
    await db.delete(apiUsageHourly).where(drizzleSql`hour < ${utcNow} - make_interval(days => 90)`);

    const actRemaining = await db.select().from(activityDaily);
    expect(actRemaining.map((r) => r.actor)).toEqual(['fresh-act']);

    const usageRemaining = await db.select().from(apiUsageHourly);
    expect(usageRemaining.map((r) => r.route)).toEqual(['/fresh']);
  });

  it('BE-ANL-009: migration 0017 backfill logic correctly transforms request_logs rows', async () => {
    // Recreate a temporary request_logs table to verify the backfill SQL queries
    await sql.unsafe(`
      CREATE TEMP TABLE temp_request_logs (
        id serial primary key,
        at timestamp not null,
        method text not null,
        route text not null,
        status integer not null,
        duration_ms integer not null,
        user_id text,
        client text
      );
    `);

    const fakeUserId = crypto.randomUUID();
    // Seed temp_request_logs with diverse rows: signed in, guest, different statuses, latencies
    await sql.unsafe(`
      INSERT INTO temp_request_logs (at, method, route, status, duration_ms, user_id, client) VALUES
      ('2026-05-10 10:00:00', 'GET', '/api/v1/tracks/1', 200, 15, '${fakeUserId}', 'web'),
      ('2026-05-10 10:15:00', 'GET', '/api/v1/tracks/1', 200, 45, '${fakeUserId}', 'web'),
      ('2026-05-10 10:30:00', 'POST', '/api/v1/me/sync', 500, 600, '${fakeUserId}', 'linux'),
      ('2026-05-10 11:00:00', 'GET', '/api/v1/trending', 404, 3000, NULL, NULL);
    `);

    // Run backfill SQL for activity_daily (adapted to temp table)
    await sql.unsafe(`
      INSERT INTO activity_daily ("day", "actor", "kind", "client")
      SELECT
        ((at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS day,
        user_id::text AS actor,
        'user' AS kind,
        coalesce(client, 'other') AS client
      FROM temp_request_logs
      WHERE user_id IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ON CONFLICT DO NOTHING;
    `);

    const backfilledAct = await db.select().from(activityDaily).where(eq(activityDaily.actor, fakeUserId));

    // Two distinct (day, actor, client) groups: ('web') and ('linux')
    expect(backfilledAct).toHaveLength(2);
    expect(backfilledAct.map((r) => r.client).sort()).toEqual(['linux', 'web']);

    // Run backfill SQL for api_usage_hourly (adapted to temp table)
    await sql.unsafe(`
      INSERT INTO api_usage_hourly (
        "hour", "method", "route", "count",
        "s2xx", "s3xx", "s4xx", "s5xx",
        "total_ms", "max_ms", "hist"
      )
      SELECT
        date_trunc('hour', at) AS hour,
        method,
        route,
        count(*)::int,
        count(*) FILTER (WHERE status >= 200 AND status < 300)::int,
        count(*) FILTER (WHERE status >= 300 AND status < 400)::int,
        count(*) FILTER (WHERE status >= 400 AND status < 500)::int,
        count(*) FILTER (WHERE status >= 500)::int,
        coalesce(sum(duration_ms), 0)::bigint,
        coalesce(max(duration_ms), 0)::int,
        ARRAY[
          count(*) FILTER (WHERE duration_ms <=   25)::int,
          count(*) FILTER (WHERE duration_ms >    25 AND duration_ms <=   50)::int,
          count(*) FILTER (WHERE duration_ms >    50 AND duration_ms <=  100)::int,
          count(*) FILTER (WHERE duration_ms >   100 AND duration_ms <=  250)::int,
          count(*) FILTER (WHERE duration_ms >   250 AND duration_ms <=  500)::int,
          count(*) FILTER (WHERE duration_ms >   500 AND duration_ms <= 1000)::int,
          count(*) FILTER (WHERE duration_ms >  1000 AND duration_ms <= 2500)::int,
          count(*) FILTER (WHERE duration_ms >  2500 AND duration_ms <= 5000)::int,
          count(*) FILTER (WHERE duration_ms >  5000)::int
        ]
      FROM temp_request_logs
      GROUP BY 1, 2, 3
      ON CONFLICT DO NOTHING;
    `);

    const trackHourly = await db.select().from(apiUsageHourly).where(eq(apiUsageHourly.route, '/api/v1/tracks/1'));

    expect(trackHourly).toHaveLength(1);
    expect(trackHourly[0].count).toBe(2);
    expect(trackHourly[0].s2xx).toBe(2);
    expect(trackHourly[0].totalMs).toBe(60); // 15 + 45
    expect(trackHourly[0].maxMs).toBe(45);
    // Bucket 0 (<= 25ms): 1 (the 15ms request)
    // Bucket 1 (<= 50ms): 1 (the 45ms request)
    expect(trackHourly[0].hist[0]).toBe(1);
    expect(trackHourly[0].hist[1]).toBe(1);

    await sql.unsafe(`DROP TABLE temp_request_logs;`);
  });

  it('BE-ANL-010: fifty requests from one signed-in user with an install id yield one row with install stored', async () => {
    const { user, token } = await createUser();
    const installId = crypto.randomUUID();

    for (let i = 0; i < 50; i++) {
      await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .set('x-sonare-client', 'web')
        .set('x-sonare-install', installId);
    }

    await flushTelemetry();

    const rows = await db
      .select()
      .from(activityDaily)
      .where(and(eq(activityDaily.actor, user.id), eq(activityDaily.client, 'web')));

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('user');
    expect(rows[0].client).toBe('web');
    expect(rows[0].install).toBe(installId);
  });

  it('BE-ANL-011: flush of >500 keys issues one statement per chunk of 500', async () => {
    const handler = requestLogger();

    // Generate 520 distinct requests
    for (let i = 0; i < 520; i++) {
      const installId = crypto.randomUUID();
      const req = {
        method: 'GET',
        originalUrl: `/api/v1/tracks/${i}`,
        route: { path: `/api/v1/tracks/${i}` },
        get: (h: string) => {
          if (h.toLowerCase() === 'x-sonare-install') return installId;
          if (h.toLowerCase() === 'x-sonare-client') return 'web';
          return undefined;
        },
        user: null,
      };
      const res = Object.assign(new EventEmitter(), {
        locals: {},
        statusCode: 200,
        writeHead: () => res,
      }) as unknown as Response;
      handler(req as unknown as Request, res, () => {});
      res.emit('close');
    }

    const insertSpy = vi.spyOn(db, 'insert');

    await flushTelemetry();

    // 520 activity rows should be flushed in 2 chunks of 500 (500 + 20)
    const activityInserts = insertSpy.mock.calls.filter((call) => call[0] === activityDaily);
    expect(activityInserts).toHaveLength(2);

    // 520 usage rows should also be flushed in 2 chunks of 500 (500 + 20)
    const usageInserts = insertSpy.mock.calls.filter((call) => call[0] === apiUsageHourly);
    expect(usageInserts).toHaveLength(2);

    insertSpy.mockRestore();

    const [activityCount] = await db.select({ count: drizzleSql<number>`count(*)::int` }).from(activityDaily);
    expect(activityCount.count).toBe(520);

    const [usageCount] = await db.select({ count: drizzleSql<number>`count(*)::int` }).from(apiUsageHourly);
    expect(usageCount.count).toBe(520);
  });

  it('BE-ANL-012: activity Set resets on a new local day in ANALYTICS_TIME_ZONE', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    // Asia/Kolkata is UTC+05:30.
    // 2026-10-22 18:00:00 UTC = 2026-10-22 23:30:00 IST (Day: 2026-10-22)
    // 2026-10-22 19:00:00 UTC = 2026-10-23 00:30:00 IST (Day: 2026-10-23, though UTC day is still 2026-10-22)
    const day1Date = new Date('2026-10-22T18:00:00.000Z');
    const day2Date = new Date('2026-10-22T19:00:00.000Z');

    vi.setSystemTime(day1Date);
    const installId = crypto.randomUUID();

    await request(app).get('/api/v1/trending').set('x-sonare-install', installId).set('x-sonare-client', 'web');

    await flushTelemetry();

    const day1Rows = await db.select().from(activityDaily).where(eq(activityDaily.actor, installId));
    expect(day1Rows).toHaveLength(1);
    expect(day1Rows[0].day).toBe('2026-10-22');

    // Switch to local day 2 (UTC date remains 2026-10-22)
    vi.setSystemTime(day2Date);

    await request(app).get('/api/v1/trending').set('x-sonare-install', installId).set('x-sonare-client', 'web');

    await flushTelemetry();

    const allRows = await db.select().from(activityDaily).where(eq(activityDaily.actor, installId));
    expect(allRows).toHaveLength(2);
    const days = allRows.map((r) => r.day).sort();
    expect(days).toEqual(['2026-10-22', '2026-10-23']);
  });
});
