import { createApp } from './app.js';
import { config } from './config.js';
import { verifyDatabase } from './db/index.js';
import { flushTelemetry, startTelemetry } from './services/telemetry.js';
import { logger } from './logger.js';
import { mailConfigured } from './services/mail.js';
import { loadSettings, pipedApiUrl } from './services/settings.js';
import { loadAiProviders, seedAiProvidersFromEnv } from './services/ai/providers.js';
import { startAiHealthChecks } from './services/ai/health.js';
import { startTitlesWorker } from './services/ai/titles.js';

const start = async () => {
  await verifyDatabase();
  await loadSettings();
  await loadAiProviders();
  await seedAiProvidersFromEnv();
  startAiHealthChecks();
  startTitlesWorker();
  startTelemetry();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(`Sonare backend listening on port ${config.PORT}`);
    logger.info(`Piped upstream mapped to ${pipedApiUrl()}`);
    if (mailConfigured()) logger.info('Mail goes out through the Resend API');
    else logger.warn('Mail is off: set RESEND_API_KEY to send verification and password-reset emails');
  });

  const shutdown = () => {
    logger.info('Shutting down...');
    server.close(() => {
      logger.info('HTTP server closed');
      // Write out the request and error logs still buffered.
      void flushTelemetry().finally(() => process.exit(0));
    });

    // Force close if lingering
    setTimeout(() => {
      logger.error('Forcing exit after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start();
