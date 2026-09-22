import { createApp } from './app.js';
import { config } from './config.js';
import { verifyDatabase } from './db/index.js';

async function start() {
  await verifyDatabase();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`Sonare backend listening on port ${config.PORT}`);
    console.log(`Piped upstream mapped to ${config.PIPED_API_URL}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
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
