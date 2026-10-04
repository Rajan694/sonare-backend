import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientOf, flushTelemetry, recordError, startTelemetry } from '../../src/services/telemetry.js';
import { db } from '../../src/db/index.js';
import { errorLogs } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('telemetry.ts: internals', () => {
  it('BE-TELEM-001: clientOf extracts valid x-sonare-client header', () => {
    const req1 = { get: (h: string) => (h === 'x-sonare-client' ? 'web' : undefined) } as unknown as Request;
    expect(clientOf(req1)).toBe('web');

    const req2 = { get: (h: string) => (h === 'x-sonare-client' ? 'linux' : undefined) } as unknown as Request;
    expect(clientOf(req2)).toBe('linux');

    const req3 = { get: (h: string) => (h === 'x-sonare-client' ? 'mobile' : undefined) } as unknown as Request;
    expect(clientOf(req3)).toBe('mobile');

    const req4 = { get: (h: string) => (h === 'x-sonare-client' ? 'unknown' : undefined) } as unknown as Request;
    expect(clientOf(req4)).toBeNull();
  });

  it('BE-TELEM-002: recordError aggregates burst errors with count', async () => {
    recordError({
      source: 'backend',
      level: 'error',
      message: 'Burst error duplicate message',
      route: '/api/v1/burst',
      status: 500,
    });
    recordError({
      source: 'backend',
      level: 'error',
      message: 'Burst error duplicate message',
      route: '/api/v1/burst',
      status: 500,
    });

    await flushTelemetry();

    const [logged] = await db.select().from(errorLogs).where(eq(errorLogs.message, 'Burst error duplicate message'));

    expect(logged).toBeDefined();
    expect(logged.count).toBe(2);
  });

  it('BE-TELEM-003: recordError buffers errors and flushes to database correctly', async () => {
    recordError({
      source: 'backend',
      level: 'error',
      message: 'Buffered error test message',
      route: '/api/v1/test',
      status: 500,
    });

    await flushTelemetry();

    const [logged] = await db.select().from(errorLogs).where(eq(errorLogs.message, 'Buffered error test message'));

    expect(logged).toBeDefined();
    expect(logged.source).toBe('backend');
    expect(logged.status).toBe(500);
  });
});

describe('telemetry.ts: error logs & startup', () => {
  it('BE-TELEM-COV-001: records error with long messages and stack traces', async () => {
    recordError({
      source: 'web',
      level: 'warning',
      code: 'UI_WARN',
      message: 'A'.repeat(3000),
      stack: 'B'.repeat(20000),
      userAgent: 'C'.repeat(600),
    });

    await flushTelemetry();

    const [found] = await db.select().from(errorLogs).where(eq(errorLogs.code, 'UI_WARN'));
    expect(found).toBeDefined();
    expect(found.message.length).toBeLessThanOrEqual(2001);
  });

  it('BE-TELEM-COV-002: startTelemetry initializes cleanly without duplicate runs', () => {
    startTelemetry();
    const listeners = process.listenerCount('uncaughtException');
    startTelemetry();
    expect(process.listenerCount('uncaughtException')).toBe(listeners);
  });
});
