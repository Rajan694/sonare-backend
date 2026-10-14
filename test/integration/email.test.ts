import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';

// No Resend in tests: capture what would have been sent.
const sendMail = vi.hoisted(() => vi.fn());
const mailConfigured = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/mail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mail.js')>()),
  sendMail,
  mailConfigured,
}));

import { createApp } from '../../src/app.js';
import { MailError } from '../../src/errors.js';
import { db } from '../../src/db/index.js';
import { emailTokens, refreshTokens, users } from '../../src/db/schema.js';
import { hashToken } from '../../src/middleware/auth.js';
import { createUser } from '../factories.js';

/** The raw token from the link in the most recent email. */
const lastMailToken = (): string => {
  const { text } = sendMail.mock.calls.at(-1)![0] as { text: string };
  return text.match(/token=([0-9a-f]+)/)![1];
};

/** The 6-digit code in the most recent email. */
const lastMailCode = (): string => {
  const { text } = sendMail.mock.calls.at(-1)![0] as { text: string };
  return text
    .match(/code is (\d{3}) (\d{3})/)!
    .slice(1)
    .join('');
};

describe('Email verification and password reset', () => {
  const app = createApp();

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    mailConfigured.mockReset();
    mailConfigured.mockReturnValue(true);
  });

  const register = async (email = 'new@example.com', password = 'password123') => {
    return request(app).post('/api/v1/auth/register').send({ email, password, displayName: 'New' });
  };

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
    expect(rows.map((r) => r.purpose).sort()).toEqual(['verify', 'verify-code']);
    const link = rows.find((r) => r.purpose === 'verify')!;
    expect(link.tokenHash).toBe(hashToken(raw));
    expect(link.tokenHash).not.toBe(raw);
    // The code is stored hashed with its account, never as the digits.
    const code = rows.find((r) => r.purpose === 'verify-code')!;
    expect(code.tokenHash).toBe(hashToken(`${res.body.user.id}:${lastMailCode()}`));
  });

  it('BE-EMAIL-002: register still succeeds when the email cannot be sent', async () => {
    sendMail.mockRejectedValueOnce(new MailError('MAIL_FAILED'));
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

  const login = (email: string) => {
    return request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
  };

  it('BE-EMAIL-013: signing in to an unverified account sends a fresh verify link', async () => {
    await createUser({ email: 'pending@example.com' });
    const res = await login('pending@example.com');
    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(false);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('pending@example.com');
    expect(mail.subject).toBe('Verify your Sonare email address');
    expect(mail.text).toContain('http://localhost:5183/verify-email?token=');
  });

  it('BE-EMAIL-014: signing in to a verified account sends nothing', async () => {
    await createUser({ email: 'done@example.com', emailVerifiedAt: new Date() });
    const res = await login('done@example.com');
    expect(res.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('BE-EMAIL-015: sign-in links share the 3-an-hour limit and a mail failure never blocks signing in', async () => {
    await createUser({ email: 'often@example.com' });
    sendMail.mockRejectedValueOnce(new MailError('MAIL_FAILED', { cause: new Error('Resend answered 500: down') }));
    for (let i = 0; i < 4; i++) {
      const res = await login('often@example.com');
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    }
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(3));
    // The limit is the one "Resend" uses, so it is used up too.
    const token = (await login('often@example.com')).body.accessToken as string;
    const resend = await request(app).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${token}`);
    expect(resend.status).toBe(429);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("BE-EMAIL-016: resend-verification says when the mail didn't go out instead of answering ok", async () => {
    const reg = await register();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };

    sendMail.mockRejectedValueOnce(new MailError('MAIL_FAILED', { cause: new Error('Resend answered 403: nope') }));
    const failed = await request(app).post('/api/v1/auth/resend-verification').set(auth);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('MAIL_FAILED');
    expect(failed.body.error.message).not.toContain('Resend');

    sendMail.mockRejectedValueOnce(new MailError('MAIL_UNAVAILABLE'));
    const off = await request(app).post('/api/v1/auth/resend-verification').set(auth);
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('MAIL_UNAVAILABLE');
  });

  it("BE-EMAIL-017: forgot-password on a server that can't send mail says so for any address", async () => {
    mailConfigured.mockReturnValue(false);
    await createUser({ email: 'known@example.com' });
    for (const email of ['known@example.com', 'nobody@example.com']) {
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('MAIL_UNAVAILABLE');
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('BE-EMAIL-018: a failed reset mail still answers ok, so accounts cannot be probed', async () => {
    await createUser({ email: 'known@example.com' });
    sendMail.mockRejectedValueOnce(new MailError('MAIL_FAILED'));
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'known@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
const verifyCode = (accessToken: string, code: string) => {
  return request(app)
    .post('/api/v1/auth/verify-email-code')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ code });
};

it('BE-EMAIL-019: the emailed code verifies the signed-in account once, typed with or without a space', async () => {
  const reg = await register();
  const code = lastMailCode();
  const res = await verifyCode(reg.body.accessToken, `${code.slice(0, 3)} ${code.slice(3)}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${reg.body.accessToken}`);
  expect(me.body.emailVerified).toBe(true);
  const again = await verifyCode(reg.body.accessToken, code);
  expect(again.body).toEqual({ ok: true, alreadyVerified: true });
});

it('BE-EMAIL-020: a wrong code is refused, and the code stops working after 5 wrong tries', async () => {
  const reg = await register();
  const code = lastMailCode();
  const wrong = code === '000000' ? '111111' : '000000';

  const first = await verifyCode(reg.body.accessToken, wrong);
  expect(first.status).toBe(400);
  expect(first.body.error.code).toBe('INVALID_CODE');
  for (let i = 0; i < 3; i++) await verifyCode(reg.body.accessToken, wrong);
  const fifth = await verifyCode(reg.body.accessToken, wrong);
  expect(fifth.body.error.code).toBe('CODE_EXPIRED');

  const right = await verifyCode(reg.body.accessToken, code);
  expect(right.status).toBe(400);
  expect(right.body.error.code).toBe('CODE_EXPIRED');
  const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${reg.body.accessToken}`);
  expect(me.body.emailVerified).toBe(false);
});

it("BE-EMAIL-021: codes expire, only the newest works, and one account's code doesn't verify another", async () => {
  const reg = await register();
  const firstCode = lastMailCode();
  await request(app).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${reg.body.accessToken}`);
  const secondCode = lastMailCode();
  if (firstCode !== secondCode) {
    expect((await verifyCode(reg.body.accessToken, firstCode)).body.error.code).toBe('INVALID_CODE');
  }

  const other = await register('other@example.com');
  expect((await verifyCode(other.body.accessToken, secondCode)).status).toBe(400);

  await db.update(emailTokens).set({ expiresAt: new Date(Date.now() - 1000) });
  const late = await verifyCode(reg.body.accessToken, secondCode);
  expect(late.body.error.code).toBe('CODE_EXPIRED');
});

it('BE-EMAIL-022: verify-email-code needs a signed-in account and a 6-digit code', async () => {
  const anon = await request(app).post('/api/v1/auth/verify-email-code').send({ code: '123456' });
  expect(anon.status).toBe(401);
  const reg = await register();
  const bad = await verifyCode(reg.body.accessToken, '12ab56');
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe('BAD_REQUEST');
});
