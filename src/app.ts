import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import cors from 'cors';
import { Piped, UpstreamError } from './upstream/piped.js';
import { CachedPiped } from './cache.js';
import { 
  normalizeStreamToTrack, 
  normalizeStreamItemToTrack, 
  normalizeStreamItemToArtist,
  normalizeStreamItemToAlbum,
  normalizeChannelTabAlbum,
  normalizeChannelToArtist, 
  normalizePlaylistToAlbum,
  albumThumbFor,
} from './normalize/index.js';
import { idHelpers } from './ids.js';
import { signStreamToken, verifyStreamToken } from './token.js';
import { request } from 'undici';
import { LyricsResolver } from './lyrics.js';
import { Lrclib } from './upstream/lrclib.js';
import { extractPeaks } from './peaks.js';
import { PermanentCache } from './cache.js';
import { BadRequestError, NoAudioStreamError } from './errors.js';
import { authRouter } from './routes/auth.routes.js';
import { meRouter } from './routes/me.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { clientErrorsRouter } from './routes/clientErrors.routes.js';
import { requestLogger } from './telemetry.js';
import { optionalAuth } from './auth.js';
import { getUserTrackFields, getUserTrackDataMap } from './db/user-data.js';
import { saveDbLyricsOverride, saveDbLyricsOffset, deleteDbLyricsOverride, getDbLyricsOverride } from './lyrics.js';
import { db } from './db/index.js';
import { playlistTracks, artistFollows } from './db/schema.js';
import { and, eq } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';

// Stream URL -> working replacement, for URLs the relay found dead (see /stream/:token).
const replacedStreamUrls = new LRUCache<string, string>({ max: 500, ttl: 3600_000 });

function encodeCursor(nextpage: string | null | undefined): string | undefined {
  if (!nextpage) return undefined;
  return Buffer.from(nextpage).toString('base64url');
}

function decodeCursor(cursor: any): string | undefined {
  if (typeof cursor !== 'string' || !cursor) return undefined;
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

interface SelectedStream {
  url: string;
  itag: number;
  mimeType: string;
  codec: string;
  bitrate: number;
  contentLength: number;
  muxed: boolean;
}

function selectBestAudioStream(
  audios: any[] | undefined,
  quality: string,
  format?: string,
  videoStreams?: any[]
): SelectedStream | null {
  // If adaptive audio streams exist, adaptive audio must still win
  if (audios && audios.length > 0) {
    const targets: Record<string, number> = { low: 64_000, auto: 160_000, high: Infinity };
    const target = targets[quality] || targets.auto;
    
    const sorted = audios.slice().sort((a, b) => b.bitrate - a.bitrate);
    let eligible = sorted.filter(a => a.bitrate <= target);
    if (eligible.length === 0) {
      eligible = [sorted[sorted.length - 1]];
    }

    // Contract 8.2 says prefer opus and fall back to mp4a only when there is no opus
    let best = undefined;
    if (!format || format === 'opus') {
      best = eligible.find(s => s.codec?.toLowerCase().includes('opus') || s.format?.toLowerCase().includes('opus') || s.codec?.toLowerCase().includes('webm') || s.format?.toLowerCase().includes('webm'));
    }
    if (!best && (!format || format === 'mp4a' || format === 'm4a')) {
      best = eligible.find(s => s.codec?.toLowerCase().includes('mp4a') || s.format?.toLowerCase().includes('m4a') || s.codec?.toLowerCase().includes('m4a') || s.format?.toLowerCase().includes('mp4a'));
    }
    
    if (!best) best = eligible[0];
    if (!best) best = sorted[0];

    if (best) {
      let mappedCodec = best.codec;
      if (best.codec?.toLowerCase().includes('opus') || best.format?.toLowerCase().includes('opus')) mappedCodec = 'OPUS';
      else if (best.codec?.toLowerCase().includes('mp4a') || best.format?.toLowerCase().includes('m4a') || best.format?.toLowerCase().includes('mp4a') || best.codec?.toLowerCase().includes('aac')) mappedCodec = 'AAC';

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
    const muxed = videoStreams.filter(s => s.videoOnly === false || s.itag === 18);
    if (muxed.length > 0) {
      // Prefer the smallest such stream since we only want the audio
      const sortedMuxed = muxed.slice().sort((a, b) => {
        const aVal = a.bitrate > 0 ? a.bitrate : (a.contentLength > 0 ? a.contentLength : Infinity);
        const bVal = b.bitrate > 0 ? b.bitrate : (b.contentLength > 0 ? b.contentLength : Infinity);
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
}

// Large thumbnails aren't guaranteed: maxresdefault and hq720 are missing for some videos,
// and a client (the lock screen especially) can't fall back on its own. Probe once per video.
const largeThumbs = new LRUCache<string, string>({ max: 5000, ttl: 7 * 24 * 3600_000 });

async function largestThumb(videoId: string): Promise<string> {
  const known = largeThumbs.get(videoId);
  if (known) return known;
  let found = 'mqdefault';
  for (const name of ['maxresdefault', 'hq720']) {
    try {
      const head = await request(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { method: 'HEAD' });
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
}

// Auto-generated "- Topic" artist channels come back from the extractor with no videos
// and no tabs, so pull the artist's catalog from YouTube Music search instead, keeping
// only results credited to this exact channel.
async function searchArtistCatalog(channelId: string, channelName: string | undefined, filter: 'music_songs' | 'music_albums'): Promise<any[]> {
  const name = (channelName || '').replace(/\s+-\s+Topic$/i, '').trim();
  if (!name) return [];
  const page = await CachedPiped.search(name, filter);
  return (page.items || []).filter((i: any) => i.uploaderUrl === `/channel/${channelId}`);
}

export function createApp() {
  const app = express();

  // maxAge: the apps' X-Sonare-Client header makes every request preflighted; cache that.
  // Downloads resume with Range requests and read the total size from Content-Range.
  app.use(cors({ origin: [/localhost/, /127\.0\.0\.1/], maxAge: 600, exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'] }));
  app.use(requestLogger());
  app.use(pinoHttp({
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  }));
  app.use(express.json());
  app.use(optionalAuth);

  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler => 
    (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

  const v1 = express.Router();

  v1.use('/auth', authRouter);
  v1.use('/me', meRouter);
  v1.use('/admin', adminRouter);
  v1.use('/client-errors', clientErrorsRouter);

  v1.get('/discover/made-for-you', (req, res) => {
    res.json({ items: [], meta: { total: 0 } });
  });

  v1.get('/healthz', asyncHandler(async (req, res) => {
    let pipedStatus = 'unknown';
    try {
      await Piped.healthcheck();
      pipedStatus = 'up';
    } catch (e) {
      pipedStatus = 'down';
    }
    res.json({ ok: true, version: '1.0.0', piped: pipedStatus });
  }));

  v1.get('/search/suggestions', asyncHandler(async (req, res) => {
    const q = req.query.q as string;
    if (!q || typeof q !== 'string') {
      throw new BadRequestError('Missing query parameter: q');
    }
    const suggestions = await CachedPiped.suggestions(q);
    res.json(suggestions);
  }));

  v1.get('/search', asyncHandler(async (req, res) => {
    const { q, type = 'all', cursor } = req.query;
    if (!q || typeof q !== 'string') {
      throw new BadRequestError('Missing query parameter: q');
    }

    const nextpage = decodeCursor(cursor);
    
    const typeMap: Record<string, string> = {
      songs: 'music_songs',
      albums: 'music_albums',
      artists: 'music_artists',
      playlists: 'music_playlists',
      all: 'all'
    };
    
    const filter = typeMap[typeof type === 'string' ? type : 'all'] || 'all';

    let results;
    let fallbackKindMap: Record<string, string> | undefined;

    if (filter === 'all' && !nextpage) {
      const [songs, albums, artists, playlists] = await Promise.all([
        CachedPiped.search(q, 'music_songs'),
        CachedPiped.search(q, 'music_albums'),
        CachedPiped.search(q, 'music_artists'),
        CachedPiped.search(q, 'music_playlists'),
      ]);
      
      const items = [
        ...songs.items.map(i => ({ ...i, __sonareKind: 'track' })),
        ...albums.items.map(i => ({ ...i, __sonareKind: 'album' })),
        ...artists.items.map(i => ({ ...i, __sonareKind: 'artist' })),
        ...playlists.items.map(i => ({ ...i, __sonareKind: 'playlist' }))
      ];
      results = { items, nextpage: null };
    } else {
      if (nextpage) {
        results = await CachedPiped.searchNextPage(q, nextpage, filter);
      } else {
        results = await CachedPiped.search(q, filter);
      }
    }

    const requestedKindMap: Record<string, string> = {
      'music_songs': 'track',
      'music_albums': 'album',
      'music_artists': 'artist',
      'music_playlists': 'playlist'
    };
    const expectedKind = filter !== 'all' ? requestedKindMap[filter] : undefined;

    const items = results.items.map(item => {
      let mapped;
      let mappedKind = (item as any).__sonareKind || expectedKind;
      
      // Sniff fallback if somehow missing
      if (!mappedKind) {
        if (item.type === 'playlist') mappedKind = 'album';
        else if (item.type === 'channel') mappedKind = 'artist';
        else mappedKind = 'track';
      }

      if (mappedKind === 'album' || mappedKind === 'playlist') {
         // Contract: types playlists & albums return Albums natively for search display
         mapped = normalizeStreamItemToAlbum(item);
         mappedKind = 'album'; // Map playlist hit to album shape
      } else if (mappedKind === 'artist') {
         mapped = normalizeStreamItemToArtist(item);
      } else {
         mapped = normalizeStreamItemToTrack(item);
      }
      return { kind: mappedKind, ...mapped };
    });

    res.json({
      items,
      meta: {
        nextCursor: encodeCursor(results.nextpage)
      }
    });
  }));

  v1.get('/trending', asyncHandler(async (req, res) => {
    const region = (req.query.region as string) || 'IN';
    const limitStr = req.query.limit as string;
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    let items: any[] = [];
    // The last upstream failure; reported only if it leaves nothing to show.
    let failure: unknown;
    try {
      const rawTrending = await CachedPiped.trending(region);
      const isMusicTrack = (t: any) => {
        if (!t || t.type !== 'stream') return false;
        if (t.isShort || !t.duration || t.duration <= 0) return false;
        if ((t as any).livestream) return false;
        
        const title = (t.title || '').toLowerCase();
        const uploader = (t.uploaderName || '').toLowerCase();
        
        // Exclude obvious non-music patterns (live news, streams, gaming, asmr, yoga)
        if (/\b(live|livestream|news|asmr|parkour|gameplay|minecraft|gta|vlog|roast|podcast|yoga)\b/i.test(title)) return false;
        
        // Music channel indicators
        if (t.uploaderName?.includes('- Topic') || uploader.includes('topic')) return true;
        if (uploader.includes('vevo') || uploader.includes('music') || uploader.includes('records') || uploader.includes('t-series') || uploader.includes('saregama') || uploader.includes('yrf') || uploader.includes('sony') || uploader.includes('zee') || uploader.includes('audio')) return true;
        
        // Video title music indicators (official video, audio, song, lyrical, ft, feat)
        if (/\b(official video|official audio|music video|lyric video|lyrics|feat|ft\.|prod\.)\b/i.test(title)) return true;

        return false;
      };

      items = rawTrending.filter(isMusicTrack);
    } catch (e) {
      failure = e;
    }

    // Ensure we always have sufficient high quality musical items for the Home carousel and trending shelf
    if (items.length < limit) {
      try {
        const musicSearch = await CachedPiped.search('trending music top songs', 'music_songs');
        const searchItems = musicSearch.items || [];
        const seenIds = new Set(items.map(i => i.url));
        for (const item of searchItems) {
          if (items.length >= limit) break;
          if (item.url && !seenIds.has(item.url) && item.duration && item.duration > 0) {
            seenIds.add(item.url);
            items.push(item);
          }
        }
      } catch (e) {
        failure = e;
      }
    }

    // Both sources failing is an outage, not an empty chart. Answering 200 with no items
    // made the apps say "nothing trending" while Piped was down.
    if (items.length === 0 && failure) throw failure;

    res.json({
      items: items.slice(0, limit).map(item => ({ kind: 'track', ...normalizeStreamItemToTrack(item) })),
      meta: {}
    });
  }));

  v1.get('/genres', (req, res) => {
    res.json([
      { id: 'ambient', name: 'Ambient' },
      { id: 'electronica', name: 'Electronica' },
      { id: 'post-rock', name: 'Post-rock' },
      { id: 'indie', name: 'Indie' },
      { id: 'jazz', name: 'Jazz' },
      { id: 'classical', name: 'Classical' },
      { id: 'hip-hop', name: 'Hip-hop' },
      { id: 'folk', name: 'Folk' },
    ]);
  });

  v1.get('/tracks/:id', asyncHandler(async (req, res) => {
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
  }));

  v1.get('/tracks/:id/artwork', asyncHandler(async (req, res) => {
    const { size } = req.query;
    const rawId = idHelpers.extractYtId(req.params.id);
    
    // hqdefault is 4:3 with black bars baked in, which shows as letterboxing in square
    // artwork. mqdefault is 16:9 without bars and exists for every video.
    const thumbRes = size === '640' ? await largestThumb(rawId) : 'mqdefault';

    res.redirect(302, `https://i.ytimg.com/vi/${rawId}/${thumbRes}.jpg`);
  }));

  const handlePlaylistArtwork = async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const size = req.query.size as string;

    if (rawId.startsWith('sonare:')) {
      try {
        const [firstTrack] = await db.select({
          kind: playlistTracks.trackRefKind,
          refId: playlistTracks.trackRefId,
        }).from(playlistTracks).where(eq(playlistTracks.playlistId, rawId)).orderBy(playlistTracks.position).limit(1);

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
      const known = albumThumbFor(playlistId);
      const source = known ?? (await CachedPiped.playlist(playlistId)).thumbnailUrl;
      if (!source) { res.status(404).end(); return; }

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

      res.redirect(302, `/api/v1/image/${signStreamToken(thumbUrl, 30 * 24 * 3600 * 1000)}`);
    } catch {
      res.status(404).end();
    }
  };

  v1.get('/albums/:id/artwork', asyncHandler(handlePlaylistArtwork));
  v1.get('/playlists/:id/artwork', asyncHandler(handlePlaylistArtwork));

  v1.get('/artists/:id/artwork', asyncHandler(async (req, res) => {
    try {
      const rawId = idHelpers.extractYtId(req.params.id);
      const size = req.query.size as string;
      const channel = await CachedPiped.channel(rawId);
      if (!channel.avatarUrl) { res.status(404).end(); return; }
      
      let avatarUrl = channel.avatarUrl;
      const targetSize = size === '64' ? 64 : size === '140' ? 140 : size === '300' ? 300 : size === '640' ? 640 : null;
      if (targetSize) {
        avatarUrl = avatarUrl.replace(/=s\d+/, `=s${targetSize}`).replace(/=w\d+-h\d+/, `=w${targetSize}-h${targetSize}`);
      }

      res.redirect(302, `/api/v1/image/${signStreamToken(avatarUrl, 30 * 24 * 3600 * 1000)}`);
    } catch {
      res.status(404).end();
    }
  }));

  v1.get('/image/:token', asyncHandler(async (req, res) => {
    const { token } = req.params;
    const data = verifyStreamToken(token);
    
    const upstreamRes = await request(data.url);
    if (upstreamRes.statusCode === 200 || upstreamRes.statusCode === 206) {
      res.status(upstreamRes.statusCode);
      if (upstreamRes.headers['content-length']) res.setHeader('Content-Length', upstreamRes.headers['content-length'] as string);
      if (upstreamRes.headers['content-type']) res.setHeader('Content-Type', upstreamRes.headers['content-type'] as string);
      upstreamRes.body.on('error', () => {});
      req.on('close', () => {
        try { upstreamRes.body.destroy(); } catch {}
      });
      upstreamRes.body.pipe(res);
    } else {
      await upstreamRes.body.dump();
      res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to proxy image' } });
    }
  }));

  v1.get('/tracks/:id/stream', asyncHandler(async (req, res) => {
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
      contentLength: best.contentLength,
      expiresAt,
      muxed: best.muxed,
      // Lets a paused download check that a refreshed url still points at the same file.
      itag: best.itag,
    });
  }));

  v1.get('/tracks/:id/peaks', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const barsStr = req.query.bars as string;
    const bars = barsStr ? parseInt(barsStr, 10) : 150;
    
    const cacheKey = `${rawId}:${bars}`;
    let peaks = await PermanentCache.getPeaks(cacheKey);
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
      await PermanentCache.setPeaks(cacheKey, peaks);
    }
    
    res.json({ peaks });
  }));

  v1.get('/tracks/:id/lyrics', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const prefer = req.query.prefer as string;
    
    let resolved;
    const dbOverride = await getDbLyricsOverride(rawId, req.user?.id);
    if (dbOverride && (dbOverride.lrc || dbOverride.plain)) {
      resolved = await LyricsResolver.resolve(rawId, '', '', undefined, undefined, req.user?.id);
    } else {
      resolved = await PermanentCache.getLyrics(rawId);
      if (!resolved) {
        const streams = await CachedPiped.getStream(rawId);
        const trackName = streams.title;
        const artistName = streams.uploader.replace(/\s*-\s*Topic$/i, '').trim(); 
        resolved = await LyricsResolver.resolve(rawId, trackName, artistName, undefined, streams.duration * 1000, req.user?.id);
        if (resolved) await PermanentCache.setLyrics(rawId, resolved);
      }
    }
    
    if (!resolved) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lyrics not found' } });
      return;
    }
    
    const response: any = { ...resolved };
    if (prefer === 'plain' && response.plain) {
      response.synced = false;
      response.lines = [];
    }
    
    res.json(response);
  }));

  v1.post('/tracks/:id/lyrics', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const { lrc, plain } = req.body;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    
    await saveDbLyricsOverride(rawId, userId, { lrc, plain });
    await PermanentCache.setLyrics(rawId, null);
    
    res.json({ ok: true });
  }));

  v1.patch('/tracks/:id/lyrics/offset', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const { offsetMs } = req.body;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    
    await saveDbLyricsOffset(rawId, userId, offsetMs);
    res.json({ ok: true });
  }));

  v1.delete('/tracks/:id/lyrics', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    await deleteDbLyricsOverride(rawId, req.user?.id);
    await PermanentCache.setLyrics(rawId, null);
    res.json({ ok: true });
  }));

  v1.get('/lyrics/search', asyncHandler(async (req, res) => {
    const { track, artist, album, durationSec } = req.query;
    if (!track) {
      throw new BadRequestError('Missing track parameter');
    }
    const results = await Lrclib.search(undefined, track as string, artist as string, album as string);
    res.json(results || []);
  }));

  v1.get('/albums/:id', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const playlist = await CachedPiped.playlist(rawId);
    res.json(normalizePlaylistToAlbum(playlist, rawId));
  }));

  v1.get('/albums/:id/tracks', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const { cursor } = req.query;
    const nextpage = decodeCursor(cursor);
    
    let tracks, nextCursor = undefined;
    
    if (nextpage) {
      const paged = await CachedPiped.playlistNextPage(rawId, nextpage);
      tracks = paged.relatedStreams || [];
      nextCursor = paged.nextpage;
    } else {
      const playlist = await CachedPiped.playlist(rawId);
      tracks = playlist.relatedStreams || [];
      nextCursor = playlist.nextpage;
    }
    
    res.json({
      items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
      meta: { nextCursor: encodeCursor(nextCursor) }
    });
  }));

  v1.get('/artists/:id', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const channel = await CachedPiped.channel(rawId);
    const artist = normalizeChannelToArtist(channel, rawId);
    if (req.user) {
      const [follow] = await db.select({ artistId: artistFollows.artistId }).from(artistFollows)
        .where(and(eq(artistFollows.userId, req.user.id), eq(artistFollows.artistId, rawId))).limit(1);
      artist.following = !!follow;
    }
    res.json(artist);
  }));

  v1.get('/artists/:id/top-tracks', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const limitStr = req.query.limit as string;
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    
    const channel = await CachedPiped.channel(rawId);
    let tracks = channel.relatedStreams || [];
    if (tracks.length === 0) tracks = await searchArtistCatalog(rawId, channel.name, 'music_songs');
    tracks = tracks.slice(0, limit);
    
    res.json({
      items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
      meta: {}
    });
  }));

  v1.get('/artists/:id/albums', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const { cursor } = req.query;
    
    let items = [], nextCursor = undefined;
    
    if (cursor) {
      const data = decodeCursor(cursor);
      if (data) {
        const tabData = await Piped.channelTabs(data);
        items = tabData.content || [];
        nextCursor = tabData.nextpage;
      }
    } else {
      const channel = await CachedPiped.channel(rawId);
      const albumsTab = channel.tabs?.find((t: any) => t.name.toLowerCase() === 'albums' || t.name.toLowerCase() === 'releases');
      if (albumsTab && albumsTab.data) {
        const tabData = await Piped.channelTabs(albumsTab.data);
        items = tabData.content || [];
        nextCursor = tabData.nextpage;
      } else {
        items = await searchArtistCatalog(rawId, channel.name, 'music_albums');
      }
    }
    
    res.json({
      items: items.map((i: any) => ({ kind: 'album', ...normalizeChannelTabAlbum(i) })),
      meta: { nextCursor: encodeCursor(nextCursor) }
    });
  }));

  v1.get('/playlists/:id', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const playlist = await CachedPiped.playlist(rawId);
    res.json({
      id: idHelpers.prefixYt(rawId),
      name: playlist.name,
      kind: 'online',
      trackCount: playlist.videos >= 0 ? playlist.videos : null,
      downloadedCount: 0,
      updatedAt: Date.now() // TODO(phase3): updatedAt will come from the Sonare DB
    });
  }));

  v1.get('/playlists/:id/tracks', asyncHandler(async (req, res) => {
    const rawId = idHelpers.extractYtId(req.params.id);
    const { cursor } = req.query;
    const nextpage = decodeCursor(cursor);
    
    let tracks, nextCursor = undefined;
    if (nextpage) {
      const paged = await CachedPiped.playlistNextPage(rawId, nextpage);
      tracks = paged.relatedStreams || [];
      nextCursor = paged.nextpage;
    } else {
      const playlist = await CachedPiped.playlist(rawId);
      tracks = playlist.relatedStreams || [];
      nextCursor = playlist.nextpage;
    }
    
    res.json({
      items: tracks.map((t: any) => ({ kind: 'track', ...normalizeStreamItemToTrack(t) })),
      meta: { nextCursor: encodeCursor(nextCursor) }
    });
  }));

  v1.get('/stream/:token', asyncHandler(async (req, res) => {
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
      const match = [...(fresh.audioStreams ?? []), ...(fresh.videoStreams ?? [])].find(s => s.itag === data.itag);
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
    } else {
      await upstreamRes.body.dump();
      res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to proxy stream' } });
    }
  }));

  app.use('/api/v1', v1);

  app.use((req, res, next) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    req.log.error(err);
    // The request logger records it in error_logs if this ends up a 5xx.
    res.locals.error = err;
    
    if (err instanceof NoAudioStreamError || err.code === 'NO_AUDIO_STREAM' || err.status === 503) {
      res.status(503).json({
        error: { code: 'NO_AUDIO_STREAM', message: err.message }
      });
      return;
    }

    if (err instanceof BadRequestError) {
      res.status(err.status).json({
        error: { code: 'BAD_REQUEST', message: err.message }
      });
      return;
    }
    
    if (err instanceof UpstreamError) {
      res.status(502).json({
        error: { code: err.unreachable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR', message: err.message }
      });
      return;
    }
    
    if (err.message === 'Token expired' || err.message === 'Invalid signature' || err.message === 'Invalid token format') {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: err.message }
      });
      return;
    }
    
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
      }
    });
  });

  return app;
}
