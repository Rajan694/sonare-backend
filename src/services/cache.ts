import type { ResolvedLyrics } from './lyrics.js';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { Piped } from '../upstream/piped.js';
import * as T from '../upstream/piped.types.js';
import { logger } from '../logger.js';
import { db } from '../db/index.js';
import { lyricsCache, waveforms } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export const TTL = {
  search: 5 * 60, // seconds for Redis
  suggestions: 60 * 60,
  trending: 30 * 60,
  albumDetail: 6 * 60 * 60,
  artistDetail: 12 * 60 * 60,
  streamsMeta: 60 * 60,
};

// Most Piped lookups a single request may have in flight. A cold Library page would otherwise
// fire dozens of extractions at once, and YouTube flags bursting IPs.
export const PIPED_LOOKUP_CONCURRENCY = 4;

let redisAvailable = false;
let loggedRedisError = false;

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  retryStrategy(times: number) {
    if (times > 3) return null; // stop reconnecting aggressively
    return Math.min(times * 200, 1000);
  },
  keyPrefix: 'sonare:',
  lazyConnect: true,
});

// Non-blocking connection attempt
redis
  .connect()
  .then(() => {
    redisAvailable = true;
  })
  .catch(() => {
    if (!loggedRedisError) {
      logger.warn({ redisUrl: config.REDIS_URL }, 'Cache: Redis unreachable, passing requests through uncached');
      loggedRedisError = true;
    }
  });

redis.on('error', () => {
  redisAvailable = false;
  if (!loggedRedisError) {
    logger.warn('Cache: Redis connection lost, passing requests through uncached');
    loggedRedisError = true;
  }
});

redis.on('ready', () => {
  redisAvailable = true;
  loggedRedisError = false;
});

export const isRedisAvailable = (): boolean => {
  return redisAvailable;
};

export { redis };

const getCached = async <T>(key: string): Promise<T | null> => {
  if (!redisAvailable) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

const setCached = async (key: string, data: unknown, ttlSeconds?: number): Promise<void> => {
  if (!redisAvailable) return;
  try {
    const serialized = JSON.stringify(data);
    if (ttlSeconds) {
      await redis.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await redis.set(key, serialized); // permanent
    }
  } catch {}
};

/**
 * How long a /streams answer may be cached: its googlevideo urls stop working at their
 * `expire` time (about 6 hours out), so never past that, less 5 minutes for the playback
 * that starts just before it. 0 means don't cache.
 */
export const streamTtl = (res: T.Streams, now = Date.now()): number => {
  const url = res.audioStreams?.[0]?.url ?? res.videoStreams?.[0]?.url ?? '';
  const expire = Number(/[?&]expire=(\d+)/.exec(url)?.[1]);
  if (!expire) return TTL.streamsMeta;
  const left = Math.floor(expire - now / 1000) - 300;
  return Math.max(0, Math.min(TTL.streamsMeta, left));
};

const cacheStream = async (videoId: string, res: T.Streams) => {
  const ttl = streamTtl(res);
  if (ttl > 0) await setCached(`stream:${videoId}`, res, ttl);
};

export const CachedPiped = {
  async getStream(videoId: string): Promise<T.Streams> {
    const cached = await getCached<T.Streams>(`stream:${videoId}`);
    if (cached) return cached;

    const res = await Piped.getStream(videoId);
    await cacheStream(videoId, res);
    return res;
  },

  // Bypasses and replaces the cached entry - used when a cached stream URL has gone bad.
  async refreshStream(videoId: string): Promise<T.Streams> {
    const res = await Piped.getStream(videoId);
    await cacheStream(videoId, res);
    return res;
  },

  async search(q: string, filter?: string): Promise<T.SearchPage> {
    const key = `search:${q}:${filter || 'all'}`;
    const cached = await getCached<T.SearchPage>(key);
    if (cached) return cached;

    const res = await Piped.search(q, filter);
    await setCached(key, res, TTL.search);
    return res;
  },

  async searchNextPage(q: string, nextpage: string, filter?: string): Promise<T.SearchPage> {
    const key = `searchNext:${q}:${nextpage}:${filter || 'all'}`;
    const cached = await getCached<T.SearchPage>(key);
    if (cached) return cached;

    const res = await Piped.searchNextPage(q, nextpage, filter);
    await setCached(key, res, TTL.search);
    return res;
  },

  async suggestions(query: string): Promise<string[]> {
    const key = `suggestions:${query}`;
    const cached = await getCached<string[]>(key);
    if (cached) return cached;

    const res = await Piped.suggestions(query);
    await setCached(key, res, TTL.suggestions);
    return res;
  },

  async trending(region: string = 'IN'): Promise<T.StreamItem[]> {
    const key = `trending:${region}`;
    const cached = await getCached<T.StreamItem[]>(key);
    if (cached) return cached;

    const res = await Piped.trending(region);
    await setCached(key, res, TTL.trending);
    return res;
  },

  async channel(id: string): Promise<T.Channel> {
    const key = `channel:${id}`;
    const cached = await getCached<T.Channel>(key);
    if (cached) return cached;

    const res = await Piped.channel(id);
    await setCached(key, res, TTL.artistDetail);
    return res;
  },

  async playlist(id: string): Promise<T.Playlist> {
    const key = `playlist:${id}`;
    const cached = await getCached<T.Playlist>(key);
    if (cached) return cached;

    const res = await Piped.playlist(id);
    // A playlist that reports videos but lists none is an extraction failure upstream
    // (e.g. YouTube's lockupViewModel change); caching it would pin empty albums for hours.
    const failed = (res.videos ?? 0) > 0 && !res.relatedStreams?.length;
    if (!failed) await setCached(key, res, TTL.albumDetail);
    return res;
  },

  async playlistNextPage(id: string, nextpage: string): Promise<T.PlaylistPage> {
    const key = `playlistNext:${id}:${nextpage}`;
    const cached = await getCached<T.PlaylistPage>(key);
    if (cached) return cached;

    const res = await Piped.playlistNextPage(id, nextpage);
    await setCached(key, res, TTL.albumDetail);
    return res;
  },
};

// Redis holds these for a week at a time; Postgres keeps them (H3: Render's Key Value is 25 MB
// with LRU eviction and loses everything on a restart).
const WARM_TTL = 7 * 24 * 3600;
/** LRCLIB grows: "no lyrics" is asked again after a week. */
const LYRICS_MISS_TTL_MS = 7 * 24 * 3600_000;

/** Loudness 0..1 per bar as one byte each. */
export const encodePeaks = (peaks: number[]): Buffer =>
  Buffer.from(peaks.map((p) => Math.round(Math.min(1, Math.max(0, p)) * 255)));
export const decodePeaks = (bytes: Buffer): number[] => [...bytes].map((b) => Math.round((b / 255) * 1000) / 1000);

/** A stored lyrics row: `found` false when LRCLIB had none (and that answer hasn't expired). */
const readLyricsRow = async (key: string): Promise<{ lyrics: ResolvedLyrics | null } | null> => {
  try {
    const [row] = await db.select().from(lyricsCache).where(eq(lyricsCache.key, key)).limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    return { lyrics: (row.lyrics as ResolvedLyrics | null) ?? null };
  } catch (err) {
    logger.warn({ err }, 'Cache: could not read stored lyrics');
    return null;
  }
};

const writeLyricsRow = async (key: string, lyrics: ResolvedLyrics | null): Promise<void> => {
  const expiresAt = lyrics ? null : new Date(Date.now() + LYRICS_MISS_TTL_MS);
  try {
    await db
      .insert(lyricsCache)
      .values({ key, lyrics, expiresAt, createdAt: new Date() })
      .onConflictDoUpdate({ target: lyricsCache.key, set: { lyrics, expiresAt, createdAt: new Date() } });
  } catch (err) {
    logger.warn({ err }, 'Cache: could not store lyrics');
  }
};

/** Most lyrics rows kept (a few KB each, compressed by Postgres): the oldest go beyond this. */
export const LYRICS_CACHE_MAX_ROWS = 50_000;

/** Drops expired "no lyrics" answers and the oldest rows past the cap. Logged, never thrown. */
export const pruneLyricsCache = async (maxRows = LYRICS_CACHE_MAX_ROWS): Promise<void> => {
  try {
    // Timestamps are stored as UTC without a zone (as drizzle writes them), so compare in UTC.
    await db.execute(
      sql`DELETE FROM lyrics_cache WHERE expires_at IS NOT NULL AND expires_at < (now() AT TIME ZONE 'UTC')`,
    );
    await db.execute(sql`
      DELETE FROM lyrics_cache WHERE key IN (
        SELECT key FROM lyrics_cache ORDER BY created_at DESC OFFSET ${maxRows}
      )
    `);
  } catch (err) {
    logger.warn({ err }, 'Cache: could not prune stored lyrics');
  }
};

export const PermanentCache = {
  async getLyrics(key: string): Promise<ResolvedLyrics | null> {
    const warm = await getCached<ResolvedLyrics>(`lyrics:${key}`);
    if (warm) return warm;
    const stored = await readLyricsRow(key);
    if (!stored?.lyrics) return null;
    await setCached(`lyrics:${key}`, stored.lyrics, WARM_TTL);
    return stored.lyrics;
  },
  async setLyrics(key: string, data: ResolvedLyrics | null) {
    if (!data) {
      await db
        .delete(lyricsCache)
        .where(eq(lyricsCache.key, key))
        .catch(() => {});
      if (redisAvailable) await redis.del(`lyrics:${key}`).catch(() => {});
      return;
    }
    await writeLyricsRow(key, data);
    await setCached(`lyrics:${key}`, data, WARM_TTL);
  },
  // v3: the apps upload loudness (RMS) per bar since 2026-10-14. v2 waveforms held each bar's
  // loudest sample, which is near full scale in most music, so they drew a flat block.
  async getPeaks(key: string): Promise<number[] | null> {
    const warm = await getCached<number[]>(`peaks:v3:${key}`);
    if (warm) return warm;
    try {
      const [row] = await db.select().from(waveforms).where(eq(waveforms.trackId, key)).limit(1);
      if (!row) return null;
      const peaks = decodePeaks(row.peaks);
      await setCached(`peaks:v3:${key}`, peaks, WARM_TTL);
      return peaks;
    } catch (err) {
      logger.warn({ err }, 'Cache: could not read a stored waveform');
      return null;
    }
  },
  /** First upload wins: an existing waveform is kept. False when one was already stored. */
  async setPeaks(key: string, data: number[]): Promise<boolean> {
    let stored = true;
    try {
      const rows = await db
        .insert(waveforms)
        .values({ trackId: key, peaks: encodePeaks(data) })
        .onConflictDoNothing()
        .returning({ trackId: waveforms.trackId });
      stored = rows.length > 0;
    } catch (err) {
      logger.warn({ err }, 'Cache: could not store a waveform');
    }
    if (stored) await setCached(`peaks:v3:${key}`, data, WARM_TTL);
    return stored;
  },
  /** Lyrics in a preferred script; `lyrics: null` records that LRCLIB has none, so it isn't asked every play. */
  async getScriptLyrics(trackId: string, script: string): Promise<{ lyrics: ResolvedLyrics | null } | null> {
    const key = `${trackId}:${script}`;
    const warm = await getCached<{ lyrics: ResolvedLyrics | null }>(`lyricsScript:${key}`);
    if (warm) return warm;
    const stored = await readLyricsRow(`script:${key}`);
    if (stored) await setCached(`lyricsScript:${key}`, stored, stored.lyrics ? WARM_TTL : 24 * 3600);
    return stored;
  },
  async setScriptLyrics(trackId: string, script: string, lyrics: ResolvedLyrics | null) {
    const key = `${trackId}:${script}`;
    await writeLyricsRow(`script:${key}`, lyrics);
    // Found ones keep like other lyrics; misses are retried after a week, LRCLIB grows.
    await setCached(`lyricsScript:${key}`, { lyrics }, lyrics ? WARM_TTL : LYRICS_MISS_TTL_MS / 1000);
  },
  async getAlbumThumb(albumId: string) {
    return getCached<string>(`albumThumb:${albumId}`);
  },
  async setAlbumThumb(albumId: string, url: string) {
    return setCached(`albumThumb:${albumId}`, url, 30 * 24 * 3600);
  },
};
