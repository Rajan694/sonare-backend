import { describe, expect, it } from 'vitest';
import { placeholderPeaks, resamplePeaks, CANONICAL_BARS } from '../../src/services/peaks.js';

describe('peaks service: placeholderPeaks', () => {
  const PINNED_8_BARS = [
    0.3, 0.3764484801310155, 0.7973107469500973, 0.5106853423154952, 1, 0.6851863099242606, 0.8997021298622712,
    0.7015426778913516,
  ];

  it('BE-PEAK-001: placeholderPeaks matches pinned literal array for yt:NJAv_7lHUIU', () => {
    const peaks = placeholderPeaks('yt:NJAv_7lHUIU', 8);
    expect(peaks).toEqual(PINNED_8_BARS);
  });

  it('BE-PEAK-002: placeholderPeaks generates bounded values in [0.3, 1] deterministically', () => {
    const peaks1 = placeholderPeaks('yt:test-track', CANONICAL_BARS);
    const peaks2 = placeholderPeaks('yt:test-track', CANONICAL_BARS);
    expect(peaks1).toHaveLength(CANONICAL_BARS);
    expect(peaks1).toEqual(peaks2);
    expect(peaks1.every((p) => p >= 0.3 && p <= 1)).toBe(true);
  });
});

describe('peaks service: resamplePeaks', () => {
  it('BE-PEAK-003: resamplePeaks downsamples with max-pooling when shrinking', () => {
    const input = [0.1, 0.9, 0.4, 0.2];
    const resampled = resamplePeaks(input, 2);
    expect(resampled).toEqual([0.9, 0.4]);
  });

  it('BE-PEAK-004: resamplePeaks upsamples with linear interpolation when growing', () => {
    const input = [0.2, 0.8];
    const resampled = resamplePeaks(input, 3);
    expect(resampled).toEqual([0.2, 0.5, 0.8]);

    const input3 = [0, 0.5, 1];
    expect(resamplePeaks(input3, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('BE-PEAK-005: resamplePeaks handles edge cases (empty, zero bars, same length, single element)', () => {
    expect(resamplePeaks([], 10)).toEqual([]);
    expect(resamplePeaks([0.5, 0.8], 0)).toEqual([]);
    expect(resamplePeaks([0.5, 0.8], -1)).toEqual([]);
    expect(resamplePeaks([0.5, 0.8], 2)).toEqual([0.5, 0.8]);
    expect(resamplePeaks([0.7], 3)).toEqual([0.7, 0.7, 0.7]);
  });
});
