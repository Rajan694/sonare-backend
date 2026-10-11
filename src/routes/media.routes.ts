import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { request } from 'undici';
import { LRUCache } from 'lru-cache';
import { CachedPiped, PermanentCache } from '../services/cache.js';
import { normalizeStreamToTrack, albumThumbFor, proxyImageUrl } from '../normalize/index.js';
import { directImageUrl, ytThumbUrl, type YtThumbName } from '../upstream/ytImages.js';
import { idHelpers } from '../ids.js';
import { signStreamToken, verifyStreamToken } from '../services/token.js';
import { extractPeaks, isPlaceholderPeaks, placeholderPeaks } from '../services/peaks.js';
import { NoAudioStreamError } from '../errors.js';
import { getUserTrackFields } from '../db/userData.js';
import { db } from '../db/index.js';
import type { PipedStream } from '../upstream/piped.types.js';
import { playlistTracks } from '../db/schema.js';

// Media: track details, artwork, image proxy, stream urls, the stream relay and peaks.
export const mediaRouter = Router();

// Stream URL -> working replacement, for URLs the relay found dead (see /stream/:token).
const replacedStreamUrls = new LRUCache<string, string>({ max: 500, ttl: 3600_000 });

interface SelectedStream {
  url: string;
  itag: number;
  mimeType: string;
  codec: string;
  bitrate: number;
  contentLength: number;
  muxed: boolean;
}

const selectBestAudioStream = (
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
  // The muxed itag-18 stream is roughly 616 kbps of video plus only 48 kbps of AAC audio,
  // so we download about thirteen times the bytes we need and get noticeably worse audio
  // than a proper adaptive opus stream. It exists so playback works while the upstream
  // extractor cannot produce adaptive audio formats, and it should stop being used the
  // moment audioStreams comes back non-empty.
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

// Large thumbnails aren't guaranteed: maxresdefault and hq720 are missing for some videos,
// and a client (the lock screen especially) can't fall back on its own. Probe once per video.
const largeThumbs = new LRUCache<string, YtThumbName>({ max: 5000, ttl: 7 * 24 * 3600_000 });

const largestThumb = async (videoId: string): Promise<YtThumbName> => {
  const known = largeThumbs.get(videoId);
  if (known) return known;
  let found: YtThumbName = 'mqdefault';
  for (const name of ['maxresdefault', 'hq720'] as const) {
    try {
      const head = await request(ytThumbUrl(videoId, name), { method: 'HEAD' });
      await head.body.dump();
      if (head.statusCode === 200) {
        found = name;
        break;
      }
    } catch {
      // Network trouble: fall through to the one size that always exists.
    }
  }
  largeThumbs.set(videoId, found);
  return found;
};

mediaRouter.get('/tracks/:id', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const streams = await CachedPiped.getStream(rawId);

  // Select best audio stream (or muxed fallback if adaptive audio is absent).
  // Codec and bitrate are null only when upstream yields no audio streams at all (neither adaptive nor muxed).
  let codecStr: string | null = null;
  let bitrate: number | null = null;
  const best = selectBestAudioStream(streams.audioStreams, 'auto', undefined, streams.videoStreams);
  if (best) {
    codecStr = best.codec;
    bitrate = best.bitrate;
  }

  const userFields = await getUserTrackFields(req.user?.id, rawId);
  const track = normalizeStreamToTrack(streams, rawId, codecStr ?? undefined, bitrate ?? undefined, userFields);
  res.json(track);
});

mediaRouter.get('/tracks/:id/artwork', async (req, res) => {
  const { size } = req.query;
  const rawId = idHelpers.extractYtId(req.params.id);

  // hqdefault is 4:3 with black bars baked in, which shows as letterboxing in square
  // artwork. mqdefault is 16:9 without bars and exists for every video.
  const thumbRes = size === '640' ? await largestThumb(rawId) : 'mqdefault';

  res.redirect(302, ytThumbUrl(rawId, thumbRes));
});

const handlePlaylistArtwork = async (req: Request<{ id: string }>, res: Response) => {
  const rawId = req.params.id;
  const size = req.query.size as string;

  if (rawId.startsWith('sonare:')) {
    try {
      const [firstTrack] = await db
        .select({
          kind: playlistTracks.trackRefKind,
          refId: playlistTracks.trackRefId,
        })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, rawId))
        .orderBy(playlistTracks.position)
        .limit(1);

      if (firstTrack && firstTrack.kind === 'server') {
        const thumbSize = size ? `?size=${size}` : '';
        res.redirect(302, `/api/v1/tracks/yt:${firstTrack.refId}/artwork${thumbSize}`);
        return;
      }
    } catch {}
    res.status(404).end();
    return;
  }

  try {
    const playlistId = idHelpers.extractYtId(rawId);
    // Prefer the resizable cover seen in search/artist results over the playlist's
    // signed full-size one; it also skips a Piped round trip.
    const known = await albumThumbFor(playlistId);
    const source = known ?? (await CachedPiped.playlist(playlistId)).thumbnailUrl;
    if (!source) {
      res.status(404).end();
      return;
    }

    let thumbUrl = source;
    const targetSize = size === '64' ? 64 : size === '140' ? 140 : size === '300' ? 300 : size === '640' ? 640 : null;
    // Album covers are signed (/s_p/...&rs=...); renaming the file breaks the signature.
    const signed = /[?&]rs=/.test(thumbUrl);
    if (targetSize && !signed) {
      if (targetSize <= 140) {
        thumbUrl = thumbUrl.replace('/maxresdefault.jpg', '/mqdefault.jpg').replace('/hqdefault.jpg', '/mqdefault.jpg');
      } else if (targetSize <= 300) {
        thumbUrl = thumbUrl.replace('/maxresdefault.jpg', '/hqdefault.jpg');
      }
      thumbUrl = thumbUrl.replace(/=s\d+/, `=s${targetSize}`).replace(/=w\d+-h\d+/, `=w${targetSize}-h${targetSize}`);
    }

    res.redirect(302, proxyImageUrl(thumbUrl)!);
  } catch {
    res.status(404).end();
  }
};

mediaRouter.get('/albums/:id/artwork', handlePlaylistArtwork);
mediaRouter.get('/playlists/:id/artwork', handlePlaylistArtwork);

mediaRouter.get('/artists/:id/artwork', async (req, res) => {
  try {
    const rawId = idHelpers.extractYtId(req.params.id);
    const size = req.query.size as string;
    const channel = await CachedPiped.channel(rawId);
    if (!channel.avatarUrl) {
      res.status(404).end();
      return;
    }

    let avatarUrl = channel.avatarUrl;
    const targetSize = size === '64' ? 64 : size === '140' ? 140 : size === '300' ? 300 : size === '640' ? 640 : null;
    if (targetSize) {
      avatarUrl = avatarUrl.replace(/=s\d+/, `=s${targetSize}`).replace(/=w\d+-h\d+/, `=w${targetSize}-h${targetSize}`);
    }

    res.redirect(302, proxyImageUrl(avatarUrl)!);
  } catch {
    res.status(404).end();
  }
});

mediaRouter.get('/image/:token', async (req, res) => {
  const { token } = req.params;
  const data = verifyStreamToken(token);

  // Tokens signed before images went direct still name the Piped proxy that was current then.
  const upstreamRes = await request(directImageUrl(data.url));
  if (upstreamRes.statusCode === 200 || upstreamRes.statusCode === 206) {
    res.status(upstreamRes.statusCode);
    if (upstreamRes.headers['content-length'])
      res.setHeader('Content-Length', upstreamRes.headers['content-length'] as string);
    if (upstreamRes.headers['content-type'])
      res.setHeader('Content-Type', upstreamRes.headers['content-type'] as string);
    upstreamRes.body.on('error', () => {});
    req.on('close', () => {
      try {
        upstreamRes.body.destroy();
      } catch {}
    });
    upstreamRes.body.pipe(res);
  } else {
    await upstreamRes.body.dump();
    res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to proxy image' } });
  }
});

mediaRouter.get('/tracks/:id/stream', async (req, res) => {
  const { quality = 'auto', format } = req.query;
  const rawId = idHelpers.extractYtId(req.params.id);

  const streams = await CachedPiped.getStream(rawId);
  const best = selectBestAudioStream(streams.audioStreams, quality as string, format as string, streams.videoStreams);
  if (!best) {
    throw new NoAudioStreamError('No audio streams found');
  }

  const expiresAt = Date.now() + 3600_000;
  const token = signStreamToken(best.url, 3600_000, { vid: rawId, itag: best.itag });

  res.json({
    url: `/api/v1/stream/${token}`,
    mimeType: best.mimeType,
    codec: best.codec,
    bitrateKbps: Math.floor(best.bitrate / 1000),
    // 0 when YouTube didn't say (NewPipe reports -1): clients treat it as unknown.
    contentLength: best.contentLength > 0 ? best.contentLength : 0,
    expiresAt,
    muxed: best.muxed,
    // Lets a paused download check that a refreshed url still points at the same file.
    itag: best.itag,
  });
});

mediaRouter.get('/tracks/:id/peaks', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const barsStr = req.query.bars as string;
  const bars = barsStr ? parseInt(barsStr, 10) : 150;

  const cacheKey = `${rawId}:${bars}`;
  let peaks = await PermanentCache.getPeaks(cacheKey);
  // Older versions cached the placeholder for good when extraction failed; look again.
  if (peaks && isPlaceholderPeaks(rawId, bars, peaks)) peaks = null;
  if (!peaks && (await PermanentCache.peaksFailedRecently(cacheKey))) peaks = placeholderPeaks(rawId, bars);
  if (!peaks) {
    let urlStr = '';
    try {
      const streams = await CachedPiped.getStream(rawId);
      const best = selectBestAudioStream(streams.audioStreams, 'low', undefined, streams.videoStreams);
      if (best) {
        urlStr = best.url;
      }
    } catch (e) {
      // Suppress piped errors for peaks
    }

    peaks = await extractPeaks(urlStr, rawId, bars);
    // Only real waveforms are kept for good; a placeholder is retried in an hour.
    if (isPlaceholderPeaks(rawId, bars, peaks)) await PermanentCache.markPeaksFailed(cacheKey);
    else await PermanentCache.setPeaks(cacheKey, peaks);
  }

  res.json({ peaks });
});

mediaRouter.get('/stream/:token', async (req, res) => {
  const { token } = req.params;
  const data = verifyStreamToken(token);

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };

  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  let url = replacedStreamUrls.get(data.url) ?? data.url;
  let upstreamRes = await request(url, { headers });

  // YouTube sometimes hands out URLs that serve only the first ~1MB and 403 the rest.
  // A fresh extraction usually yields a working one, so swap it in once and remember
  // the swap - the player keeps seeking with the same token.
  if (upstreamRes.statusCode === 403 && data.vid && data.itag) {
    await upstreamRes.body.dump();
    const fresh = await CachedPiped.refreshStream(data.vid);
    const match = [...(fresh.audioStreams ?? []), ...(fresh.videoStreams ?? [])].find((s) => s.itag === data.itag);
    if (match) {
      replacedStreamUrls.set(data.url, match.url);
      url = match.url;
      upstreamRes = await request(url, { headers });
    }
  }

  if (upstreamRes.statusCode === 206 || upstreamRes.statusCode === 200) {
    res.status(upstreamRes.statusCode);

    if (upstreamRes.headers['content-range']) {
      res.setHeader('Content-Range', upstreamRes.headers['content-range'] as string);
    }
    if (upstreamRes.headers['content-length']) {
      res.setHeader('Content-Length', upstreamRes.headers['content-length'] as string);
    }
    if (upstreamRes.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges'] as string);
    }
    if (upstreamRes.headers['content-type']) {
      res.setHeader('Content-Type', upstreamRes.headers['content-type'] as string);
    }

    upstreamRes.body.on('error', () => {});
    req.on('close', () => {
      try {
        upstreamRes.body.destroy();
      } catch {}
    });

    upstreamRes.body.pipe(res);
  } else if ((upstreamRes.statusCode === 416 || upstreamRes.statusCode === 400) && req.headers.range) {
    // A range past the end (YouTube says 416, Piped's proxy 400) should come back as 416
    // with the size rather than look like a dead url, so a download that already has
    // every byte can finish instead of refreshing its url. Two bytes tell us the size
    // (Piped's proxy answers `bytes=0-0` with the whole file).
    await upstreamRes.body.dump();
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range)?.[1]);
    const probe = await request(url, { headers: { ...headers, Range: 'bytes=0-1' } });
    await probe.body.dump();
    const total = Number(String(probe.headers['content-range'] ?? '').split('/')[1]);
    if (total > 0 && start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      res.status(416).end();
    } else {
      res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to proxy stream' } });
    }
  } else {
    await upstreamRes.body.dump();
    res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to proxy stream' } });
  }
});
