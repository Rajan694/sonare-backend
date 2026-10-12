import { describe, expect, it } from 'vitest';
import { requestLogLevel } from '../../src/logger.js';

describe('logger.ts', () => {
  it('BE-LOGGER-001: only failed requests are logged: 5xx and thrown errors as errors, 4xx as warnings', () => {
    expect(requestLogLevel({}, { statusCode: 200 })).toBe('silent');
    expect(requestLogLevel({}, { statusCode: 206 })).toBe('silent');
    expect(requestLogLevel({}, { statusCode: 302 })).toBe('silent');
    expect(requestLogLevel({}, { statusCode: 304 })).toBe('silent');
    expect(requestLogLevel({}, { statusCode: 401 })).toBe('warn');
    expect(requestLogLevel({}, { statusCode: 404 })).toBe('warn');
    expect(requestLogLevel({}, { statusCode: 429 })).toBe('warn');
    expect(requestLogLevel({}, { statusCode: 500 })).toBe('error');
    expect(requestLogLevel({}, { statusCode: 502 })).toBe('error');
    expect(requestLogLevel({}, { statusCode: 200 }, new Error('aborted'))).toBe('error');
  });
});
