import { Router } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../rateLimit.js';
import { CLIENTS, recordError } from '../telemetry.js';

// Crash and error reports from the apps. Public (guests crash too), so it is rate limited
// per IP and every field is capped.
export const clientErrorsRouter = Router();

const limiter = createRateLimiter({ max: 30, windowMs: 60_000 });

const reportSchema = z.object({
  source: z.enum(CLIENTS),
  level: z.enum(['error', 'warning']).default('error'),
  message: z.string().trim().min(1).max(2_000),
  stack: z.string().max(16_000).optional(),
  /** The app screen or page the error happened on. */
  page: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
  context: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine(c => Object.keys(c).length <= 20, 'At most 20 context fields')
    .optional(),
});

clientErrorsRouter.post('/', (req, res) => {
  const limit = limiter.hit(req.ip ?? 'unknown');
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many error reports' } });
    return;
  }

  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid report' } });
    return;
  }

  const r = parsed.data;
  recordError({
    source: r.source,
    level: r.level,
    message: r.message,
    stack: r.stack,
    userId: req.user?.id,
    userAgent: req.get('user-agent'),
    context: { ...r.context, page: r.page ?? null, appVersion: r.appVersion ?? null },
  });
  res.status(204).end();
});
