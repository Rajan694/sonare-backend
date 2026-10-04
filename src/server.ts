import { createApp } from './app.js';
import { config } from './config.js';
import { verifyDatabase } from './db/index.js';
import { flushTelemetry, startTelemetry } from './services/telemetry.js';
import { logger } from './logger.js';
import { hasFfmpeg } from './services/peaks.js';

async function start() {
  await verifyDatabase();
  startTelemetry();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(`Sonare backend listening on port ${config.PORT}`);
    logger.info(`Piped upstream mapped to ${config.PIPED_API_URL}`);
    if (!hasFfmpeg()) logger.warn('ffmpeg is not on the PATH: waveforms will be placeholders, not the real audio');
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
}

start();
