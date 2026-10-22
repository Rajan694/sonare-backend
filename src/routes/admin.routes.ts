import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { and, count, desc, eq, ilike, sql as sqlExpr, sum, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin, signAdminToken } from '../middleware/adminAuth.js';
import { isRedisAvailable } from '../services/cache.js';
import { db, sql } from '../db/index.js';
import { errorLogs, users } from '../db/schema.js';
import { config } from '../config.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { Piped } from '../upstream/piped.js';
import { parseBody } from '../validation.js';
import { adminAiRouter, aiUsageHandler } from './adminAi.routes.js';
import { percentileFromHist } from '../services/telemetry.js';
import {
  pipedApiUrl,
  setPipedApiUrl,
  getSavedPipedApiUrl,
  youtubeClients,
  setYoutubeClients,
  getSavedYoutubeClients,
  inAppYoutube,
  setInAppYoutube,
  getSavedInAppYoutube,
  ALLOWED_YOUTUBE_CLIENTS,
  DEFAULT_YOUTUBE_CLIENTS,
} from '../services/settings.js';

// The admin page's API (/admin on the web build). Every route but /login needs an admin token.
// Admins are rows in users with role 'admin'; the app's own login refuses them.
export const adminRouter = Router();

const fail = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

// ---- Sign-in and account ----

const BCRYPT_COST = 12;
// Five wrong passwords from one address lock it out for 15 minutes.
const signInLimiter = createRateLimiter({ name: 'admin', max: 5, windowMs: 15 * 60_000 });
// Compared against when no admin has that email, so both failures take as long.
const dummyHash = bcrypt.hash(crypto.randomUUID(), BCRYPT_COST);

const accountView = (admin: typeof users.$inferSelect) => {
  return {
    email: admin.email,
    lastLoginAt: admin.lastLoginAt,
    passwordChangedAt: admin.passwordChangedAt,
  };
};

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter the email').max(200),
  password: z.string().min(1, 'Enter the password').max(200),
});

adminRouter.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const lockout = await signInLimiter.blocked(ip);
  if (lockout.blocked) {
    res.setHeader('Retry-After', String(lockout.retryAfterSec));
    return fail(
      res,
      429,
      'RATE_LIMITED',
      `Too many attempts. Try again in ${Math.ceil(lockout.retryAfterSec / 60)} min.`,
    );
  }

  const body = parseBody(credentialsSchema, req);

  const [admin] = await db
    .select()
    .from(users)
    .where(and(eq(sqlExpr`lower(${users.email})`, body.email), eq(users.role, 'admin')))
    .limit(1);
  const valid = await bcrypt.compare(body.password, admin?.passwordHash ?? (await dummyHash));
  if (!admin || !valid) {
    await signInLimiter.hit(ip);
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Wrong email or password');
  }

  await signInLimiter.reset(ip);
  const [signedIn] = await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, admin.id)).returning();
  res.json({ token: signAdminToken(signedIn), admin: accountView(signedIn) });
});

adminRouter.use(requireAdmin);

// AI providers (adminAi.routes.ts); their usage is with the other analytics below.
adminRouter.use('/ai', adminAiRouter);
adminRouter.get('/analytics/ai', aiUsageHandler);

// ---- Settings ----

const httpUrlSchema = z
  .string({ invalid_type_error: 'URL must be a string' })
  .trim()
  .max(2048, 'URL is too long (at most 2048 characters)')
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be a valid http or https URL')
  .transform((v) => v.replace(/\/+$/, ''));

const youtubeClientsSchema = z
  .array(z.string({ invalid_type_error: 'Client names must be strings' }))
  .nullable()
  .superRefine((val, ctx) => {
    if (val === null) return;
    if (val.length < 1 || val.length > 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must provide between 1 and 5 YouTube clients',
      });
      return;
    }
    const seen = new Set<string>();
    for (const raw of val) {
      const item = raw.trim().toUpperCase();
      if (!ALLOWED_YOUTUBE_CLIENTS.includes(item as (typeof ALLOWED_YOUTUBE_CLIENTS)[number])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown YouTube client: "${raw}"`,
        });
        return;
      }
      if (seen.has(item)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate YouTube client: "${item}"`,
        });
        return;
      }
      seen.add(item);
    }
  })
  .transform((val) => {
    if (val === null) return null;
    return val.map((item) => item.trim().toUpperCase());
  });

const putSettingsSchema = z
  .object({
    pipedApiUrl: z
      .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), httpUrlSchema.nullable())
      .optional(),
    youtubeClients: youtubeClientsSchema.optional(),
    inAppYoutube: z.boolean({ invalid_type_error: 'inAppYoutube must be a boolean' }).nullable().optional(),
  })
  .refine(
    (data) => data.pipedApiUrl !== undefined || data.youtubeClients !== undefined || data.inAppYoutube !== undefined,
    { message: 'Nothing to update' },
  );

const pipedTestSchema = z.object({
  url: httpUrlSchema,
});

const adminSettingsResponse = () => ({
  pipedApiUrl: {
    saved: getSavedPipedApiUrl(),
    effective: pipedApiUrl(),
    envDefault: config.PIPED_API_URL,
  },
  youtubeClients: {
    saved: getSavedYoutubeClients(),
    effective: youtubeClients(),
    default: [...DEFAULT_YOUTUBE_CLIENTS],
    allowed: [...ALLOWED_YOUTUBE_CLIENTS],
  },
  inAppYoutube: {
    saved: getSavedInAppYoutube(),
    effective: inAppYoutube(),
  },
});

adminRouter.get('/settings', async (_req, res) => {
  res.json(adminSettingsResponse());
});

adminRouter.put('/settings', async (req, res) => {
  const body = parseBody(putSettingsSchema, req);
  if (body.pipedApiUrl !== undefined) {
    await setPipedApiUrl(body.pipedApiUrl);
  }
  if (body.youtubeClients !== undefined) {
    await setYoutubeClients(body.youtubeClients);
  }
  if (body.inAppYoutube !== undefined) {
    await setInAppYoutube(body.inAppYoutube);
  }
  res.json(adminSettingsResponse());
});

adminRouter.post('/settings/piped-test', async (req, res) => {
  const body = parseBody(pipedTestSchema, req);
  const start = Date.now();
  try {
    const ok = await Piped.healthcheck({ baseUrl: body.url, timeoutMs: 5000, retry: false });
    res.json({ ok, ms: Date.now() - start });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, ms: Date.now() - start, error: message });
  }
});

adminRouter.get('/me', async (req, res) => {
  const [admin] = await db.select().from(users).where(eq(users.id, req.admin!.id)).limit(1);
  res.json(accountView(admin));
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z
    .string()
    .min(8, 'The new password needs at least 8 characters')
    // bcrypt ignores everything past 72 bytes.
    .refine((p) => Buffer.byteLength(p) <= 72, 'The new password is too long (72 bytes at most)'),
});

adminRouter.post('/password', async (req, res) => {
  const limitKey = `password:${req.admin!.id}`;
  const lockout = await signInLimiter.blocked(limitKey);
  if (lockout.blocked) {
    res.setHeader('Retry-After', String(lockout.retryAfterSec));
    return fail(
      res,
      429,
      'RATE_LIMITED',
      `Too many attempts. Try again in ${Math.ceil(lockout.retryAfterSec / 60)} min.`,
    );
  }

  const body = parseBody(passwordSchema, req);

  const [admin] = await db.select().from(users).where(eq(users.id, req.admin!.id)).limit(1);
  if (!(await bcrypt.compare(body.currentPassword, admin.passwordHash))) {
    await signInLimiter.hit(limitKey);
    return fail(res, 400, 'WRONG_PASSWORD', 'The current password is wrong');
  }
  if (body.newPassword === body.currentPassword) {
    return fail(res, 400, 'BAD_REQUEST', 'The new password is the same as the current one');
  }

  await signInLimiter.reset(limitKey);
  // A new token version signs out every other admin session; this one gets a fresh token.
  const [updated] = await db
    .update(users)
    .set({
      passwordHash: await bcrypt.hash(body.newPassword, BCRYPT_COST),
      tokenVersion: admin.tokenVersion + 1,
      passwordChangedAt: new Date(),
    })
    .where(eq(users.id, admin.id))
    .returning();
  res.json({ token: signAdminToken(updated), admin: accountView(updated) });
});

// ---- Analytics ----
//
// Request and error logs are written as UTC (telemetry.ts). users.created_at comes from the
// database default, in the session's time zone. Everything is bucketed by the viewer's
// time zone (?tz=, from the browser).

const timeZone = (req: Request): string => {
  const tz = typeof req.query.tz === 'string' ? req.query.tz : 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

const intQuery = (req: Request, name: string, fallback: number, min: number, max: number): number => {
  const n = Number(req.query[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const health = async () => {
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
};

adminRouter.get('/analytics/overview', async (req, res) => {
  const days = intQuery(req, 'days', 30, 1, 90);
  // Activity days are ANALYTICS_TIME_ZONE dates, so compute every activity window
  // and the overview's daily series in ANALYTICS_TIME_ZONE so day boundaries align everywhere.
  const tz = config.ANALYTICS_TIME_ZONE;

  const [totals] = await sql`
    SELECT
      (SELECT count(*)::int FROM users WHERE role = 'user') AS users,
      (SELECT count(*)::int FROM users
        WHERE role = 'user'
          AND ((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS new_users,
      (SELECT count(DISTINCT actor)::int FROM activity_daily
        WHERE kind = 'user'
          AND day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS active_users,
      (SELECT count(DISTINCT a.actor)::int FROM activity_daily a
        WHERE a.kind = 'guest'
          AND a.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
          AND NOT EXISTS (
            SELECT 1 FROM activity_daily u
            WHERE u.kind = 'user'
              AND u.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
              AND u.install = a.actor
          )) AS active_guests,
      (SELECT coalesce(sum(count), 0)::int FROM api_usage_hourly
        WHERE ((hour AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS requests,
      (SELECT count(*)::int FROM play_history
        WHERE ((played_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS plays,
      (SELECT coalesce(sum(ms_played), 0)::float8 FROM play_history
        WHERE ((played_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS ms_played,
      (SELECT count(*)::int FROM playlists) AS playlists,
      (SELECT count(*)::int FROM favourite_tracks) AS favourite_tracks,
      (SELECT count(*)::int FROM error_logs
        WHERE ((last_seen_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date) AS error_groups
  `;

  const [activeStats] = await sql`
    SELECT
      -- DAU (1 day ending today)
      (SELECT count(DISTINCT actor)::int FROM activity_daily
        WHERE kind = 'user' AND day = (now() AT TIME ZONE ${tz})::date) AS dau_users,
      (SELECT count(DISTINCT a.actor)::int FROM activity_daily a
        WHERE a.kind = 'guest' AND a.day = (now() AT TIME ZONE ${tz})::date
          AND NOT EXISTS (
            SELECT 1 FROM activity_daily u
            WHERE u.kind = 'user'
              AND u.day = (now() AT TIME ZONE ${tz})::date
              AND u.install = a.actor
          )) AS dau_guests,
      -- WAU (7 days ending today)
      (SELECT count(DISTINCT actor)::int FROM activity_daily
        WHERE kind = 'user'
          AND day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 6))::date) AS wau_users,
      (SELECT count(DISTINCT a.actor)::int FROM activity_daily a
        WHERE a.kind = 'guest'
          AND a.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 6))::date
          AND NOT EXISTS (
            SELECT 1 FROM activity_daily u
            WHERE u.kind = 'user'
              AND u.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 6))::date
              AND u.install = a.actor
          )) AS wau_guests,
      -- MAU (30 days ending today)
      (SELECT count(DISTINCT actor)::int FROM activity_daily
        WHERE kind = 'user'
          AND day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 29))::date) AS mau_users,
      (SELECT count(DISTINCT a.actor)::int FROM activity_daily a
        WHERE a.kind = 'guest'
          AND a.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 29))::date
          AND NOT EXISTS (
            SELECT 1 FROM activity_daily u
            WHERE u.kind = 'user'
              AND u.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => 29))::date
              AND u.install = a.actor
          )) AS mau_guests
  `;

  const daily = await sql`
    WITH days AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}) + interval '1 day' * i)::date AS day
      FROM generate_series(0, ${days - 1}) AS i
    ),
    req AS (
      SELECT ((hour AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date AS day,
             sum(count)::int AS requests,
             sum(s5xx)::int AS server_errors
      FROM api_usage_hourly
      WHERE ((hour AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
      GROUP BY 1
    ),
    act_users AS (
      SELECT day,
             count(DISTINCT actor)::int AS active_users
      FROM activity_daily
      WHERE kind = 'user'
        AND day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
      GROUP BY 1
    ),
    act_guests AS (
      SELECT a.day,
             count(DISTINCT a.actor)::int AS guests
      FROM activity_daily a
      WHERE a.kind = 'guest'
        AND a.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
        AND NOT EXISTS (
          SELECT 1 FROM activity_daily u
          WHERE u.kind = 'user'
            AND u.day = a.day
            AND u.install = a.actor
        )
      GROUP BY 1
    ),
    signups AS (
      SELECT ((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz})::date AS day,
             count(*)::int AS signups
      FROM users
      WHERE role = 'user'
        AND ((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
      GROUP BY 1
    ),
    plays AS (
      SELECT ((played_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date AS day,
             count(*)::int AS plays
      FROM play_history
      WHERE ((played_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
      GROUP BY 1
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
           coalesce(req.requests, 0)::int AS requests,
           coalesce(req.server_errors, 0)::int AS server_errors,
           coalesce(act_users.active_users, 0)::int AS users,
           coalesce(act_users.active_users, 0)::int AS active_users,
           coalesce(act_guests.guests, 0)::int AS guests,
           coalesce(signups.signups, 0)::int AS signups,
           coalesce(plays.plays, 0)::int AS plays
    FROM days
    LEFT JOIN req USING (day)
    LEFT JOIN act_users USING (day)
    LEFT JOIN act_guests USING (day)
    LEFT JOIN signups USING (day)
    LEFT JOIN plays USING (day)
    ORDER BY days.day
  `;

  const clients = await sql`
    SELECT a.client,
           count(DISTINCT a.actor) FILTER (WHERE a.kind = 'user')::int AS users,
           count(DISTINCT a.actor) FILTER (
             WHERE a.kind = 'guest'
               AND NOT EXISTS (
                 SELECT 1 FROM activity_daily u
                 WHERE u.kind = 'user'
                   AND u.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
                   AND u.install = a.actor
               )
           )::int AS guests
    FROM activity_daily a
    WHERE a.day >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
    GROUP BY a.client
    ORDER BY users DESC, guests DESC, a.client ASC
  `;

  const signupsByClient = await sql`
    SELECT
      CASE
        WHEN signup_client IN ('web', 'linux', 'windows', 'mobile') THEN signup_client
        ELSE 'unknown'
      END AS client,
      count(*)::int AS count
    FROM users
    WHERE role = 'user'
      AND ((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz})::date >= ((now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}))::date
    GROUP BY 1
    ORDER BY count DESC, client ASC
  `;

  res.json({
    days,
    totals: {
      users: totals.users,
      newUsers: totals.new_users,
      activeUsers: totals.active_users,
      activeGuests: totals.active_guests,
      requests: totals.requests,
      plays: totals.plays,
      listeningHours: Math.round(totals.ms_played / 360_000) / 10,
      playlists: totals.playlists,
      favouriteTracks: totals.favourite_tracks,
      errorGroups: totals.error_groups,
    },
    active: {
      dau: { users: activeStats.dau_users, guests: activeStats.dau_guests },
      wau: { users: activeStats.wau_users, guests: activeStats.wau_guests },
      mau: { users: activeStats.mau_users, guests: activeStats.mau_guests },
    },
    daily: daily.map((d) => ({
      day: d.day,
      users: d.users,
      activeUsers: d.active_users,
      guests: d.guests,
      signups: d.signups,
      plays: d.plays,
      requests: d.requests,
      serverErrors: d.server_errors,
    })),
    clients: clients.map((c) => ({
      client: c.client,
      users: c.users,
      guests: c.guests,
    })),
    signupsByClient: signupsByClient.map((s) => ({
      client: s.client as 'web' | 'linux' | 'windows' | 'mobile' | 'unknown',
      count: s.count,
    })),
    health: await health(),
  });
});

adminRouter.get('/analytics/requests', async (req, res) => {
  const hours = intQuery(req, 'hours', 24, 1, 720);
  const tz = timeZone(req);
  // Hourly bars up to two days, daily past that.
  const unit = hours <= 48 ? 'hour' : 'day';
  const buckets = unit === 'hour' ? hours : Math.ceil(hours / 24);
  const step = unit === 'hour' ? '1 hour' : '1 day';

  const [summary] = await sql`
    SELECT coalesce(sum(count), 0)::int AS total,
           coalesce(sum(s5xx), 0)::int AS server_errors,
           coalesce(sum(s4xx), 0)::int AS client_errors,
           coalesce(max(max_ms), 0)::int AS max_ms,
           ARRAY[
             coalesce(sum(hist[1]), 0)::int,
             coalesce(sum(hist[2]), 0)::int,
             coalesce(sum(hist[3]), 0)::int,
             coalesce(sum(hist[4]), 0)::int,
             coalesce(sum(hist[5]), 0)::int,
             coalesce(sum(hist[6]), 0)::int,
             coalesce(sum(hist[7]), 0)::int,
             coalesce(sum(hist[8]), 0)::int,
             coalesce(sum(hist[9]), 0)::int
           ] AS hist
    FROM api_usage_hourly
    WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
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
      SELECT date_trunc(${unit}, (hour AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
             sum(count)::int AS requests,
             sum(s5xx)::int AS server_errors,
             max(max_ms)::int AS max_ms,
             ARRAY[
               coalesce(sum(hist[1]), 0)::int,
               coalesce(sum(hist[2]), 0)::int,
               coalesce(sum(hist[3]), 0)::int,
               coalesce(sum(hist[4]), 0)::int,
               coalesce(sum(hist[5]), 0)::int,
               coalesce(sum(hist[6]), 0)::int,
               coalesce(sum(hist[7]), 0)::int,
               coalesce(sum(hist[8]), 0)::int,
               coalesce(sum(hist[9]), 0)::int
             ] AS hist
      FROM api_usage_hourly
      WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours + 24})
      GROUP BY 1
    )
    SELECT to_char(buckets.bucket, 'YYYY-MM-DD"T"HH24:MI') AS at,
           coalesce(req.requests, 0)::int AS requests,
           coalesce(req.server_errors, 0)::int AS server_errors,
           req.max_ms,
           req.hist
    FROM buckets LEFT JOIN req USING (bucket)
    ORDER BY buckets.bucket
  `;

  const routes = await sql`
    SELECT method, route,
           sum(count)::int AS count,
           sum(s5xx)::int AS server_errors,
           sum(s4xx)::int AS client_errors,
           sum(total_ms)::bigint AS total_ms,
           max(max_ms)::int AS max,
           ARRAY[
             coalesce(sum(hist[1]), 0)::int,
             coalesce(sum(hist[2]), 0)::int,
             coalesce(sum(hist[3]), 0)::int,
             coalesce(sum(hist[4]), 0)::int,
             coalesce(sum(hist[5]), 0)::int,
             coalesce(sum(hist[6]), 0)::int,
             coalesce(sum(hist[7]), 0)::int,
             coalesce(sum(hist[8]), 0)::int,
             coalesce(sum(hist[9]), 0)::int
           ] AS hist
    FROM api_usage_hourly
    WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    GROUP BY method, route
    ORDER BY count DESC
    LIMIT 100
  `;

  const statusClasses = await sql`
    SELECT '2xx' AS class, coalesce(sum(s2xx), 0)::int AS count FROM api_usage_hourly WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    UNION ALL
    SELECT '3xx', coalesce(sum(s3xx), 0)::int FROM api_usage_hourly WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    UNION ALL
    SELECT '4xx', coalesce(sum(s4xx), 0)::int FROM api_usage_hourly WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
    UNION ALL
    SELECT '5xx', coalesce(sum(s5xx), 0)::int FROM api_usage_hourly WHERE hour >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${hours})
  `;

  res.json({
    hours,
    unit,
    summary: {
      total: summary.total,
      serverErrors: summary.server_errors,
      clientErrors: summary.client_errors,
      p50: percentileFromHist(summary.hist, 50, summary.max_ms),
      p95: percentileFromHist(summary.hist, 95, summary.max_ms),
    },
    series: series.map((s) => ({
      at: s.at,
      requests: s.requests,
      serverErrors: s.server_errors,
      p95: s.hist ? percentileFromHist(s.hist, 95, s.max_ms) : 0,
    })),
    routes: routes.map((r) => ({
      method: r.method,
      route: r.route,
      count: r.count,
      serverErrors: r.server_errors,
      clientErrors: r.client_errors,
      avg: r.count > 0 ? Math.round(Number(r.total_ms) / r.count) : 0,
      p50: percentileFromHist(r.hist, 50, r.max),
      p95: percentileFromHist(r.hist, 95, r.max),
      max: r.max,
    })),
    statusClasses: statusClasses.map((s) => ({ class: s.class, count: s.count })),
  });
});

// ---- Error logs ----

const SOURCES = ['backend', 'web', 'linux', 'windows', 'mobile'] as const;

const errorFilter = (req: Request): SQL | undefined => {
  const source =
    typeof req.query.source === 'string' && (SOURCES as readonly string[]).includes(req.query.source)
      ? req.query.source
      : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  return and(
    source ? eq(errorLogs.source, source) : undefined,
    q ? ilike(errorLogs.message, `%${q.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
  );
};

adminRouter.get('/errors', async (req, res) => {
  const limit = intQuery(req, 'limit', 50, 1, 200);
  const offset = intQuery(req, 'offset', 0, 0, 1_000_000);
  const where = errorFilter(req);

  const [items, [{ total }], bySource] = await Promise.all([
    db.select().from(errorLogs).where(where).orderBy(desc(errorLogs.lastSeenAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(errorLogs).where(where),
    db
      .select({ source: errorLogs.source, groups: count(), events: sum(errorLogs.count).mapWith(Number) })
      .from(errorLogs)
      .groupBy(errorLogs.source),
  ]);
  res.json({ items, total, bySource });
});

adminRouter.delete('/errors/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return fail(res, 400, 'BAD_REQUEST', 'Bad error id');
  const deleted = await db.delete(errorLogs).where(eq(errorLogs.id, id)).returning({ id: errorLogs.id });
  if (deleted.length === 0) return fail(res, 404, 'NOT_FOUND', 'That error is already gone');
  res.status(204).end();
});

/** Clears every error matching the same filters as the list (?source=, ?q=). */
adminRouter.delete('/errors', async (req, res) => {
  const deleted = await db.delete(errorLogs).where(errorFilter(req)).returning({ id: errorLogs.id });
  res.json({ deleted: deleted.length });
});
