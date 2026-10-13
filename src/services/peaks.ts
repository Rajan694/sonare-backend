export const CANONICAL_BARS = 150;

/**
 * Deterministic, waveform-like placeholder peaks for a track.
 * Uses FNV-1a 32-bit hash over the UTF-8 bytes of `trackId`,
 * followed by a xorshift32 PRNG to generate envelope noise.
 * All values are in the range [0.3, 1].
 */
export const placeholderPeaks = (trackId: string, bars: number): number[] => {
  const bytes = new TextEncoder().encode(trackId);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }

  let state = (hash === 0 ? 0x811c9dc5 : hash) >>> 0;
  const nextRand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 4294967296;
  };

  const result: number[] = [];
  for (let i = 0; i < bars; i++) {
    const progress = i / bars;
    const envelope = Math.sin(progress * Math.PI) * Math.sin(progress * Math.PI * 3);
    const baseShape = Math.abs(envelope) * 0.7 + 0.3;
    const noise = nextRand() * 0.5 - 0.25;

    let val = baseShape + noise;
    if (val < 0.3) val = 0.3;
    if (val > 1) val = 1;

    result.push(val);
  }
  return result;
};

/**
 * Resample a peaks array to `bars` length.
 * When shrinking (bars < peaks.length): max-pooling over the window.
 * When growing (bars > peaks.length): linear interpolation.
 */
export const resamplePeaks = (peaks: number[], bars: number): number[] => {
  if (bars <= 0 || peaks.length === 0) return [];
  if (bars === peaks.length) return peaks.slice();

  if (bars < peaks.length) {
    const result: number[] = [];
    for (let i = 0; i < bars; i++) {
      const start = Math.floor((i * peaks.length) / bars);
      const end = Math.floor(((i + 1) * peaks.length) / bars);
      let max = -Infinity;
      for (let j = start; j < end; j++) {
        if (peaks[j] > max) max = peaks[j];
      }
      result.push(max === -Infinity ? 0 : max);
    }
    return result;
  }

  if (peaks.length === 1) {
    return new Array(bars).fill(peaks[0]);
  }

  const result: number[] = [];
  for (let i = 0; i < bars; i++) {
    const pos = (i * (peaks.length - 1)) / (bars - 1);
    const low = Math.floor(pos);
    const high = Math.min(low + 1, peaks.length - 1);
    const weight = pos - low;
    result.push(peaks[low] * (1 - weight) + peaks[high] * weight);
  }
  return result;
};
