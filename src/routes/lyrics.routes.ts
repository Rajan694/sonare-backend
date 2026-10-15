import { Router } from 'express';
import { CachedPiped, PermanentCache } from '../services/cache.js';
import { idHelpers } from '../ids.js';
import {
  LyricsResolver,
  type ResolvedLyrics,
  saveDbLyricsOffset,
  getDbLyricsOverride,
  LYRICS_SCRIPTS,
  lyricsInScript,
  resolveLyricsInScript,
} from '../services/lyrics.js';
import { Lrclib } from '../upstream/lrclib.js';
import { LyricsUnavailableError, describeError } from '../errors.js';
import { z } from 'zod';
import { parseBody, parseQuery, queryInt } from '../validation.js';
import { getCatalogItems, type TrackMeta } from '../services/catalogMeta.js';

// Lyrics: resolve, per-user overrides and offsets, and LRCLIB search.
export const lyricsRouter = Router();

const clientLyricsKey = (rawId: string, title: string, artist: string): string =>
  `${rawId}|${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;

// Ten minutes either way is far more than any real timing drift.
const offsetSchema = z.object({
  offsetMs: z
    .number({ required_error: 'Missing offsetMs', invalid_type_error: 'offsetMs must be a number' })
    .int('offsetMs must be a whole number')
    .min(-600_000)
    .max(600_000),
});
const lyricsQuery = z.object({
  prefer: z.enum(['synced', 'plain']).optional(),
  // The user's preferred lyrics script (Settings); `original` or missing keeps what LRCLIB matched.
  script: z.enum(LYRICS_SCRIPTS).optional(),
  // Optional metadata for offline/fallback matching. When present, skip Piped stream lookup.
  title: z.string().trim().max(300).optional(),
  artist: z.string().max(300).optional(),
  durationMs: queryInt(0, 86_400_000).optional(),
});
const searchQuery = z.object({
  track: z.string({ required_error: 'Missing track parameter' }).trim().min(1, 'Missing track parameter').max(200),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
});

lyricsRouter.get('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const {
    prefer,
    script,
    title: queryTitle,
    artist: queryArtist,
    durationMs: queryDurationMs,
  } = parseQuery(lyricsQuery, req);

  let resolved: ResolvedLyrics | null = null;
  // 1. Look up server-known metadata in catalog_items first
  const catalogMap = await getCatalogItems<TrackMeta>('track', [rawId]);
  const serverTrack = catalogMap.get(rawId);
  const hasServerMeta = !!(serverTrack && serverTrack.title && serverTrack.artist);

  let streams: Awaited<ReturnType<typeof CachedPiped.getStream>> | null = null;
  const getPipedMeta = async () => {
    const s = (streams ??= await CachedPiped.getStream(rawId));
    return {
      title: s.title,
      artist: s.uploader.replace(/\s*-\s*Topic$/i, '').trim(),
      durationMs: s.duration * 1000,
    };
  };

  if (hasServerMeta) {
    // Server metadata wins over query params!
    // Use normal shared cache key (rawId)
    resolved = await PermanentCache.getLyrics(rawId);
    if ((resolved?.provider as string | undefined) === 'genius') resolved = null;

    if (!resolved) {
      resolved = await LyricsResolver.resolve(
        rawId,
        serverTrack.title,
        serverTrack.artist,
        undefined,
        serverTrack.durationMs ?? undefined,
      );
      if (resolved) await PermanentCache.setLyrics(rawId, resolved);
    }
  } else if (queryTitle && queryArtist) {
    // Server knows nothing, and client's title+artist are used.
    const clientKey = clientLyricsKey(rawId, queryTitle, queryArtist);

    // Reads with client metadata check the plain key first, then the client-keyed one.
    resolved = await PermanentCache.getLyrics(rawId);
    if ((resolved?.provider as string | undefined) === 'genius') resolved = null;

    if (!resolved) {
      resolved = await PermanentCache.getLyrics(clientKey);
      if ((resolved?.provider as string | undefined) === 'genius') resolved = null;
    }

    if (!resolved) {
      resolved = await LyricsResolver.resolve(rawId, queryTitle, queryArtist, undefined, queryDurationMs);
      // Never write plain rawId keys from client data.
      if (resolved) await PermanentCache.setLyrics(clientKey, resolved);
    }
  } else {
    // Server knows nothing and no client metadata: fall back to Piped
    resolved = await PermanentCache.getLyrics(rawId);
    if ((resolved?.provider as string | undefined) === 'genius') resolved = null;

    if (!resolved) {
      const m = await getPipedMeta();
      resolved = await LyricsResolver.resolve(rawId, m.title, m.artist, undefined, m.durationMs);
      if (resolved) await PermanentCache.setLyrics(rawId, resolved);
    }
  }

  // A preferred script the matched lyrics aren't in: look for that version, else keep the original.
  if (script && script !== 'original' && !(resolved && lyricsInScript(resolved, script))) {
    try {
      let inScript = null;
      if (hasServerMeta) {
        const cached = await PermanentCache.getScriptLyrics(rawId, script);
        inScript = cached ? cached.lyrics : null;
        if (!cached) {
          inScript = await resolveLyricsInScript(
            serverTrack.title,
            serverTrack.artist,
            serverTrack.durationMs ?? undefined,
            script,
          );
          await PermanentCache.setScriptLyrics(rawId, script, inScript);
        }
      } else if (queryTitle && queryArtist) {
        const clientKey = clientLyricsKey(rawId, queryTitle, queryArtist);
        const cached =
          (await PermanentCache.getScriptLyrics(rawId, script)) ??
          (await PermanentCache.getScriptLyrics(clientKey, script));
        inScript = cached ? cached.lyrics : null;
        if (!cached) {
          inScript = await resolveLyricsInScript(queryTitle, queryArtist, queryDurationMs || undefined, script);
          // Never write plain rawId keys from client data.
          await PermanentCache.setScriptLyrics(clientKey, script, inScript);
        }
      } else {
        const cached = await PermanentCache.getScriptLyrics(rawId, script);
        inScript = cached ? cached.lyrics : null;
        if (!cached) {
          const m = await getPipedMeta();
          inScript = await resolveLyricsInScript(m.title, m.artist, m.durationMs, script);
          await PermanentCache.setScriptLyrics(rawId, script, inScript);
        }
      }
      if (inScript) resolved = { ...inScript, offsetMs: resolved?.offsetMs ?? 0 };
    } catch {
      // The preference is best effort: the original lyrics (or the 404) stand, uncached.
    }
  }
  if (!resolved) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lyrics not found' } });
    return;
  }

  const response: ResolvedLyrics = { ...resolved };
  if (prefer === 'plain' && response.plain) {
    response.synced = false;
    response.lines = [];
  }

  // The listener's own timing offset (Earlier / Later); everyone else's lyrics carry none.
  const override = await getDbLyricsOverride(rawId, req.user?.id);
  response.offsetMs = override?.offsetMs ?? 0;
  res.json(response);
});

lyricsRouter.patch('/tracks/:id/lyrics/offset', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { offsetMs } = parseBody(offsetSchema, req);
  const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

  await saveDbLyricsOffset(rawId, userId, offsetMs);
  res.json({ ok: true });
});

lyricsRouter.get('/lyrics/search', async (req, res) => {
  const { track, artist, album } = parseQuery(searchQuery, req);
  const results = await Lrclib.search(undefined, track, artist, album).catch((e: unknown) => {
    req.log.warn({ err: describeError(e) }, 'LRCLIB search failed');
    throw new LyricsUnavailableError();
  });
  res.json(results || []);
});
