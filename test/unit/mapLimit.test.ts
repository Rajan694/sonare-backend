import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../src/mapLimit.js';

describe('mapLimit concurrency helper', () => {
  it('BE-MAPLIMIT-001: keeps the result order of the input', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);

    const result = await mapLimit(items, 4, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (n % 5) * 2));
      return n * 2;
    });

    expect(result).toEqual(items.map((n) => n * 2));
  });

  it('BE-MAPLIMIT-002: never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    const result = await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return n;
      },
    );

    expect(peak).toBe(4);
    expect(result).toHaveLength(20);
    expect(inFlight).toBe(0);
  });

  it('BE-MAPLIMIT-003: rejects when a call rejects', async () => {
    await expect(
      mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
        if (n === 3) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
