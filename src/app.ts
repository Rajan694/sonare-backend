import express from 'express';
import { pinoHttp } from 'pino-http';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './routes/auth.routes.js';
import { meRouter } from './routes/me.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { clientErrorsRouter } from './routes/clientErrors.routes.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { mediaRouter } from './routes/media.routes.js';
import { lyricsRouter } from './routes/lyrics.routes.js';
import { releasesRouter } from './routes/releases.routes.js';
import { requestLogger } from './services/telemetry.js';
import { optionalAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { config, corsOrigins, parseTrustProxy } from './config.js';
import { logger } from './logger.js';

const LOCALHOST_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp() {
  const app = express();
  const trustProxy = parseTrustProxy(config.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // maxAge: the apps' X-Sonare-Client header makes every request preflighted; cache that.
  // Downloads resume with Range requests and read the total size from Content-Range.
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        if (config.NODE_ENV !== 'production' && LOCALHOST_ORIGIN_REGEX.test(origin)) {
          return callback(null, true);
        }

        if (corsOrigins.includes(origin)) {
          return callback(null, true);
        }

        callback(null, false);
      },
      maxAge: 600,
      exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
    }),
  );
  app.use(requestLogger());
  // One line per request: method, URL, status and time. Headers stay out of the logs.
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json());
  app.use(optionalAuth);

  const v1 = express.Router();

  v1.use('/auth', authRouter);
  v1.use('/me', meRouter);
  v1.use('/admin', adminRouter);
  v1.use('/client-errors', clientErrorsRouter);
  v1.use(catalogRouter);
  v1.use(mediaRouter);
  v1.use(lyricsRouter);
  v1.use(releasesRouter);

  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use(errorHandler);

  return app;
}
