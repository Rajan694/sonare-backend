import { Router } from 'express';
import { inAppYoutube, settingsUpdatedAt, youtubeClients } from '../services/settings.js';
import { aiAvailable } from '../services/ai/providers.js';

export const appConfigRouter = Router();

appConfigRouter.get('/app-config', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    inAppYoutube: inAppYoutube(),
    youtubeClients: youtubeClients(),
    updatedAt: settingsUpdatedAt(),
    // Some AI provider is answering: the apps show their AI features.
    ai: aiAvailable(),
  });
});
