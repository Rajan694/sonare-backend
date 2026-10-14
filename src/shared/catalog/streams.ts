// GENERATED from sonare-frontend/shared/catalog/streams.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// Stream selection and formatting - port of backend/src/routes/media.routes.ts selectBestAudioStream
// Pure TypeScript, no Node APIs.

import type { PipedStream } from './pipedTypes.js';
import type { StreamInfo } from '../apiTypes.js';

export interface SelectedStream {
  url: string;
  itag: number;
  mimeType: string;
  codec: string;
  bitrate: number;
  contentLength: number;
  muxed: boolean;
}

/**
 * Select the best audio stream from Piped streams.
 * Line-by-line port of backend selectBestAudioStream.
 */
export const selectBestAudioStream = (
  audios: PipedStream[] | undefined,
  quality: string,
  format?: string,
  videoStreams?: PipedStream[],
): SelectedStream | null => {
  // If adaptive audio streams exist, adaptive audio must still win
  if (audios && audios.length > 0) {
    const sorted = audios.slice().sort((a, b) => b.bitrate - a.bitrate);
    const isOpus = (s: PipedStream) =>
      s.codec?.toLowerCase().includes('opus') ||
      s.format?.toLowerCase().includes('opus') ||
      s.codec?.toLowerCase().includes('webm') ||
      s.format?.toLowerCase().includes('webm');
    const isAac = (s: PipedStream) =>
      s.codec?.toLowerCase().includes('mp4a') ||
      s.format?.toLowerCase().includes('m4a') ||
      s.codec?.toLowerCase().includes('m4a') ||
      s.format?.toLowerCase().includes('mp4a');

    // `low`, `auto` and `high` are bitrate ceilings. `normal` is the middle tier of the format:
    // YouTube's Opus comes in ~60 / ~75 / ~150 kbps and AAC in ~50 / ~128, so a ceiling
    // can't tell "normal" from "high" (both would be the ~160 kbps Opus).
    const targets: Record<string, number> = { low: 64_000, auto: 160_000, high: Infinity };
    const pick = (list: PipedStream[]) => {
      if (list.length === 0) return undefined;
      if (quality === 'normal') {
        const tiers = [...new Set(list.map((s) => s.itag))].reverse(); // lowest bitrate first
        const middle = tiers[Math.floor(tiers.length / 2)];
        return list.find((s) => s.itag === middle);
      }
      const target = targets[quality] ?? targets.auto;
      return list.find((s) => s.bitrate <= target) ?? list[list.length - 1];
    };

    // Contract 8.2 says prefer opus and fall back to mp4a only when there is no opus. An
    // explicit format is tried first at any bitrate before the other one is considered.
    const order = format === 'mp4a' || format === 'm4a' ? [isAac, isOpus] : [isOpus, isAac];
    const best = pick(sorted.filter(order[0])) ?? pick(sorted.filter(order[1])) ?? pick(sorted);

    if (best) {
      let mappedCodec = best.codec;
      if (best.codec?.toLowerCase().includes('opus') || best.format?.toLowerCase().includes('opus'))
        mappedCodec = 'OPUS';
      else if (
        best.codec?.toLowerCase().includes('mp4a') ||
        best.format?.toLowerCase().includes('m4a') ||
        best.format?.toLowerCase().includes('mp4a') ||
        best.codec?.toLowerCase().includes('aac')
      )
        mappedCodec = 'AAC';

      return {
        url: best.url,
        itag: best.itag,
        mimeType: best.mimeType,
        codec: mappedCodec || 'OPUS',
        bitrate: best.bitrate,
        contentLength: best.contentLength,
        muxed: false,
      };
    }
  }

  // Fallback to muxed progressive video streams containing audio when audioStreams is empty.
  if (videoStreams && videoStreams.length > 0) {
    const muxed = videoStreams.filter((s) => s.videoOnly === false || s.itag === 18);
    if (muxed.length > 0) {
      // Prefer the smallest such stream since we only want the audio
      const sortedMuxed = muxed.slice().sort((a, b) => {
        const aVal = a.bitrate > 0 ? a.bitrate : a.contentLength > 0 ? a.contentLength : Infinity;
        const bVal = b.bitrate > 0 ? b.bitrate : b.contentLength > 0 ? b.contentLength : Infinity;
        return aVal - bVal;
      });
      const chosen = sortedMuxed[0];
      return {
        url: chosen.url,
        itag: chosen.itag,
        mimeType: chosen.mimeType || 'video/mp4',
        codec: 'AAC',
        bitrate: chosen.bitrate || 48_000,
        contentLength: chosen.contentLength,
        muxed: true,
      };
    }
  }

  return null;
};

/**
 * Convert selected stream to StreamInfo API shape.
 * URL is the stream's own URL;
 * expiresAt = (expire query param of the URL * 1000) - 5 min when present, else now + 1 h;
 * contentLength = 0 when <= 0;
 * muxed, itag as in backend route.
 */
export const toStreamInfo = (selected: SelectedStream, now: number = Date.now()): StreamInfo => {
  let expiresAt = now + 3600_000;

  const q = selected.url.indexOf('?');
  if (q >= 0) {
    const params = selected.url.slice(q + 1).split('&');
    const expireParam = params.find((p) => p.startsWith('expire='))?.slice('expire='.length);
    if (expireParam) {
      const sec = parseInt(expireParam, 10);
      if (!isNaN(sec)) {
        expiresAt = sec * 1000 - 300_000;
      }
    }
  }

  return {
    url: selected.url,
    mimeType: selected.mimeType,
    codec: selected.codec,
    bitrateKbps: Math.floor(selected.bitrate / 1000),
    contentLength: selected.contentLength > 0 ? selected.contentLength : 0,
    expiresAt,
    muxed: selected.muxed,
    itag: selected.itag,
  };
};
