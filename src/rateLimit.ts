import { LRUCache } from 'lru-cache';

/** Fixed-window counter per key (an IP, or IP + username). In memory: one backend process. */
export function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const windows = new LRUCache<string, { count: number; resetAt: number }>({ max: 10_000, ttl: windowMs });

  return {
    /** Counts a hit; `allowed` is false once the key has used up its window. */
    hit(key: string): { allowed: boolean; retryAfterSec: number } {
      const now = Date.now();
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count++;
      return { allowed: w.count <= max, retryAfterSec: Math.ceil((w.resetAt - now) / 1000) };
    },
    /** True when the key has no hits left, without counting one. */
    blocked(key: string): { blocked: boolean; retryAfterSec: number } {
      const w = windows.get(key);
      const now = Date.now();
      if (!w || w.resetAt <= now || w.count < max) return { blocked: false, retryAfterSec: 0 };
      return { blocked: true, retryAfterSec: Math.ceil((w.resetAt - now) / 1000) };
    },
    reset(key: string) {
      windows.delete(key);
    },
  };
}
