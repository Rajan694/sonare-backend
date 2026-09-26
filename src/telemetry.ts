import type { Request, RequestHandler, Response } from 'express';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { errorLogs, requestLogs } from './db/schema.js';

// Request logs and error logs for the admin page. Both are buffered in memory and written in
// batches, so logging never adds a query to the request it describes.
//
// Timestamps are written from JS, which drizzle stores as UTC in these `timestamp` columns.
// (A column left to defaultNow() gets the database session's local time instead.)

export const CLIENTS = ['web', 'linux', 'mobile'] as const;
export type ClientName = typeof CLIENTS[number];
export type ErrorSource = 'backend' | ClientName;

const REQUEST_LOG_DAYS = 30;
const ERROR_LOG_DAYS = 90;
const FLUSH_MS = 5_000;
const MAX_PENDING_REQUESTS = 5_000;
const MAX_PENDING_ERRORS = 500;

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

let pendingRequests: (typeof requestLogs.$inferInsert)[] = [];
// Keyed by what makes two errors "the same" (see the grouping in writeError), so a burst of
// one error is a single write with a count.
let pendingErrors = new Map<string, { report: ErrorReport; count: number; at: Date }>();

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function clientOf(req: Request): ClientName | null {
  const header = req.get('x-sonare-client');
  return (CLIENTS as readonly string[]).includes(header ?? '') ? header as ClientName : null;
}

const routePatterns = new Map<string, RegExp>();

/**
 * The route the request matched, as a pattern (`/api/v1/me/playlists/:id`), so requests group
 * by endpoint. req.baseUrl is reset once an error leaves a router, so the mount prefix is
 * rebuilt from the url instead: its tail matched the route's path, and the rest is the prefix.
 */
function routeOf(req: Request, res: Response): string {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string') return res.statusCode === 404 ? '(no route)' : '(unrouted)';
  const pathname = req.originalUrl.split('?')[0];
  if (routePath === '/') return pathname.replace(/\/+$/, '') || '/';

  let pattern = routePatterns.get(routePath);
  if (!pattern) {
    const body = routePath.split('/')
      .map(seg => seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('/');
    pattern = new RegExp(`${body}/?$`);
    routePatterns.set(routePath, pattern);
  }
  const m = pattern.exec(pathname);
  return m ? pathname.slice(0, m.index) + routePath : routePath;
}

/**
 * Logs every API request (except CORS preflights and the admin API itself), and records a
 * server error for any 5xx the error handler answered (it leaves the error in res.locals).
 */
export function requestLogger(): RequestHandler {
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
      if (pendingRequests.length >= MAX_PENDING_REQUESTS) return; // the database is falling behind
      pendingRequests.push({
        at: new Date(),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round((headersAt ?? performance.now()) - start),
        userId: req.user?.id ?? null,
        client: clientOf(req),
      });
    });
    next();
  };
}

export function recordError(report: ErrorReport): void {
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
}

/** Adds to the matching row (same source, code, route and message), or starts a new one. */
async function writeError({ report: r, count, at }: { report: ErrorReport; count: number; at: Date }) {
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
  const updated = await db.update(errorLogs)
    .set({ ...latest, count: sql`${errorLogs.count} + ${count}` })
    .where(and(
      eq(errorLogs.source, r.source),
      eq(errorLogs.message, r.message),
      sql`${errorLogs.code} IS NOT DISTINCT FROM ${r.code ?? null}`,
      sql`${errorLogs.route} IS NOT DISTINCT FROM ${r.route ?? null}`,
    ))
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
}

let flushing: Promise<void> | null = null;

async function writePending(): Promise<void> {
  const requests = pendingRequests;
  const errors = [...pendingErrors.values()];
  pendingRequests = [];
  pendingErrors = new Map();
  try {
    for (let i = 0; i < requests.length; i += 1_000) {
      await db.insert(requestLogs).values(requests.slice(i, i + 1_000));
    }
    for (const e of errors) await writeError(e);
  } catch (err: any) {
    // Not recorded as an error log: that write would most likely fail the same way.
    console.warn('[telemetry] could not write logs:', err.message);
  }
}

/** Writes whatever is buffered. Safe to call at any time; overlapping calls share one flush. */
export function flushTelemetry(): Promise<void> {
  // Cleared in .finally(), which always runs after this assignment - even when there was
  // nothing to write and writePending() finished without awaiting anything.
  flushing ??= writePending().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function prune() {
  try {
    const utcNow = sql`(now() AT TIME ZONE 'UTC')`;
    await db.delete(requestLogs).where(lt(requestLogs.at, sql`${utcNow} - make_interval(days => ${REQUEST_LOG_DAYS})`));
    await db.delete(errorLogs).where(lt(errorLogs.lastSeenAt, sql`${utcNow} - make_interval(days => ${ERROR_LOG_DAYS})`));
  } catch (err: any) {
    console.warn('[telemetry] could not prune old logs:', err.message);
  }
}

let started = false;

export function startTelemetry(): void {
  if (started) return;
  started = true;
  setInterval(() => void flushTelemetry(), FLUSH_MS).unref();
  void prune();
  setInterval(() => void prune(), 3600_000).unref();

  // Recorded, then the process still exits as it would have without these handlers.
  const crash = (code: string) => (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error(err);
    recordError({ source: 'backend', code, message: err.message, stack: err.stack });
    setTimeout(() => process.exit(1), 3_000).unref();
    void flushTelemetry().finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('UNCAUGHT_EXCEPTION'));
  process.on('unhandledRejection', crash('UNHANDLED_REJECTION'));
}
