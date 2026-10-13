import { Router } from 'express';
import { latestReleases } from '../services/releases.js';

// The app builds of the latest GitHub release: the apps' update check reads the list, and a
// download redirects to the file on GitHub.
export const releasesRouter = Router();

releasesRouter.get('/releases', async (_req, res) => {
  res.json({ items: await latestReleases() });
});

releasesRouter.get('/releases/:id/download', async (req, res) => {
  const release = /^\d+$/.test(req.params.id)
    ? (await latestReleases()).find((r) => r.id === req.params.id)
    : undefined;
  if (!release) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such download' } });
    return;
  }
  res.redirect(302, release.url);
});
