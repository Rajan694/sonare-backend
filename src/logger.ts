import { pino } from 'pino';
import { config } from './config.js';

// The one application logger. JSON lines in production, pretty-printed in development
// (pino-pretty is a devDependency), silent under the test runner.
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  }),
});
