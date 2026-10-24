import type { Request, RequestHandler, Response } from 'express';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activityDaily, apiUsageHourly, errorLogs, refreshTokens } from '../db/schema.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { pruneLyricsCache } from './cache.js';
import { pruneCatalogItems } from './catalogMeta.js';
import { prunePlayHistory } from './playHistory.js';

// Telemetry: request-level analytics and error logs. Both are buffered in memory and written in
// batches, so logging never adds a query to the request it describes.

export const CLIENTS = ['web', 'linux', 'windows', 'mobile'] as const;
export type ClientName = (typeof CLIENTS)[number];
export type ErrorSource = 'backend' | ClientName;

// UUID v1–v5 and v7: 8-4-4-4-12 hex with the right version nibble. We accept any version,
// matching the contract ("valid UUID, any version").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isValidInstallId = (v: string | null | undefined): v is string => !!v && UUID_RE.test(v);

const ACTIVITY_RETENTION_DAYS = 400;
const API_USAGE_RETENTION_DAYS = 90;
const ERROR_LOG_DAYS = 90;
const FLUSH_MS = 5_000;
const MAX_PENDING_ERRORS = 500;
const REFRESH_TOKEN_DAYS = 90;

// --- Activity in-memory buffer --------------------------------------------------

// Key: `${day}\x00${actor}\x00${client}\x00${install}` where day is YYYY-MM-DD in ANALYTICS_TIME_ZONE.
// We keep a Set of keys written in the current local day; cleared when the local day ticks over.
// This means each actor costs at most one DB row per day per client.
const activityWritten = new Set<string>();
let activityWrittenDay = ''; // Local calendar date string (YYYY-MM-DD) in ANALYTICS_TIME_ZONE
const MAX_PENDING_ACTIVITY = 5_000;

interface PendingActivity {
  day: string;
  actor: string;
  kind: 'user' | 'guest';
  client: string;
  install: string | null;
}
let pendingActivity: PendingActivity[] = [];

// --- API usage in-memory buffer -------------------------------------------------

// hist bucket upper bounds in ms: 25, 50, 100, 250, 500, 1000, 2500, 5000, ∞
const HIST_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

interface UsageAccum {
  count: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  totalMs: number;
  maxMs: number;
  hist: number[]; // length 9
}

// Key: `${hourIso}\x00${method}\x00${route}`
const pendingUsage = new Map<string, UsageAccum>();
// Guard: if the Map grows past this, the database is falling behind, drop incoming rows.
const MAX_PENDING_USAGE_KEYS = 5_000;

// --- Error buffer (unchanged) ---------------------------------------------------

export interface ErrorReport {
  source: ErrorSource;
  level?: 'error' | 'warning';
  code?: string | null;
  message: string;
  stack?: string | null;
  method?: string | null;
  route?: string | null;
  status?: number | null;
  userId?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown> | null;
}

let pendingErrors = new Map<string, { report: ErrorReport; count: number; at: Date }>();

const truncate = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const clientOf = (req: Request): ClientName | null => {
  const header = req.get('x-sonare-client');
  return (CLIENTS as readonly string[]).includes(header ?? '') ? (header as ClientName) : null;
};

const routePatterns = new Map<string, RegExp>();

/**
 * The route the request matched, as a pattern (`/api/v1/me/playlists/:id`), so requests group
 * by endpoint. req.baseUrl is reset once an error leaves a router, so the mount prefix is
 * rebuilt from the url instead: its tail matched the route's path, and the rest is the prefix.
 */
const routeOf = (req: Request, res: Response): string => {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string') return res.statusCode === 404 ? '(no route)' : '(unrouted)';
  const pathname = req.originalUrl.split('?')[0];
  if (routePath === '/') return pathname.replace(/\/+$/, '') || '/';

  let pattern = routePatterns.get(routePath);
  if (!pattern) {
    const body = routePath
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    pattern = new RegExp(`${body}/?$`);
    routePatterns.set(routePath, pattern);
  }
  const m = pattern.exec(pathname);
  return m ? pathname.slice(0, m.index) + routePath : routePath;
};

/** Local calendar date string (YYYY-MM-DD) in the configured analytics timezone. */
const localDay = (d: Date): string => {
  return d.toLocaleDateString('en-CA', { timeZone: config.ANALYTICS_TIME_ZONE }).replace(/\//g, '-');
};

/** UTC hour-start ISO string `YYYY-MM-DDTHH:00:00.000Z` for use as a Map key. */
const utcHourKey = (d: Date): string => {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h.toISOString();
};

/** Index into hist (0..8) for a given duration. */
const histBucket = (ms: number): number => {
  for (let i = 0; i < HIST_BOUNDS.length; i++) {
    if (ms <= HIST_BOUNDS[i]) return i;
  }
  return 8;
};

/**
 * Estimates a percentile (e.g. 50 for p50, 95 for p95) in milliseconds from a 9-bucket duration histogram.
 * Uses linear interpolation inside the bucket where the cumulative count passes the target count.
 * hist bucket upper bounds: 25, 50, 100, 250, 500, 1000, 2500, 5000, maxMs.
 */
export const percentileFromHist = (
  hist: Array<number | string> | null | undefined,
  percentile: number,
  maxMs?: number,
): number => {
  if (!hist || hist.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < hist.length; i++) {
    total += Number(hist[i]) || 0;
  }
  if (total <= 0) return 0;

  const target = (percentile / 100) * total;
  const upperLast = maxMs && maxMs > 5000 ? maxMs : 10000;
  const ranges: Array<[number, number]> = [
    [0, 25],
    [25, 50],
    [50, 100],
    [100, 250],
    [250, 500],
    [500, 1000],
    [1000, 2500],
    [2500, 5000],
    [5000, upperLast],
  ];

  let cumulative = 0;
  for (let i = 0; i < ranges.length; i++) {
    const count = Number(hist[i]) || 0;
    if (count <= 0) continue;
    const prev = cumulative;
    cumulative += count;
    if (target <= cumulative) {
      const [lower, upper] = ranges[i];
      const fraction = (target - prev) / count;
      return Math.round(lower + fraction * (upper - lower));
    }
  }

  return Math.round(ranges[ranges.length - 1][1]);
};

/**
 * Logs every API request (except CORS preflights and the admin API itself), and records a
 * server error for any 5xx the error handler answered (it leaves the error in res.locals).
 */
export const requestLogger = (): RequestHandler => {
  return (req, res, next) => {
    const start = performance.now();
    // Time to the response headers, not to the last byte: a stream relay stays open for the
    // whole song, and that isn't latency.
    let headersAt: number | undefined;
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: unknown[]) {
      headersAt ??= performance.now();
      return (writeHead as (...a: unknown[]) => Response).apply(this, args);
    } as typeof res.writeHead;

    res.on('close', () => {
      const route = routeOf(req, res);
      const err = res.locals.error;
      if (err && res.statusCode >= 500) {
        recordError({
          source: 'backend',
          code: err.code ?? err.name ?? null,
          message: String(err.message || err),
          stack: err.stack,
          method: req.method,
          route,
          status: res.statusCode,
          userId: req.user?.id,
          userAgent: req.get('user-agent'),
        });
      }

      if (req.method === 'OPTIONS' || req.originalUrl.startsWith('/api/v1/admin')) return;

      const now = new Date();
      const durationMs = Math.round((headersAt ?? performance.now()) - start);
      const status = res.statusCode;
      const method = req.method;
      const installId = req.get('x-sonare-install') ?? null;
      const install = isValidInstallId(installId) ? installId : null;

      // --- activity_daily ---
      // actor = user id (signed in) or install id (guest with valid header)
      const userId = req.user?.id ?? null;
      const actor = userId ?? install;
      if (actor) {
        const day = localDay(now);
        const client = clientOf(req) ?? 'other';
        const kind: 'user' | 'guest' = userId ? 'user' : 'guest';

        // Refresh the per-day set when the ANALYTICS_TIME_ZONE date ticks over.
        if (day !== activityWrittenDay) {
          activityWritten.clear();
          activityWrittenDay = day;
        }

        const installKey = userId ? (install ?? '') : '';
        const key = `${day}\x00${actor}\x00${client}\x00${installKey}`;
        if (!activityWritten.has(key)) {
          if (pendingActivity.length < MAX_PENDING_ACTIVITY) {
            activityWritten.add(key);
            pendingActivity.push({ day, actor, kind, client, install: userId ? install : null });
          }
        }
      }

      // --- api_usage_hourly ---
      if (pendingUsage.size >= MAX_PENDING_USAGE_KEYS) return; // database falling behind
      const hKey = `${utcHourKey(now)}\x00${method}\x00${route}`;
      let acc = pendingUsage.get(hKey);
      if (!acc) {
        acc = { count: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, totalMs: 0, maxMs: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
        pendingUsage.set(hKey, acc);
      }
      acc.count++;
      if (status >= 500) acc.s5xx++;
      else if (status >= 400) acc.s4xx++;
      else if (status >= 300) acc.s3xx++;
      else acc.s2xx++;
      acc.totalMs += durationMs;
      if (durationMs > acc.maxMs) acc.maxMs = durationMs;
      acc.hist[histBucket(durationMs)]++;
    });
    next();
  };
};

export const recordError = (report: ErrorReport): void => {
  const r: ErrorReport = {
    ...report,
    message: truncate(report.message, 2_000) || '(no message)',
    stack: truncate(report.stack, 16_000),
    userAgent: truncate(report.userAgent, 500),
  };
  const key = [r.source, r.code ?? '', r.route ?? '', r.message].join('\u0000');
  const seen = pendingErrors.get(key);
  if (seen) {
    seen.count++;
    seen.report = r;
    seen.at = new Date();
  } else if (pendingErrors.size < MAX_PENDING_ERRORS) {
    pendingErrors.set(key, { report: r, count: 1, at: new Date() });
  }
};

/** Adds to the matching row (same source, code, route and message), or starts a new one. */
const writeError = async ({ report: r, count, at }: { report: ErrorReport; count: number; at: Date }) => {
  const latest = {
    level: r.level ?? 'error',
    stack: r.stack ?? null,
    method: r.method ?? null,
    status: r.status ?? null,
    userId: r.userId ?? null,
    userAgent: r.userAgent ?? null,
    context: r.context ?? null,
    lastSeenAt: at,
  };
  const updated = await db
    .update(errorLogs)
    .set({ ...latest, count: sql`${errorLogs.count} + ${count}` })
    .where(
      and(
        eq(errorLogs.source, r.source),
        eq(errorLogs.message, r.message),
        sql`${errorLogs.code} IS NOT DISTINCT FROM ${r.code ?? null}`,
        sql`${errorLogs.route} IS NOT DISTINCT FROM ${r.route ?? null}`,
      ),
    )
    .returning({ id: errorLogs.id });
  if (updated.length === 0) {
    await db.insert(errorLogs).values({
      ...latest,
      source: r.source,
      code: r.code ?? null,
      message: r.message,
      route: r.route ?? null,
      count,
      firstSeenAt: at,
    });
  }
};

let flushing: Promise<void> | null = null;

const CHUNK_SIZE = 500;

const writePending = async (): Promise<void> => {
  const activity = pendingActivity;
  const usage = [...pendingUsage.entries()];
  const errors = [...pendingErrors.values()];
  pendingActivity = [];
  pendingUsage.clear();
  pendingErrors = new Map();

  try {
    // Flush activity rows in chunks of 500:
    // Deduplicate within the flush batch by (day, actor, client) so Postgres does not hit
    // "ON CONFLICT DO UPDATE command cannot affect row a second time", preserving non-null install.
    if (activity.length > 0) {
      const dedupedActivity = new Map<string, PendingActivity>();
      for (const row of activity) {
        const pk = `${row.day}\x00${row.actor}\x00${row.client}`;
        const existing = dedupedActivity.get(pk);
        if (!existing) {
          dedupedActivity.set(pk, { ...row });
        } else if (!existing.install && row.install) {
          existing.install = row.install;
        }
      }
      const activityRows = [...dedupedActivity.values()];

      for (let i = 0; i < activityRows.length; i += CHUNK_SIZE) {
        const chunk = activityRows.slice(i, i + CHUNK_SIZE);
        await db
          .insert(activityDaily)
          .values(chunk)
          .onConflictDoUpdate({
            target: [activityDaily.day, activityDaily.actor, activityDaily.client],
            set: {
              install: sql`COALESCE(${activityDaily.install}, excluded.install)`,
            },
          });
      }
    }

    // Flush api usage: upsert in chunks of 500, adding counts to whatever is already in the DB.
    if (usage.length > 0) {
      const usageRows = usage.map(([hKey, acc]) => {
        const [hourIso, method, route] = hKey.split('\x00');
        return {
          hour: new Date(hourIso),
          method,
          route,
          count: acc.count,
          s2xx: acc.s2xx,
          s3xx: acc.s3xx,
          s4xx: acc.s4xx,
          s5xx: acc.s5xx,
          totalMs: acc.totalMs,
          maxMs: acc.maxMs,
          hist: acc.hist,
        };
      });

      for (let i = 0; i < usageRows.length; i += CHUNK_SIZE) {
        const chunk = usageRows.slice(i, i + CHUNK_SIZE);
        await db
          .insert(apiUsageHourly)
          .values(chunk)
          .onConflictDoUpdate({
            target: [apiUsageHourly.hour, apiUsageHourly.method, apiUsageHourly.route],
            set: {
              count: sql`${apiUsageHourly.count}   + excluded.count`,
              s2xx: sql`${apiUsageHourly.s2xx}    + excluded.s2xx`,
              s3xx: sql`${apiUsageHourly.s3xx}    + excluded.s3xx`,
              s4xx: sql`${apiUsageHourly.s4xx}    + excluded.s4xx`,
              s5xx: sql`${apiUsageHourly.s5xx}    + excluded.s5xx`,
              totalMs: sql`${apiUsageHourly.totalMs} + excluded.total_ms`,
              maxMs: sql`GREATEST(${apiUsageHourly.maxMs}, excluded.max_ms)`,
              // Element-wise array addition for the histogram.
              hist: sql`ARRAY[
                ${apiUsageHourly.hist}[1] + excluded.hist[1],
                ${apiUsageHourly.hist}[2] + excluded.hist[2],
                ${apiUsageHourly.hist}[3] + excluded.hist[3],
                ${apiUsageHourly.hist}[4] + excluded.hist[4],
                ${apiUsageHourly.hist}[5] + excluded.hist[5],
                ${apiUsageHourly.hist}[6] + excluded.hist[6],
                ${apiUsageHourly.hist}[7] + excluded.hist[7],
                ${apiUsageHourly.hist}[8] + excluded.hist[8],
                ${apiUsageHourly.hist}[9] + excluded.hist[9]
              ]`,
            },
          });
      }
    }

    for (const e of errors) await writeError(e);
  } catch (err) {
    // Not recorded as an error log: that write would most likely fail the same way.
    logger.warn({ err }, 'Telemetry: could not write logs');
  }
};

/** Writes whatever is buffered. Safe to call at any time; overlapping calls share one flush. */
export const flushTelemetry = (): Promise<void> => {
  // Cleared in .finally(), which always runs after this assignment - even when there was
  // nothing to write and writePending() finished without awaiting anything.
  flushing ??= writePending().finally(() => {
    flushing = null;
  });
  return flushing;
};

export const _resetTelemetryStateForTesting = (): void => {
  activityWritten.clear();
  activityWrittenDay = '';
  pendingActivity = [];
  pendingUsage.clear();
  pendingErrors = new Map();
};

const prune = async () => {
  try {
    const utcNow = sql`(now() AT TIME ZONE 'UTC')`;
    await db
      .delete(activityDaily)
      .where(lt(activityDaily.day, sql`(${utcNow} - make_interval(days => ${ACTIVITY_RETENTION_DAYS}))::date`));
    await db
      .delete(apiUsageHourly)
      .where(lt(apiUsageHourly.hour, sql`${utcNow} - make_interval(days => ${API_USAGE_RETENTION_DAYS})`));
    await db
      .delete(errorLogs)
      .where(lt(errorLogs.lastSeenAt, sql`${utcNow} - make_interval(days => ${ERROR_LOG_DAYS})`));
  } catch (err) {
    logger.warn({ err }, 'Telemetry: could not prune old logs');
  }
};

export const pruneRefreshTokens = async () => {
  try {
    const utcNow = sql`(now() AT TIME ZONE 'UTC')`;
    await db
      .delete(refreshTokens)
      .where(
        or(
          eq(refreshTokens.revoked, true),
          lt(refreshTokens.createdAt, sql`${utcNow} - make_interval(days => ${REFRESH_TOKEN_DAYS})`),
        ),
      );
  } catch (err) {
    logger.warn({ err }, 'Telemetry: could not prune refresh tokens');
  }
};

let started = false;

export const startTelemetry = (): void => {
  if (started) return;
  started = true;
  setInterval(() => void flushTelemetry(), FLUSH_MS).unref();
  void prune();
  setInterval(() => void prune(), 3600_000).unref();
  void pruneRefreshTokens();
  setInterval(() => void pruneRefreshTokens(), 6 * 3600_000).unref();
  void pruneLyricsCache();
  setInterval(() => void pruneLyricsCache(), 6 * 3600_000).unref();
  void prunePlayHistory();
  setInterval(() => void prunePlayHistory(), 6 * 3600_000).unref();
  void pruneCatalogItems();
  setInterval(() => void pruneCatalogItems(), 6 * 3600_000).unref();

  // Recorded, then the process still exits as it would have without these handlers.
  const crash = (code: string) => (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err }, code);
    recordError({ source: 'backend', code, message: err.message, stack: err.stack });
    setTimeout(() => process.exit(1), 3_000).unref();
    void flushTelemetry().finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('UNCAUGHT_EXCEPTION'));
  process.on('unhandledRejection', crash('UNHANDLED_REJECTION'));
};
