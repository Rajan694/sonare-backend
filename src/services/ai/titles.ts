import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { isRedisAvailable, redis } from '../cache.js';
import { addTitleFixes, takePendingTitles, type PendingTitle } from '../../shared/catalog/titleFixes.js';
import type { AiTitleFix } from '../../shared/apiTypes.js';
import { askAiJson } from './llm.js';
import { aiAvailable } from './providers.js';

// Cleaner titles for messy YouTube uploads (POST /ai/titles). The apps send the songs whose titles
// look messy; known answers come back at once, the rest queue up and are worked out here in
// batches of 25 (one AI call each), so the apps get them when they ask again. The backend's own
// normalizers note messy songs in the same registry (shared/catalog/titleFixes.ts) and are fed too.

const TITLE_TTL = 30 * 24 * 3600;
const BATCH = 25;
const MAX_QUEUE = 1000;
const TICK_MS = 10_000;
const NOW_TIMEOUT_MS = 20_000;

/** Answers kept in memory too, for when Redis is down or slow. */
const known = new LRUCache<string, AiTitleFix>({ max: 20_000 });
/** Songs the AI was asked about and gave no answer for: not asked again for a while. */
const unanswered = new LRUCache<string, true>({ max: 20_000, ttl: 6 * 3600_000 });
const queue = new Map<string, PendingTitle>();

const titleKey = (id: string) => `ai:title:${id}`;

const remember = (fixes: Record<string, AiTitleFix>) => {
  for (const [id, fix] of Object.entries(fixes)) known.set(id, fix);
  addTitleFixes(fixes);
};

/** The fixes already worked out for these songs; the others are queued (while AI is up). */
export const lookupTitleFixes = async (items: PendingTitle[]): Promise<Record<string, AiTitleFix>> => {
  const fixes: Record<string, AiTitleFix> = {};
  const missing: PendingTitle[] = [];
  for (const item of items) {
    const fix = known.get(item.id);
    if (fix) fixes[item.id] = fix;
    else missing.push(item);
  }

  if (missing.length > 0 && isRedisAvailable()) {
    try {
      const values = await redis.mget(...missing.map((i) => titleKey(i.id)));
      values.forEach((raw, index) => {
        if (!raw) return;
        const fix = JSON.parse(raw) as AiTitleFix;
        if (fix?.title) fixes[missing[index].id] = fix;
      });
    } catch (err) {
      logger.warn({ err }, 'AI: could not read stored titles');
    }
  }

  const found = Object.fromEntries(Object.entries(fixes).filter(([id]) => !known.has(id)));
  remember(found);

  if (aiAvailable()) {
    for (const item of missing) {
      if (fixes[item.id] || unanswered.has(item.id) || queue.has(item.id)) continue;
      if (queue.size >= MAX_QUEUE) queue.delete(queue.keys().next().value as string);
      queue.set(item.id, item);
    }
  }
  return fixes;
};

export const queuedTitleCount = (): number => queue.size;

const answerSchema = z.object({
  fixes: z.array(z.object({ id: z.string(), title: z.string(), artist: z.string() })),
});

const PROMPT = [
  "For each upload below, give the song's real title and its main artist(s).",
  '- title: just the song name. Drop channel and label names (T-Series, Sony Music, Zee Music, YRF, ...),',
  '  movie or album names, "Official Video", "Lyrical", "Full Song", "Audio", hashtags and "feat." credits.',
  '- artist: the singer(s) or band, comma-separated; not the label or the channel.',
  '- For long formats (kathas, bhajans, kirtans, satsangs, pravachans, podcasts, episodes, live sessions, long mixes):',
  '  keep the series name and the part/day/episode (e.g. "Shri Ram Katha · Day 3"), artist = the speaker/singer/host',
  '  (not the channel/label when they differ), drop places, years, hashtags and channel names, and keep every title at most 60 characters.',
  '- Keep the original language and script. If you are not sure, keep the given title and artist.',
  'Answer as: {"fixes":[{"id":"...","title":"...","artist":"..."}]}',
].join('\n');

/** Sends a batch of up to 25 items to the AI, stores answers in memory and Redis, and marks unanswered items. */
const askTitles = async (batch: PendingTitle[]): Promise<Record<string, AiTitleFix>> => {
  const ids = new Set(batch.map((i) => i.id));
  const uploads = batch.map((i) => ({ id: i.id, title: i.title, uploader: i.artist }));
  try {
    const answered = await askAiJson(
      'titles',
      {
        system: 'You turn YouTube video titles into song names. Answer with JSON only, no other text.',
        user: `${PROMPT}\nUploads (JSON): ${JSON.stringify(uploads)}`,
        maxTokens: batch.length * 60 + 200,
        temperature: 0.2,
      },
      answerSchema,
      (v) => {
        const fixes: Record<string, AiTitleFix> = {};
        for (const f of v.fixes) {
          const title = f.title.trim();
          const artist = f.artist.trim();
          if (!ids.has(f.id) || !title || title.length > 200 || artist.length > 200) continue;
          fixes[f.id] = { title, artist };
        }
        return fixes;
      },
    );

    remember(answered);
    if (isRedisAvailable() && Object.keys(answered).length > 0) {
      const pipeline = redis.pipeline();
      for (const [id, fix] of Object.entries(answered))
        pipeline.set(titleKey(id), JSON.stringify(fix), 'EX', TITLE_TTL);
      await pipeline.exec().catch((err) => logger.warn({ err }, 'AI: could not store titles'));
    }
    for (const id of ids) {
      if (!answered[id]) unanswered.set(id, true);
    }
    return answered;
  } catch (err) {
    logger.debug({ err }, 'AI: title batch failed');
    return {};
  }
};

let busy = false;

/** One batch: the backend's own noted songs join the queue, then up to 25 go to the AI. */
export const runTitleBatch = async (): Promise<number> => {
  if (busy || !aiAvailable()) return 0;
  busy = true;
  try {
    const own = takePendingTitles(BATCH);
    if (own.length > 0) await lookupTitleFixes(own);

    const batch = [...queue.values()].slice(0, BATCH);
    if (batch.length === 0) return 0;
    for (const item of batch) queue.delete(item.id);

    const answered = await askTitles(batch);
    return Object.keys(answered).length;
  } catch (err) {
    // AI unavailable: the apps ask again later, and the songs queue up again then.
    logger.debug({ err }, 'AI: title batch failed');
    return 0;
  } finally {
    busy = false;
  }
};

/**
 * Resolves title fixes immediately (POST /ai/titles with wait: true).
 * Looks up known fixes, then asks the AI for the missing ones in parallel batches of 25.
 * Overall timeout ~20 s: whatever is answered by then is returned; the rest stays queued.
 */
export const titleFixesNow = async (items: PendingTitle[]): Promise<Record<string, AiTitleFix>> => {
  const fixes = await lookupTitleFixes(items);
  if (!aiAvailable()) return fixes;

  const missing = items.filter((i) => !fixes[i.id]);
  if (missing.length === 0) return fixes;
  // lookupTitleFixes queued them for the worker; asked here, so the worker shouldn't ask again.
  for (const item of missing) queue.delete(item.id);

  const batches: PendingTitle[][] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    batches.push(missing.slice(i, i + BATCH));
  }

  await Promise.race([
    Promise.allSettled(
      batches.map(async (batch) => {
        const answered = await askTitles(batch);
        for (const [id, fix] of Object.entries(answered)) {
          fixes[id] = fix;
        }
      }),
    ),
    new Promise((resolve) => setTimeout(resolve, NOW_TIMEOUT_MS).unref()),
  ]);

  return fixes;
};

let started = false;

export const startTitlesWorker = (): void => {
  if (started) return;
  started = true;
  setInterval(() => void runTitleBatch(), TICK_MS).unref();
};

/** Tests only. */
export const resetTitleWorker = (): void => {
  known.clear();
  unanswered.clear();
  queue.clear();
};
