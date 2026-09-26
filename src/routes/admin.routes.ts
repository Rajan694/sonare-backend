import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { and, count, desc, eq, ilike, sum, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin, signAdminToken } from '../adminAuth.js';
import { isRedisAvailable } from '../cache.js';
import { db, sql } from '../db/index.js';
import { adminUsers, errorLogs } from '../db/schema.js';
import { createRateLimiter } from '../rateLimit.js';
import {
  checkSetting, ConfigValidationError, describeSettings, latestExtractorCommit, parseSetting, pipedApiUrl,
  saveSetting, SETTINGS,
} from '../systemConfig.js';
import { Piped } from '../upstream/piped.js';

// The admin page's API (/admin on the web build). Every route but /login needs an admin token;
// these accounts are separate from app accounts (admin_users, not users).
export const adminRouter = Router();

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    fail(res, 400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request');
    return undefined;
  }
  return parsed.data;
}

// ---- Sign-in and account ----

const BCRYPT_COST = 12;
// Five wrong passwords from one address lock it out for 15 minutes.
const signInLimiter = createRateLimiter({ max: 5, windowMs: 15 * 60_000 });
// Compared against when the username doesn't exist, so both failures take as long.
const dummyHash = bcrypt.hash(crypto.randomUUID(), BCRYPT_COST);

function accountView(admin: typeof adminUsers.$inferSelect) {
  return {
    username: admin.username,
    lastLoginAt: admin.lastLoginAt,
    // Only a change made here counts: the seeded account starts at version 0.
    passwordChangedAt: admin.tokenVersion > 0 ? admin.updatedAt : null,
  };
}

const credentialsSchema = z.object({
  username: z.string().trim().min(1, 'Enter the username').max(200),
  password: z.string().min(1, 'Enter the password').max(200),
});

adminRouter.post('/login', route(async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const lockout = signInLimiter.blocked(ip);
  if (lockout.blocked) {
    res.setHeader('Retry-After', String(lockout.retryAfterSec));
    return fail(res, 429, 'RATE_LIMITED', `Too many attempts. Try again in ${Math.ceil(lockout.retryAfterSec / 60)} min.`);
  }

  const body = parseBody(credentialsSchema, req, res);
  if (!body) return;

  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.username, body.username)).limit(1);
  const valid = await bcrypt.compare(body.password, admin?.passwordHash ?? await dummyHash);
  if (!admin || !valid) {
    signInLimiter.hit(ip);
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Wrong username or password');
  }

  signInLimiter.reset(ip);
  const [signedIn] = await db.update(adminUsers)
    .set({ lastLoginAt: new Date() })
    .where(eq(adminUsers.id, admin.id))
    .returning();
  res.json({ token: signAdminToken(signedIn), admin: accountView(signedIn) });
}));

adminRouter.use(requireAdmin);

adminRouter.get('/me', route(async (req, res) => {
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, req.admin!.id)).limit(1);
  res.json(accountView(admin));
}));

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z.string()
    .min(8, 'The new password needs at least 8 characters')
    // bcrypt ignores everything past 72 bytes.
    .refine(p => Buffer.byteLength(p) <= 72, 'The new password is too long (72 bytes at most)'),
});

adminRouter.post('/password', route(async (req, res) => {
  const limitKey = `password:${req.admin!.id}`;
  const lockout = signInLimiter.blocked(limitKey);
  if (lockout.blocked) {
    res.setHeader('Retry-After', String(lockout.retryAfterSec));
    return fail(res, 429, 'RATE_LIMITED', `Too many attempts. Try again in ${Math.ceil(lockout.retryAfterSec / 60)} min.`);
  }

  const body = parseBody(passwordSchema, req, res);
  if (!body) return;

  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, req.admin!.id)).limit(1);
  if (!(await bcrypt.compare(body.currentPassword, admin.passwordHash))) {
    signInLimiter.hit(limitKey);
    return fail(res, 400, 'WRONG_PASSWORD', 'The current password is wrong');
  }
  if (body.newPassword === body.currentPassword) {
    return fail(res, 400, 'BAD_REQUEST', 'The new password is the same as the current one');
  }

  signInLimiter.reset(limitKey);
  // A new token version signs out every other admin session; this one gets a fresh token.
  const [updated] = await db.update(adminUsers)
    .set({
      passwordHash: await bcrypt.hash(body.newPassword, BCRYPT_COST),
      tokenVersion: admin.tokenVersion + 1,
      updatedAt: new Date(),
    })
    .where(eq(adminUsers.id, admin.id))
    .returning();
  res.json({ token: signAdminToken(updated), admin: accountView(updated) });
}));

// ---- Configuration ----

adminRouter.get('/config', route(async (req, res) => {
  res.json({ settings: await describeSettings() });
}));

const saveSchema = z.object({
  value: z.string().max(500).nullable(),
  /** Save even though the value's check failed. */
  force: z.boolean().optional(),
});

/** Suggests a value for piped.extractorCommit; nothing is saved. */
adminRouter.get('/config/piped.extractorCommit/latest', route(async (req, res) => {
  try {
    res.json(await latestExtractorCommit());
  } catch (e: any) {
    fail(res, 502, 'UPSTREAM_ERROR', `Could not get the latest commit from GitHub (${e.code || e.message})`);
  }
}));

adminRouter.put('/config/:key', route(async (req, res) => {
  const key = req.params.key as string;
  if (!Object.hasOwn(SETTINGS, key)) return fail(res, 404, 'NOT_FOUND', `No setting called ${key}`);
  const body = parseBody(saveSchema, req, res);
  if (!body) return;

  let value: string | null;
  try {
    value = parseSetting(key, body.value);
  } catch (e) {
    if (e instanceof ConfigValidationError) return fail(res, 400, 'BAD_REQUEST', e.message);
    throw e;
  }

  if (value !== null && !body.force) {
    const problem = await checkSetting(key, value);
    if (problem) return fail(res, 422, 'CHECK_FAILED', problem);
  }

  await saveSetting(key, value, req.admin!.username);
  const settings = await describeSettings();
  res.json({ setting: settings.find(s => s.key === key) });
}));

// ---- Analytics ----
//
// Request and error logs are written as UTC (telemetry.ts). users.created_at comes from the
// database default, in the session's time zone. Everything is bucketed by the viewer's
// time zone (?tz=, from the browser).

function timeZone(req: Request): string {
  const tz = typeof req.query.tz === 'string' ? req.query.tz : 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function intQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const n = Number(req.query[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

async function health() {
  const [piped, database] = await Promise.allSettled([Piped.healthcheck(), sql`SELECT 1`]);
  const memory = process.memoryUsage();
  return {
    piped: { up: piped.status === 'fulfilled', url: pipedApiUrl() },
    database: database.status === 'fulfilled',
    redis: isRedisAvailable(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    memoryMb: Math.round(memory.rss / 1e6),
  };
}

adminRouter.get('/analytics/overview', route(async (req, res) => {
  const days = intQuery(req, 'days', 30, 1, 90);
  const tz = timeZone(req);

  const [totals] = await sql`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users
        WHERE created_at AT TIME ZONE current_setting('TimeZone') >= now() - make_interval(days => ${days})) AS new_users,
      (SELECT count(DISTINCT user_id)::int FROM request_logs
        WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AS active_users,
      (SELECT count(*)::int FROM request_logs
        WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AS requests,
      (SELECT count(*)::int FROM play_history
        WHERE played_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AS plays,
      (SELECT coalesce(sum(ms_played), 0)::float8 FROM play_history
        WHERE played_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AS ms_played,
      (SELECT count(*)::int FROM playlists) AS playlists,
      (SELECT count(*)::int FROM favourite_tracks) AS favourite_tracks,
      (SELECT count(*)::int FROM error_logs
        WHERE last_seen_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AS error_groups
  `;

  const daily = await sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}),
        date_trunc('day', now() AT TIME ZONE ${tz}),
        interval '1 day'
      ) AS day
    ),
    req AS (
      SELECT date_trunc('day', (at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS day,
             count(*)::int AS requests,
             count(*) FILTER (WHERE status >= 500)::int AS server_errors,
             count(DISTINCT user_id)::int AS active_users
      FROM request_logs
      WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days + 1})
      GROUP BY 1
    ),
    signups AS (
      SELECT date_trunc('day', (created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz}) AS day,
             count(*)::int AS signups
      FROM users
      WHERE created_at AT TIME ZONE current_setting('TimeZone') >= now() - make_interval(days => ${days + 1})
      GROUP BY 1
    ),
    plays AS (
      SELECT date_trunc('day', (played_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS day,
             count(*)::int AS plays
      FROM play_history
      WHERE played_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days + 1})
      GROUP BY 1
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
           coalesce(req.requests, 0) AS requests,
           coalesce(req.server_errors, 0) AS server_errors,
           coalesce(req.active_users, 0) AS active_users,
           coalesce(signups.signups, 0) AS signups,
           coalesce(plays.plays, 0) AS plays
    FROM days
    LEFT JOIN req USING (day)
    LEFT JOIN signups USING (day)
    LEFT JOIN plays USING (day)
    ORDER BY days.day
  `;

  const clients = await sql`
    SELECT coalesce(client, 'other') AS client,
           count(*)::int AS requests,
           count(DISTINCT user_id)::int AS users
    FROM request_logs
    WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})
    GROUP BY 1
    ORDER BY 2 DESC
  `;

  res.json({
    days,
    totals: {
      users: totals.users,
      newUsers: totals.new_users,
      activeUsers: totals.active_users,
      requests: totals.requests,
      plays: totals.plays,
      listeningHours: Math.round(totals.ms_played / 360_000) / 10,
      playlists: totals.playlists,
      favouriteTracks: totals.favourite_tracks,
      errorGroups: totals.error_groups,
    },
    daily: daily.map(d => ({
      day: d.day,
      requests: d.requests,
      serverErrors: d.server_errors,
      activeUsers: d.active_users,
      signups: d.signups,
      plays: d.plays,
    })),
    clients: clients.map(c => ({ client: c.client, requests: c.requests, users: c.users })),
    health: await health(),
  });
}));

adminRouter.get('/analytics/requests', route(async (req, res) => {
  const hours = intQuery(req, 'hours', 24, 1, 720);
  const tz = timeZone(req);
  // Hourly bars up to two days, daily past that.
  const unit = hours <= 48 ? 'hour' : 'day';
  const buckets = unit === 'hour' ? hours : Math.ceil(hours / 24);
  const step = unit === 'hour' ? '1 hour' : '1 day';

  const [summary] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status >= 500)::int AS server_errors,
           count(*) FILTER (WHERE status >= 400 AND status < 500)::int AS client_errors,
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::float8 AS p50,
           coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::float8 AS p95
    FROM request_logs
    WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
  `;

  const series = await sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc(${unit}, now() AT TIME ZONE ${tz}) - ${step}::interval * ${buckets - 1},
        date_trunc(${unit}, now() AT TIME ZONE ${tz}),
        ${step}::interval
      ) AS bucket
    ),
    req AS (
      SELECT date_trunc(${unit}, (at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
             count(*)::int AS requests,
             count(*) FILTER (WHERE status >= 500)::int AS server_errors,
             coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::float8 AS p95
      FROM request_logs
      WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours + 24})
      GROUP BY 1
    )
    SELECT to_char(buckets.bucket, 'YYYY-MM-DD"T"HH24:MI') AS at,
           coalesce(req.requests, 0) AS requests,
           coalesce(req.server_errors, 0) AS server_errors,
           coalesce(req.p95, 0) AS p95
    FROM buckets LEFT JOIN req USING (bucket)
    ORDER BY buckets.bucket
  `;

  const routes = await sql`
    SELECT method, route,
           count(*)::int AS count,
           count(*) FILTER (WHERE status >= 500)::int AS server_errors,
           count(*) FILTER (WHERE status >= 400 AND status < 500)::int AS client_errors,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95,
           max(duration_ms)::int AS max
    FROM request_logs
    WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    GROUP BY method, route
    ORDER BY count DESC
    LIMIT 100
  `;

  const statuses = await sql`
    SELECT status, count(*)::int AS count
    FROM request_logs
    WHERE at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    GROUP BY status
    ORDER BY status
  `;

  res.json({
    hours,
    unit,
    summary: {
      total: summary.total,
      serverErrors: summary.server_errors,
      clientErrors: summary.client_errors,
      p50: Math.round(summary.p50),
      p95: Math.round(summary.p95),
    },
    series: series.map(s => ({ at: s.at, requests: s.requests, serverErrors: s.server_errors, p95: Math.round(s.p95) })),
    routes: routes.map(r => ({
      method: r.method,
      route: r.route,
      count: r.count,
      serverErrors: r.server_errors,
      clientErrors: r.client_errors,
      p50: Math.round(r.p50),
      p95: Math.round(r.p95),
      max: r.max,
    })),
    statuses: statuses.map(s => ({ status: s.status, count: s.count })),
  });
}));

// ---- Error logs ----

const SOURCES = ['backend', 'web', 'linux', 'mobile'] as const;

function errorFilter(req: Request): SQL | undefined {
  const source = typeof req.query.source === 'string' && (SOURCES as readonly string[]).includes(req.query.source)
    ? req.query.source : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  return and(
    source ? eq(errorLogs.source, source) : undefined,
    q ? ilike(errorLogs.message, `%${q.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
  );
}

adminRouter.get('/errors', route(async (req, res) => {
  const limit = intQuery(req, 'limit', 50, 1, 200);
  const offset = intQuery(req, 'offset', 0, 0, 1_000_000);
  const where = errorFilter(req);

  const [items, [{ total }], bySource] = await Promise.all([
    db.select().from(errorLogs).where(where).orderBy(desc(errorLogs.lastSeenAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(errorLogs).where(where),
    db.select({ source: errorLogs.source, groups: count(), events: sum(errorLogs.count).mapWith(Number) })
      .from(errorLogs).groupBy(errorLogs.source),
  ]);
  res.json({ items, total, bySource });
}));

adminRouter.delete('/errors/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return fail(res, 400, 'BAD_REQUEST', 'Bad error id');
  const deleted = await db.delete(errorLogs).where(eq(errorLogs.id, id)).returning({ id: errorLogs.id });
  if (deleted.length === 0) return fail(res, 404, 'NOT_FOUND', 'That error is already gone');
  res.status(204).end();
}));

/** Clears every error matching the same filters as the list (?source=, ?q=). */
adminRouter.delete('/errors', route(async (req, res) => {
  const deleted = await db.delete(errorLogs).where(errorFilter(req)).returning({ id: errorLogs.id });
  res.json({ deleted: deleted.length });
}));
