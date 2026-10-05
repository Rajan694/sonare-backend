import type { ResolvedLyrics } from './lyrics.js';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { Piped } from '../upstream/piped.js';
import * as T from '../upstream/piped.types.js';
import { logger } from '../logger.js';

export const TTL = {
  search: 5 * 60, // seconds for Redis
  suggestions: 60 * 60,
  trending: 30 * 60,
  albumDetail: 6 * 60 * 60,
  artistDetail: 12 * 60 * 60,
  streamsMeta: 60 * 60,
};

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

const delCached = async (key: string): Promise<void> => {
  if (!redisAvailable) return;
  try {
    await redis.del(key);
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

export const PermanentCache = {
  async getLyrics(key: string) {
    return getCached<ResolvedLyrics>(`lyrics:${key}`);
  },
  async setLyrics(key: string, data: ResolvedLyrics | null) {
    return setCached(`lyrics:${key}`, data);
  },
  async getPeaks(key: string) {
    return getCached<number[]>(`peaks:${key}`);
  },
  async setPeaks(key: string, data: number[]) {
    return setCached(`peaks:${key}`, data);
  },
  /** Extraction failed lately (Piped down, dead url, no ffmpeg): serve the placeholder, retry in an hour. */
  async peaksFailedRecently(key: string) {
    return !!(await getCached<boolean>(`peaksFailed:${key}`));
  },
  async markPeaksFailed(key: string) {
    await delCached(`peaks:${key}`);
    return setCached(`peaksFailed:${key}`, true, 3600);
  },
  /** Lyrics in a preferred script; `lyrics: null` records that LRCLIB has none, so it isn't asked every play. */
  async getScriptLyrics(trackId: string, script: string) {
    return getCached<{ lyrics: ResolvedLyrics | null }>(`lyricsScript:${trackId}:${script}`);
  },
  async setScriptLyrics(trackId: string, script: string, lyrics: ResolvedLyrics | null) {
    // Found ones keep like other lyrics; misses are retried after a week, LRCLIB grows.
    return setCached(`lyricsScript:${trackId}:${script}`, { lyrics }, lyrics ? undefined : 7 * 24 * 3600);
  },
  async getAlbumThumb(albumId: string) {
    return getCached<string>(`albumThumb:${albumId}`);
  },
  async setAlbumThumb(albumId: string, url: string) {
    return setCached(`albumThumb:${albumId}`, url, 30 * 24 * 3600);
  },
};
