import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/middleware/rateLimit.js';

describe('rateLimit.ts: windows', () => {
  it('BE-RATE-001: allows requests under rate limit threshold', async () => {
    const limiter = createRateLimiter({ name: 'test-w1', max: 5, windowMs: 10000 });
    for (let i = 0; i < 5; i++) {
      const res = await limiter.hit('ip1');
      expect(res.allowed).toBe(true);
    }
  });

  it('BE-RATE-002: blocks requests exceeding max and computes retryAfterSec', async () => {
    const limiter = createRateLimiter({ name: 'test-w2', max: 2, windowMs: 10000 });
    await limiter.hit('ip2');
    await limiter.hit('ip2');
    const blocked = await limiter.hit('ip2');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(10);
  });

  it('BE-RATE-003: reset clears records for specified key', async () => {
    const limiter = createRateLimiter({ name: 'test-w3', max: 1, windowMs: 10000 });
    await limiter.hit('ip3');
    const b1 = await limiter.blocked('ip3');
    expect(b1.blocked).toBe(true);
    await limiter.reset('ip3');
    const b2 = await limiter.blocked('ip3');
    expect(b2.blocked).toBe(false);
    const h1 = await limiter.hit('ip3');
    expect(h1.allowed).toBe(true);
  });

  it('BE-RATE-004: isolates different IP keys independently', async () => {
    const limiter = createRateLimiter({ name: 'test-w4', max: 1, windowMs: 10000 });
    await limiter.hit('ipA');
    const resA = await limiter.hit('ipA');
    expect(resA.allowed).toBe(false);
    const resB = await limiter.hit('ipB');
    expect(resB.allowed).toBe(true);
  });
});

describe('rateLimit.ts: hit counts', () => {
  it('BE-PURE-011: createRateLimiter enforces hit counts and window expiration', async () => {
    const limiter = createRateLimiter({ name: 'test-hc', max: 3, windowMs: 10000 });
    const ip = '192.168.1.50';

    const h1 = await limiter.hit(ip);
    expect(h1.allowed).toBe(true);
    const h2 = await limiter.hit(ip);
    expect(h2.allowed).toBe(true);
    const h3 = await limiter.hit(ip);
    expect(h3.allowed).toBe(true);
    // 4th hit exceeds limit
    const fourth = await limiter.hit(ip);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);

    // Blocked check
    const b = await limiter.blocked(ip);
    expect(b.blocked).toBe(true);

    // Reset clears the block
    await limiter.reset(ip);
    const bAfter = await limiter.blocked(ip);
    expect(bAfter.blocked).toBe(false);
  });
});
