import { Redis } from 'ioredis';
import { config } from './config.js';
import { Piped } from './upstream/piped.js';
import * as T from './upstream/piped.types.js';

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
redis.connect().then(() => {
  redisAvailable = true;
}).catch((err: any) => {
  if (!loggedRedisError) {
    console.warn('[Cache] Redis unreachable at', config.REDIS_URL, '— degrading to cache passthrough.');
    loggedRedisError = true;
  }
});

redis.on('error', (err: any) => {
  redisAvailable = false;
  if (!loggedRedisError) {
    console.warn('[Cache] Redis connection lost — degrading to cache passthrough.');
    loggedRedisError = true;
  }
});

redis.on('ready', () => {
  redisAvailable = true;
  loggedRedisError = false;
});

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

async function getCached<T>(key: string): Promise<T | null> {
  if (!redisAvailable) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

async function setCached(key: string, data: any, ttlSeconds?: number): Promise<void> {
  if (!redisAvailable) return;
  try {
    const serialized = JSON.stringify(data);
    if (ttlSeconds) {
      await redis.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await redis.set(key, serialized); // permanent
    }
  } catch {}
}

export const CachedPiped = {
  async getStream(videoId: string): Promise<T.Streams> {
    const key = `stream:${videoId}`;
    const cached = await getCached<T.Streams>(key);
    if (cached) return cached;
    
    const res = await Piped.getStream(videoId);
    await setCached(key, res, TTL.streamsMeta);
    return res;
  },

  // Bypasses and replaces the cached entry - used when a cached stream URL has gone bad.
  async refreshStream(videoId: string): Promise<T.Streams> {
    const res = await Piped.getStream(videoId);
    await setCached(`stream:${videoId}`, res, TTL.streamsMeta);
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
    const failed = (res.videos ?? 0) > 0 && !(res.relatedStreams?.length);
    if (!failed) await setCached(key, res, TTL.albumDetail);
    return res;
  },

  async playlistNextPage(id: string, nextpage: string): Promise<any> {
    const key = `playlistNext:${id}:${nextpage}`;
    const cached = await getCached<any>(key);
    if (cached) return cached;

    const res = await Piped.playlistNextPage(id, nextpage);
    await setCached(key, res, TTL.albumDetail);
    return res;
  },
};

export const PermanentCache = {
  async getLyrics(key: string) { return getCached(`lyrics:${key}`); },
  async setLyrics(key: string, data: any) { return setCached(`lyrics:${key}`, data); },
  async getPeaks(key: string) { return getCached<number[]>(`peaks:${key}`); },
  async setPeaks(key: string, data: number[]) { return setCached(`peaks:${key}`, data); },
};
