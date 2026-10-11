import { Router } from 'express';
import { inAppYoutube, settingsUpdatedAt, youtubeClients } from '../services/settings.js';

export const appConfigRouter = Router();

appConfigRouter.get('/app-config', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    inAppYoutube: inAppYoutube(),
    youtubeClients: youtubeClients(),
    updatedAt: settingsUpdatedAt(),
  });
});
