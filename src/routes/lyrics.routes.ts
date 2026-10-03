import { Router } from 'express';
import { CachedPiped, PermanentCache } from '../services/cache.js';
import { idHelpers } from '../ids.js';
import {
  LyricsResolver,
  saveDbLyricsOverride,
  saveDbLyricsOffset,
  deleteDbLyricsOverride,
  getDbLyricsOverride,
} from '../services/lyrics.js';
import { Lrclib } from '../upstream/lrclib.js';
import { BadRequestError } from '../errors.js';

// Lyrics: resolve, per-user overrides and offsets, and LRCLIB search.
export const lyricsRouter = Router();

lyricsRouter.get('/tracks/:id/lyrics', async (req, res) => {
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

  const response: any = { ...resolved };
  if (prefer === 'plain' && response.plain) {
    response.synced = false;
    response.lines = [];
  }

  res.json(response);
});

lyricsRouter.post('/tracks/:id/lyrics', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { lrc, plain } = req.body;
  const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

  await saveDbLyricsOverride(rawId, userId, { lrc, plain });
  await PermanentCache.setLyrics(rawId, null);

  res.json({ ok: true });
});

lyricsRouter.patch('/tracks/:id/lyrics/offset', async (req, res) => {
  const rawId = idHelpers.extractYtId(req.params.id);
  const { offsetMs } = req.body;
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
  const { track, artist, album } = req.query;
  if (!track) {
    throw new BadRequestError('Missing track parameter');
  }
  const results = await Lrclib.search(undefined, track as string, artist as string, album as string);
  res.json(results || []);
});
