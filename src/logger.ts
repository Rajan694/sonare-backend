import { pino, type LevelWithSilent } from 'pino';
import { config } from './config.js';

// The one application logger. JSON lines in production, pretty-printed in development
// (pino-pretty is a devDependency), silent under the test runner.
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  }),
});

/**
 * pino-http's level for a finished request: only failures are logged. 5xx and requests that
 * threw are errors, 4xx warnings; everything else is silent.
 */
export const requestLogLevel = (_req: unknown, res: { statusCode: number }, err?: unknown): LevelWithSilent => {
  if (err || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'silent';
};
