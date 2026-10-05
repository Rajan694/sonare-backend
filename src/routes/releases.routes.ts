import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { appReleases } from '../db/schema.js';
import { releasePath, releaseView } from '../services/releases.js';

// Settings → About in the web app: the newest upload of each platform and format, and the files.
// The admin page uploads and deletes them (admin.routes.ts).
export const releasesRouter = Router();

releasesRouter.get('/releases', async (_req, res) => {
  const rows = await db
    .selectDistinctOn([appReleases.platform, appReleases.format])
    .from(appReleases)
    .orderBy(appReleases.platform, appReleases.format, sql`${appReleases.uploadedAt} DESC`);
  res.json({ items: rows.map(releaseView) });
});

releasesRouter.get('/releases/:id/download', async (req, res, next) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such download' } });
    return;
  }
  const [release] = await db.select().from(appReleases).where(eq(appReleases.id, id)).limit(1);
  if (!release) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such download' } });
    return;
  }

  // Resumed downloads come back with a Range; count each download once, at its start.
  // Express answers HEAD with this handler too; a HEAD is only a look, not a download.
  const range = req.headers.range;
  if (req.method === 'GET' && (!range || /^bytes=0-/.test(range))) {
    await db
      .update(appReleases)
      .set({ downloads: sql`${appReleases.downloads} + 1` })
      .where(eq(appReleases.id, id));
  }

  res.download(releasePath(release), release.fileName, { dotfiles: 'allow' }, (err) => {
    if (!err) return;
    if (res.headersSent) return;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(410).json({ error: { code: 'GONE', message: 'The file for this download is missing' } });
      return;
    }
    next(err);
  });
});
