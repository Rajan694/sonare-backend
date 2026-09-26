import { createApp } from './app.js';
import { config } from './config.js';
import { verifyDatabase } from './db/index.js';
import { loadSystemConfig, pipedApiUrl } from './systemConfig.js';
import { flushTelemetry, startTelemetry } from './telemetry.js';

async function start() {
  await verifyDatabase();
  await loadSystemConfig();
  startTelemetry();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`Sonare backend listening on port ${config.PORT}`);
    console.log(`Piped upstream mapped to ${pipedApiUrl()}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => {
      console.log('HTTP server closed');
      // Write out the request and error logs still buffered.
      void flushTelemetry().finally(() => process.exit(0));
    });
    
    // Force close if lingering
    setTimeout(() => {
      console.error('Forcing exit after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
