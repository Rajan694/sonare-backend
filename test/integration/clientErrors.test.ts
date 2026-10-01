import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createUser } from '../factories.js';

describe('Client error reporting', () => {
  const app = createApp();

  it('BE-ERR-001: POST /api/v1/client-errors accepts valid error report from web client', async () => {
    const res = await request(app)
      .post('/api/v1/client-errors')
      .send({
        source: 'web',
        level: 'error',
        message: 'Uncaught TypeError: Cannot read property of undefined',
        stack: 'Error: Cannot read property\n    at index.js:10:5',
        page: '/playlist/123',
        appVersion: '1.0.0',
        context: { route: '/playlist' },
      });

    expect(res.status).toBe(204);
  });

  it('BE-ERR-002: POST /api/v1/client-errors accepts warning report from linux client with auth', async () => {
    const { user, token } = await createUser();
    const res = await request(app).post('/api/v1/client-errors').set('Authorization', `Bearer ${token}`).send({
      source: 'linux',
      level: 'warning',
      message: 'Audio buffer underrun detected',
      page: '/player',
      appVersion: '1.2.0',
    });

    expect(res.status).toBe(204);
  });

  it('BE-ERR-003: POST /api/v1/client-errors rejects invalid source with 400', async () => {
    const res = await request(app).post('/api/v1/client-errors').send({
      source: 'unknown-client',
      message: 'Some error message',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ERR-004: POST /api/v1/client-errors rejects missing message with 400', async () => {
    const res = await request(app).post('/api/v1/client-errors').send({
      source: 'mobile',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ERR-005: POST /api/v1/client-errors rejects excessive context fields (>20) with 400', async () => {
    const bigContext: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      bigContext[`key_${i}`] = `value_${i}`;
    }

    const res = await request(app).post('/api/v1/client-errors').send({
      source: 'web',
      message: 'Test context overflow',
      context: bigContext,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
