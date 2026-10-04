import { describe, expect, it } from 'vitest';
import { extractPeaks, isPlaceholderPeaks, placeholderPeaks } from '../../src/services/peaks.js';

describe('peaks.ts', () => {
  it('BE-PEAKS-001: extractPeaks produces bounded floating point values', async () => {
    const peaks = await extractPeaks('http://invalid.local', 'track_peaks_test', 80);
    expect(peaks).toHaveLength(80);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('BE-PEAKS-004: isPlaceholderPeaks recognises a failed extraction, not real peaks', async () => {
    const failed = await extractPeaks('http://invalid.local', 'placeholder_id', 60);
    expect(isPlaceholderPeaks('placeholder_id', 60, failed)).toBe(true);
    expect(failed).toEqual(placeholderPeaks('placeholder_id', 60));
    expect(
      isPlaceholderPeaks(
        'placeholder_id',
        60,
        failed.map((p) => p / 2),
      ),
    ).toBe(false);
    expect(isPlaceholderPeaks('other_id', 60, failed)).toBe(false);
  });

  it('BE-PEAKS-002: extractPeaks produces deterministic values for identical trackId', async () => {
    const peaks1 = await extractPeaks('http://invalid.local', 'repeatable_id', 50);
    const peaks2 = await extractPeaks('http://invalid.local', 'repeatable_id', 50);
    expect(peaks1).toEqual(peaks2);
  });

  it('BE-PEAKS-003: extractPeaks handles empty url by producing synthetic peaks', async () => {
    const peaks = await extractPeaks('', 'vidEmpty', 20);
    expect(peaks).toHaveLength(20);
    expect(peaks.every((p) => typeof p === 'number')).toBe(true);
  });
});

describe('peaks.ts: fallback', () => {
  it('BE-PURE-008: extractPeaks generates deterministic peaks array on error fallback', async () => {
    const peaks = await extractPeaks('http://invalid-url-peaks.test', 'video-12345', 50);
    expect(peaks).toHaveLength(50);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });
});
