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
} from '../services/lyrics.js';
import { Lrclib } from '../upstream/lrclib.js';
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
const lyricsQuery = z.object({ prefer: z.enum(['synced', 'plain']).optional() });
const searchQuery = z.object({
  track: z.string({ required_error: 'Missing track parameter' }).trim().min(1, 'Missing track parameter').max(200),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
});

lyricsRouter.get('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { prefer } = parseQuery(lyricsQuery, req);

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
      resolved = await LyricsResolver.resolve(
        rawId,
        trackName,
        artistName,
        undefined,
        streams.duration * 1000,
        req.user?.id,
      );
      if (resolved) await PermanentCache.setLyrics(rawId, resolved);
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
  const results = await Lrclib.search(undefined, track, artist, album);
  res.json(results || []);
});
