import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseQuery } from '../validation.js';
import { AiUnavailableError } from '../errors.js';
import { aiAvailable } from '../services/ai/providers.js';
import {
  cachedSearchPlan,
  cachedYouMayLike,
  generatePlaylistDraft,
  generateSearchPlan,
  generateYouMayLike,
} from '../services/ai/features.js';
import { lookupTitleFixes } from '../services/ai/titles.js';

// The apps' AI features (forReference/ai-briefs/CONTRACT.md in the root repo). The apps hide them
// while /app-config says `ai: false` or a call answers 503 AI_UNAVAILABLE.
export const aiRouter = Router();

// Free tiers have small daily quotas: only calls that reach the AI count.
const ymalLimiter = createRateLimiter({ name: 'ai-ymal', max: 20, windowMs: 3600_000 });
const searchLimiter = createRateLimiter({ name: 'ai-search', max: 30, windowMs: 3600_000 });
const playlistLimiter = createRateLimiter({ name: 'ai-playlist', max: 10, windowMs: 3600_000 });
const titlesLimiter = createRateLimiter({ name: 'ai-titles', max: 120, windowMs: 10 * 60_000 });

const rateLimited = (res: Response, retryAfterSec: number) => {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: `Too many AI requests. Try again in ${Math.ceil(retryAfterSec / 60)} min.`,
    },
  });
};

/** Before asking the AI: none up means no call at all. */
const requireAi = () => {
  if (!aiAvailable()) throw new AiUnavailableError();
};

aiRouter.get('/me/ai/you-may-like', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const cached = await cachedYouMayLike(userId);
  if (cached) return res.json(cached);
  requireAi();
  const limit = await ymalLimiter.hit(userId);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);
  res.json(await generateYouMayLike(userId));
});

const searchQuery = z.object({
  q: z
    .string({ required_error: 'Missing query parameter: q', invalid_type_error: 'Missing query parameter: q' })
    .trim()
    .min(2, 'Search text must be at least 2 characters')
    .max(200, 'Search text must be at most 200 characters'),
});

aiRouter.get('/ai/search', requireAuth, async (req, res) => {
  const { q } = parseQuery(searchQuery, req);
  const cached = await cachedSearchPlan(q);
  if (cached) return res.json(cached);
  requireAi();
  const limit = await searchLimiter.hit(req.user!.id);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);
  res.json(await generateSearchPlan(q));
});

const playlistBody = z.object({
  prompt: z
    .string({ required_error: 'Describe the playlist', invalid_type_error: 'Describe the playlist' })
    .trim()
    .min(3, 'Describe the playlist in a few more words')
    .max(300, 'Keep the description under 300 characters'),
  count: z.number().int().min(10).max(40).default(25),
});

aiRouter.post('/me/ai/playlist', requireAuth, async (req, res) => {
  const { prompt, count } = parseBody(playlistBody, req);
  requireAi();
  const limit = await playlistLimiter.hit(req.user!.id);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);
  res.json(await generatePlaylistDraft(req.user!.id, prompt, count));
});

const titlesBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{6,20}$/, 'id must be a YouTube video id'),
        title: z.string().trim().min(1).max(300),
        artist: z.string().trim().max(200),
      }),
    )
    .min(1, 'Send at least one song')
    .max(50, 'At most 50 songs at a time'),
});

// Signed-in or not (guests see titles too). Answers what is known; never a 503.
aiRouter.post('/ai/titles', async (req, res) => {
  const { items } = parseBody(titlesBody, req);
  const limit = await titlesLimiter.hit(req.ip ?? 'unknown');
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);
  res.json({ fixes: await lookupTitleFixes(items) });
});
