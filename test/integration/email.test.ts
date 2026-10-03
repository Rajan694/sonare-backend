import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';

// No SMTP server in tests: capture what would have been sent.
const sendMail = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/mail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mail.js')>()),
  sendMail,
}));

import { createApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { emailTokens, refreshTokens, users } from '../../src/db/schema.js';
import { hashToken } from '../../src/middleware/auth.js';
import { createUser } from '../factories.js';

/** The raw token from the link in the most recent email. */
function lastMailToken(): string {
  const { text } = sendMail.mock.calls.at(-1)![0] as { text: string };
  return text.match(/token=([0-9a-f]+)/)![1];
}

describe('Email verification and password reset', () => {
  const app = createApp();

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
  });

  async function register(email = 'new@example.com', password = 'password123') {
    return request(app).post('/api/v1/auth/register').send({ email, password, displayName: 'New' });
  }

  it('BE-EMAIL-001: register sends a verify link and stores only the token hash', async () => {
    const res = await register('Mixed@Example.com ');
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('mixed@example.com');
    expect(res.body.user.emailVerified).toBe(false);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('mixed@example.com');
    expect(mail.text).toContain('http://localhost:5183/verify-email?token=');

    const raw = lastMailToken();
    const rows = await db.select().from(emailTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('verify');
    expect(rows[0].tokenHash).toBe(hashToken(raw));
    expect(rows[0].tokenHash).not.toBe(raw);
  });

  it('BE-EMAIL-002: register still succeeds when the email cannot be sent', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('BE-EMAIL-003: verify-email marks the account verified and the link works once', async () => {
    const reg = await register();
    const token = lastMailToken();

    const first = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(me.body.emailVerified).toBe(true);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'new@example.com', password: 'password123' });
    expect(login.body.user.emailVerified).toBe(true);

    const again = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('BE-EMAIL-004: verify-email rejects an expired or unknown token', async () => {
    await register();
    const token = lastMailToken();
    await db.update(emailTokens).set({ expiresAt: new Date(Date.now() - 1000) });

    const expired = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('INVALID_TOKEN');

    const unknown = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'f'.repeat(64) });
    expect(unknown.status).toBe(400);
  });

  it('BE-EMAIL-005: resend-verification replaces the old link and is limited to 3 per hour', async () => {
    const reg = await register();
    const firstToken = lastMailToken();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/v1/auth/resend-verification').set(auth);
      expect(res.status).toBe(200);
    }
    const limited = await request(app).post('/api/v1/auth/resend-verification').set(auth);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    const old = await request(app).post('/api/v1/auth/verify-email').send({ token: firstToken });
    expect(old.status).toBe(400);
    const latest = await request(app).post('/api/v1/auth/verify-email').send({ token: lastMailToken() });
    expect(latest.status).toBe(200);
  });

  it('BE-EMAIL-006: resend-verification for a verified account sends nothing', async () => {
    const { token } = await createUser({ emailVerifiedAt: new Date() });
    const res = await request(app).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ ok: true, alreadyVerified: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('BE-EMAIL-007: forgot-password answers ok for an unknown email and sends nothing', async () => {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('BE-EMAIL-008: reset-password sets the new password and signs out every device', async () => {
    const { user, refreshToken } = await createUser({ email: 'reset@example.com' });

    const forgot = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'RESET@example.com' });
    expect(forgot.status).toBe(200);
    expect(sendMail.mock.calls[0][0].text).toContain('http://localhost:5183/reset-password?token=');
    const token = lastMailToken();

    const reset = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-pass' });
    expect(reset.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'reset@example.com', password: 'password123' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'reset@example.com', password: 'brand-new-pass' });
    expect(newLogin.status).toBe(200);

    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);

    // Opening the emailed link proves the address works.
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.emailVerifiedAt).not.toBeNull();

    const reuse = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'another-pass' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('BE-EMAIL-009: an invalid reset token changes nothing', async () => {
    const { user } = await createUser();
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'f'.repeat(64), password: 'brand-new-pass' });
    expect(res.status).toBe(400);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.passwordHash).toBe(user.passwordHash);
    const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(sessions.every((s) => !s.revoked)).toBe(true);
  });

  it('BE-EMAIL-010: passwords shorter than 8 characters are rejected', async () => {
    const reg = await register('short@example.com', 'seven77');
    expect(reg.status).toBe(400);
    expect(reg.body.error.message).toMatch(/at least 8/);

    const reset = await request(app).post('/api/v1/auth/reset-password').send({ token: 'abc', password: 'seven77' });
    expect(reset.status).toBe(400);
    expect(reset.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-EMAIL-011: forgot-password is limited to 3 requests per email per hour', async () => {
    await createUser({ email: 'spam@example.com' });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'spam@example.com' });
      expect(res.status).toBe(200);
    }
    const limited = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'spam@example.com' });
    expect(limited.status).toBe(429);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it('BE-EMAIL-012: login finds accounts registered before emails were lowercased', async () => {
    await createUser({ email: 'Legacy@Example.com' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'legacy@example.com', password: 'password123' });
    expect(res.status).toBe(200);
  });
});
