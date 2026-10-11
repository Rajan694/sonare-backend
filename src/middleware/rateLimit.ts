import { redis, isRedisAvailable } from '../services/cache.js';
import { logger } from '../logger.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimitBlockedResult {
  blocked: boolean;
  retryAfterSec: number;
}

let loggedRateLimitRedisWarning = false;

const warnRedisDown = () => {
  if (!loggedRateLimitRedisWarning) {
    logger.warn('Rate limiter: Redis unreachable, failing open');
    loggedRateLimitRedisWarning = true;
  }
};

/** Fixed-window counter per key backed by Redis. */
export const createRateLimiter = ({
  name = 'default',
  max,
  windowMs,
}: {
  name?: string;
  max: number;
  windowMs: number;
}) => {
  const prefix = `rl:${name}:`;

  return {
    /** Counts a hit; `allowed` is false once the key has used up its window. */
    async hit(key: string): Promise<RateLimitResult> {
      const fullKey = `${prefix}${key}`;
      if (!isRedisAvailable()) {
        warnRedisDown();
        return { allowed: true, retryAfterSec: 0 };
      }
      try {
        const count = await redis.incr(fullKey);
        if (count === 1) {
          await redis.pexpire(fullKey, windowMs);
        }
        const pttl = await redis.pttl(fullKey);
        if (pttl === -1) {
          await redis.pexpire(fullKey, windowMs);
        }
        const retryAfterSec = pttl > 0 ? Math.ceil(pttl / 1000) : Math.ceil(windowMs / 1000);
        return { allowed: count <= max, retryAfterSec };
      } catch (err) {
        warnRedisDown();
        return { allowed: true, retryAfterSec: 0 };
      }
    },

    /** True when the key has no hits left, without counting one. */
    async blocked(key: string): Promise<RateLimitBlockedResult> {
      const fullKey = `${prefix}${key}`;
      if (!isRedisAvailable()) {
        warnRedisDown();
        return { blocked: false, retryAfterSec: 0 };
      }
      try {
        const countStr = await redis.get(fullKey);
        const count = countStr ? parseInt(countStr, 10) : 0;
        if (count < max) {
          return { blocked: false, retryAfterSec: 0 };
        }
        const pttl = await redis.pttl(fullKey);
        const retryAfterSec = pttl > 0 ? Math.ceil(pttl / 1000) : Math.ceil(windowMs / 1000);
        return { blocked: true, retryAfterSec };
      } catch (err) {
        warnRedisDown();
        return { blocked: false, retryAfterSec: 0 };
      }
    },

    async reset(key: string): Promise<void> {
      const fullKey = `${prefix}${key}`;
      if (!isRedisAvailable()) {
        return;
      }
      try {
        await redis.del(fullKey);
      } catch (err) {
        warnRedisDown();
      }
    },
  };
};
