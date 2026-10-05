import { spawn, execSync } from 'child_process';
import crypto from 'crypto';

let HAS_FFMPEG = false;
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  HAS_FFMPEG = true;
} catch (e) {
  HAS_FFMPEG = false;
}

/** Whether ffmpeg is on the PATH. Without it every waveform is a made-up placeholder. */
export const hasFfmpeg = (): boolean => {
  return HAS_FFMPEG;
};

export const extractPeaks = async (url: string, trackId: string, bars: number = 150): Promise<number[]> => {
  if (!HAS_FFMPEG) {
    return placeholderPeaks(trackId, bars);
  }

  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-i',
      url,
      '-t',
      '20',
      '-f',
      'f32le',
      '-ac',
      '1',
      '-ar',
      '1000',
      '-v',
      'quiet',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    ff.stdout.on('data', (d) => chunks.push(d));

    ff.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        resolve(placeholderPeaks(trackId, bars));
        return;
      }

      const buf = Buffer.concat(chunks);
      const validBytes = buf.byteLength - (buf.byteLength % 4);
      if (validBytes <= 0) {
        resolve(placeholderPeaks(trackId, bars));
        return;
      }

      const alignedBuf = Buffer.allocUnsafe(validBytes);
      buf.copy(alignedBuf, 0, 0, validBytes);

      const floats = new Float32Array(alignedBuf.buffer, alignedBuf.byteOffset, validBytes / 4);

      if (floats.length === 0) {
        resolve(placeholderPeaks(trackId, bars));
        return;
      }

      const result: number[] = [];
      const samplesPerBar = Math.max(1, Math.floor(floats.length / bars));

      for (let i = 0; i < bars; i++) {
        let max = 0;
        const start = i * samplesPerBar;
        const end = Math.min((i + 1) * samplesPerBar, floats.length);

        for (let j = start; j < end; j++) {
          const abs = Math.abs(floats[j]);
          if (abs > max) max = abs;
        }
        result.push(max);
      }

      resolve(result);
    });

    ff.on('error', () => resolve(placeholderPeaks(trackId, bars)));
  });
};

/** True when `peaks` is this track's made-up placeholder, i.e. extraction failed. */
export const isPlaceholderPeaks = (trackId: string, bars: number, peaks: number[]): boolean => {
  const placeholder = placeholderPeaks(trackId, bars);
  return peaks.length === placeholder.length && peaks.every((p, i) => p === placeholder[i]);
};

/** A deterministic, waveform-ish shape for when the real audio can't be read. */
export const placeholderPeaks = (trackId: string, bars: number): number[] => {
  const hashHex = crypto.createHash('md5').update(trackId).digest('hex');
  const hashBytes = Buffer.from(hashHex, 'hex');
  const result: number[] = [];

  for (let i = 0; i < bars; i++) {
    const progress = i / bars;
    const envelope = Math.sin(progress * Math.PI) * Math.sin(progress * Math.PI * 3);
    const baseShape = Math.abs(envelope) * 0.7 + 0.3;

    const byte = hashBytes[i % hashBytes.length];
    const noise = (byte / 255) * 0.5 - 0.25;

    let val = baseShape + noise;
    if (val < 0) val = 0;
    if (val > 1) val = 1;

    result.push(val);
  }
  return result;
};
