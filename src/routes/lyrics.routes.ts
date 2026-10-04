import { Router } from 'express';
import { CachedPiped, PermanentCache } from '../services/cache.js';
import { idHelpers } from '../ids.js';
import {
  LyricsResolver,
  type ResolvedLyrics,
  saveDbLyricsOverride,
  saveDbLyricsOffset,
  deleteDbLyricsOverride,
  getDbLyricsOverride,
  LYRICS_SCRIPTS,
  lyricsInScript,
  resolveLyricsInScript,
} from '../services/lyrics.js';
import { Lrclib } from '../upstream/lrclib.js';
import { LyricsUnavailableError, describeError } from '../errors.js';
import { z } from 'zod';
import { parseBody, parseQuery } from '../validation.js';

// Lyrics: resolve, per-user overrides and offsets, and LRCLIB search.
export const lyricsRouter = Router();

const LRC_MAX = 100_000;
const overrideSchema = z
  .object({
    lrc: z.string().max(LRC_MAX, 'Lyrics are too long').optional(),
    plain: z.string().max(LRC_MAX, 'Lyrics are too long').optional(),
  })
  .refine((b) => b.lrc !== undefined || b.plain !== undefined, 'Send lrc or plain lyrics');
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
});
const searchQuery = z.object({
  track: z.string({ required_error: 'Missing track parameter' }).trim().min(1, 'Missing track parameter').max(200),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
});

lyricsRouter.get('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { prefer, script } = parseQuery(lyricsQuery, req);

  let resolved;
  const dbOverride = await getDbLyricsOverride(rawId, req.user?.id);
  if (dbOverride && (dbOverride.lrc || dbOverride.plain)) {
    // The user's own lyrics win over any preference.
    resolved = await LyricsResolver.resolve(rawId, '', '', undefined, undefined, req.user?.id);
  } else {
    resolved = await PermanentCache.getLyrics(rawId);
    // Genius results cached before it was dropped are only a link, no lyrics: look again.
    if ((resolved?.provider as string | undefined) === 'genius') resolved = null;
    let streams: Awaited<ReturnType<typeof CachedPiped.getStream>> | null = null;
    const meta = async () => {
      const s = (streams ??= await CachedPiped.getStream(rawId));
      return {
        title: s.title,
        artist: s.uploader.replace(/\s*-\s*Topic$/i, '').trim(),
        durationMs: s.duration * 1000,
      };
    };
    if (!resolved) {
      const m = await meta();
      resolved = await LyricsResolver.resolve(rawId, m.title, m.artist, undefined, m.durationMs, req.user?.id);
      if (resolved) await PermanentCache.setLyrics(rawId, resolved);
    }

    // A preferred script the matched lyrics aren't in: look for that version, else keep the original.
    if (script && script !== 'original' && !(resolved && lyricsInScript(resolved, script))) {
      try {
        const cached = await PermanentCache.getScriptLyrics(rawId, script);
        let inScript = cached ? cached.lyrics : null;
        if (!cached) {
          const m = await meta();
          inScript = await resolveLyricsInScript(m.title, m.artist, m.durationMs, script);
          await PermanentCache.setScriptLyrics(rawId, script, inScript);
        }
        if (inScript) resolved = { ...inScript, offsetMs: resolved?.offsetMs ?? 0 };
      } catch {
        // The preference is best effort: the original lyrics (or the 404) stand, uncached.
      }
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

  res.json(response);
});

lyricsRouter.post('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { lrc, plain } = parseBody(overrideSchema, req);
  const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

  await saveDbLyricsOverride(rawId, userId, { lrc, plain });
  await PermanentCache.setLyrics(rawId, null);

  res.json({ ok: true });
});

lyricsRouter.patch('/tracks/:id/lyrics/offset', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { offsetMs } = parseBody(offsetSchema, req);
  const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

  await saveDbLyricsOffset(rawId, userId, offsetMs);
  res.json({ ok: true });
});

lyricsRouter.delete('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  await deleteDbLyricsOverride(rawId, req.user?.id);
  await PermanentCache.setLyrics(rawId, null);
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
