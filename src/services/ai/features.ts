import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { playHistory } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { getCatalogItems, parseTrackMeta, type TrackMeta } from '../catalogMeta.js';
import { isRedisAvailable, redis } from '../cache.js';
import type { AiPick, AiPlaylistDraft, AiSearchPlan, AiYouMayLike } from '../../shared/apiTypes.js';
import { askAiJson } from './llm.js';

// What the AI is asked for. Answers are song names only; the apps look the songs up with their
// own search (sonare-frontend/shared/ai/resolvePicks.ts), so this works while Piped is down.
// Render's Key Value is 25 MB, so only these small answers are cached, never tracks or prompts.

const YMAL_TTL = 12 * 3600;
const SEARCH_TTL = 7 * 24 * 3600;
/** Fewer named plays than this and there's nothing to go on. */
export const YMAL_MIN_PLAYS = 5;

const cacheGet = async <T>(key: string): Promise<T | null> => {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const cacheSet = async (key: string, value: unknown, ttlSec: number): Promise<void> => {
  if (!isRedisAvailable()) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch (err) {
    logger.warn({ err }, 'AI: could not cache an answer');
  }
};

const text = (max: number) => z.string().trim().min(1).max(max);
const pickSchema = z.object({
  title: z.string(),
  artist: z.string(),
  reason: z.string().optional().nullable(),
});

const songKey = (title: string, artist: string) => `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;

/** Trimmed, sensible, each song once, at most `max`. */
const cleanPicks = (raw: z.infer<typeof pickSchema>[], max: number, skip = new Set<string>()): AiPick[] => {
  const seen = new Set(skip);
  const out: AiPick[] = [];
  for (const p of raw) {
    const title = p.title.trim().slice(0, 200);
    const artist = p.artist.trim().slice(0, 200);
    if (!title || !artist) continue;
    const key = songKey(title, artist);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = p.reason?.trim().slice(0, 80);
    out.push(reason ? { title, artist, reason } : { title, artist });
    if (out.length >= max) break;
  }
  return out;
};

// ---- What the user listens to ----

interface ListenedSong {
  title: string;
  artist: string;
  plays: number;
}

export interface Listening {
  /** Most played first. */
  songs: ListenedSong[];
  /** Most played artists first. */
  artists: string[];
  /** Newest first, each song once. */
  recent: ListenedSong[];
  namedPlays: number;
}

/** From the user's play history (its newest 1000 plays: that's all that is kept). */
export const readListening = async (userId: string): Promise<Listening> => {
  const rows = await db
    .select({ id: playHistory.trackRefId, meta: playHistory.meta })
    .from(playHistory)
    .where(and(eq(playHistory.userId, userId), eq(playHistory.trackRefKind, 'server')))
    .orderBy(desc(playHistory.playedAt))
    .limit(1000);

  const names = new Map<string, TrackMeta>();
  for (const r of rows) {
    const meta = parseTrackMeta(r.meta);
    if (meta?.title && !names.has(r.id)) names.set(r.id, meta);
  }
  const unnamed = [...new Set(rows.map((r) => r.id).filter((id) => !names.has(id)))];
  if (unnamed.length > 0) {
    const stored = await getCatalogItems<TrackMeta>('track', unnamed);
    for (const id of unnamed) {
      const meta = stored.get(id);
      if (meta?.title) names.set(id, meta);
    }
  }

  const songs = new Map<string, ListenedSong>();
  const artists = new Map<string, number>();
  const recent: ListenedSong[] = [];
  let namedPlays = 0;
  for (const r of rows) {
    const meta = names.get(r.id);
    if (!meta) continue;
    namedPlays += 1;
    const song = songs.get(r.id) ?? { title: meta.title, artist: meta.artist, plays: 0 };
    song.plays += 1;
    if (song.plays === 1) {
      songs.set(r.id, song);
      if (recent.length < 10) recent.push(song);
    }
    if (meta.artist) artists.set(meta.artist, (artists.get(meta.artist) ?? 0) + 1);
  }
  return {
    // A stable sort keeps the more recently played first among equal counts.
    songs: [...songs.values()].sort((a, b) => b.plays - a.plays),
    artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    recent,
    namedPlays,
  };
};

const songLine = (s: ListenedSong) => `${s.title} — ${s.artist}`;

// ---- You may like ----

const ymalSchema = z.object({ picks: z.array(pickSchema) });
const ymalKey = (userId: string) => `ai:ymal:${userId}`;
const generating = new Map<string, Promise<AiYouMayLike>>();

export const cachedYouMayLike = (userId: string) => cacheGet<AiYouMayLike>(ymalKey(userId));

/** Asks the AI (the route checks the cache and the rate limit first). One generation per user at a time. */
export const generateYouMayLike = (userId: string): Promise<AiYouMayLike> => {
  const running = generating.get(userId);
  if (running) return running;
  const job = (async (): Promise<AiYouMayLike> => {
    const listening = await readListening(userId);
    const basedOn = listening.artists.slice(0, 3);
    if (listening.namedPlays < YMAL_MIN_PLAYS) return { picks: [], basedOn: [], generatedAt: Date.now() };

    const top = listening.songs.slice(0, 15);
    const listed = new Set([...top, ...listening.recent].map((s) => songKey(s.title, s.artist)));
    const user = [
      "The listener's most played songs:",
      ...top.map((s, i) => `${i + 1}. ${songLine(s)} (${s.plays} plays)`),
      `Most played artists: ${listening.artists.slice(0, 8).join(', ')}`,
      `Recently played: ${listening.recent.map(songLine).join('; ')}`,
      '',
      'Suggest 20 songs they will probably like that are NOT in the lists above. Mix more songs by',
      'the artists they love with similar artists they may not know yet. Only real, released songs',
      'that are on YouTube Music. Keep to the languages they listen to. For each, a reason of at',
      'most 8 words, like "Because you play Arijit Singh".',
      'Answer as: {"picks":[{"title":"...","artist":"...","reason":"..."}]}',
    ].join('\n');

    const picks = await askAiJson(
      'you-may-like',
      { system: 'You recommend music. Answer with JSON only, no other text.', user, maxTokens: 1500, temperature: 0.8 },
      ymalSchema,
      (v) => {
        const clean = cleanPicks(v.picks, 20, listed);
        return clean.length > 0 ? clean : null;
      },
    );
    const answer: AiYouMayLike = { picks, basedOn, generatedAt: Date.now() };
    await cacheSet(ymalKey(userId), answer, YMAL_TTL);
    return answer;
  })().finally(() => generating.delete(userId));
  generating.set(userId, job);
  return job;
};

// ---- Search plan ----

const searchSchema = z.object({
  summary: z.string().optional().nullable(),
  queries: z.array(z.string()),
});
const searchKey = (q: string) => `ai:search:${crypto.createHash('sha1').update(q.trim().toLowerCase()).digest('hex')}`;

export const cachedSearchPlan = (q: string) => cacheGet<AiSearchPlan>(searchKey(q));

export const generateSearchPlan = async (q: string): Promise<AiSearchPlan> => {
  const user = [
    `Request: ${JSON.stringify(q.trim())}`,
    'Give 1 to 4 YouTube Music searches that would find the songs this person wants, best first.',
    'Prefer specific "song title artist" searches; use an artist with a mood or genre only when no',
    'particular songs fit. Also a summary: one short line saying what they asked for.',
    'Answer as: {"summary":"...","queries":["...","..."]}',
  ].join('\n');
  const plan = await askAiJson(
    'search',
    {
      system: 'You turn a music request into YouTube Music searches. Answer with JSON only, no other text.',
      user,
      maxTokens: 400,
      temperature: 0.4,
    },
    searchSchema,
    (v): AiSearchPlan | null => {
      const seen = new Set<string>();
      const queries = v.queries
        .map((x) => x.trim().slice(0, 100))
        .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
        .slice(0, 4);
      if (queries.length === 0) return null;
      const summary = v.summary?.trim().slice(0, 140);
      return summary ? { queries, summary } : { queries };
    },
  );
  await cacheSet(searchKey(q), plan, SEARCH_TTL);
  return plan;
};

// ---- Playlist draft ----

const playlistSchema = z.object({
  name: text(200),
  description: z.string().optional().nullable(),
  picks: z.array(pickSchema),
});

export const generatePlaylistDraft = async (
  userId: string,
  prompt: string,
  count: number,
): Promise<AiPlaylistDraft> => {
  const taste = (await readListening(userId)).artists.slice(0, 5);
  const user = [
    `Make a playlist for this request: ${JSON.stringify(prompt.trim())}`,
    ...(taste.length > 0
      ? [`The listener mostly plays: ${taste.join(', ')}. Lean towards their taste only where the request leaves room.`]
      : []),
    `Give ${count} real, released songs that are on YouTube Music, no repeats, in a good listening`,
    'order, a playlist name of 2 to 5 words and a one-sentence description.',
    'Answer as: {"name":"...","description":"...","picks":[{"title":"...","artist":"..."}]}',
  ].join('\n');
  return askAiJson(
    'playlist',
    {
      system: 'You are a music curator. Answer with JSON only, no other text.',
      user,
      maxTokens: count * 40 + 300,
      temperature: 0.8,
    },
    playlistSchema,
    (v): AiPlaylistDraft | null => {
      const picks = cleanPicks(v.picks, count).map(({ title, artist }) => ({ title, artist }));
      if (picks.length < 3) return null;
      return { name: v.name.slice(0, 100), description: (v.description ?? '').trim().slice(0, 500), picks };
    },
  );
};
