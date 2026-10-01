import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/rateLimit.js';

describe('rateLimit.ts: windows', () => {
  it('BE-RATE-001: allows requests under rate limit threshold', () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 10000 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.hit('ip1').allowed).toBe(true);
    }
  });

  it('BE-RATE-002: blocks requests exceeding max and computes retryAfterSec', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 10000 });
    limiter.hit('ip2');
    limiter.hit('ip2');
    const blocked = limiter.hit('ip2');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(10);
  });

  it('BE-RATE-003: reset clears records for specified key', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10000 });
    limiter.hit('ip3');
    expect(limiter.blocked('ip3').blocked).toBe(true);
    limiter.reset('ip3');
    expect(limiter.blocked('ip3').blocked).toBe(false);
    expect(limiter.hit('ip3').allowed).toBe(true);
  });

  it('BE-RATE-004: isolates different IP keys independently', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10000 });
    limiter.hit('ipA');
    expect(limiter.hit('ipA').allowed).toBe(false);
    expect(limiter.hit('ipB').allowed).toBe(true);
  });
});

describe('rateLimit.ts: hit counts', () => {
  it('BE-PURE-011: createRateLimiter enforces hit counts and window expiration', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 10000 });
    const ip = '192.168.1.50';

    expect(limiter.hit(ip).allowed).toBe(true);
    expect(limiter.hit(ip).allowed).toBe(true);
    expect(limiter.hit(ip).allowed).toBe(true);
    // 4th hit exceeds limit
    const fourth = limiter.hit(ip);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);

    // Blocked check
    expect(limiter.blocked(ip).blocked).toBe(true);

    // Reset clears the block
    limiter.reset(ip);
    expect(limiter.blocked(ip).blocked).toBe(false);
  });
});
