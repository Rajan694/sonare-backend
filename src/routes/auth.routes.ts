import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, refreshTokens } from '../db/schema.js';
import { forgetAuthUser, signAccessToken, generateRefreshToken, hashToken, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config.js';
import { parseBody } from '../validation.js';
import { mailConfigured, sendMail, verifyEmailMessage, resetPasswordMessage } from '../services/mail.js';
import { MailError } from '../errors.js';
import {
  createEmailToken,
  consumeEmailToken,
  consumeEmailCode,
  consumeVerifyCode,
  createEmailCode,
  createVerifyCode,
  RESET_AFTER_CODE_TTL_MS,
  RESET_CODE_TTL_MS,
  RESET_TOKEN_TTL_MS,
  VERIFY_TOKEN_TTL_MS,
} from '../services/emailTokens.js';
import { clientOf } from '../services/telemetry.js';

export const authRouter = Router();

const BCRYPT_COST = 10;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const loginLimiter = createRateLimiter({ name: 'login', max: 5, windowMs: 15 * 60_000 });
const registerLimiter = createRateLimiter({ name: 'register', max: 10, windowMs: 60 * 60_000 });
const resendLimiter = createRateLimiter({ name: 'verify-resend', max: 3, windowMs: 60 * 60_000 });
const forgotIpLimiter = createRateLimiter({ name: 'forgot-ip', max: 5, windowMs: 60 * 60_000 });
const forgotEmailLimiter = createRateLimiter({ name: 'forgot-email', max: 3, windowMs: 60 * 60_000 });
// Each code allows 5 guesses; this caps how many codes one address can have guessed at.
const resetCodeLimiter = createRateLimiter({ name: 'reset-code', max: 10, windowMs: 15 * 60_000 });
const changePasswordLimiter = createRateLimiter({ name: 'change-password', max: 5, windowMs: 15 * 60_000 });

const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');
const token = z.string().min(1, 'Missing token');

const registerSchema = z.object({ email, password, displayName: z.string().trim().min(1).max(100) });
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const forgotSchema = z.object({ email });
const resetSchema = z.object({ token, password });
const verifySchema = z.object({ token });
// "123 456" and "123-456" are accepted as typed.
const emailCode = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'));
const verifyCodeSchema = z.object({ code: emailCode });
const resetCodeSchema = z.object({ email, code: emailCode });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
const refreshSchema = z.object({
  refreshToken: z.string({ required_error: 'Missing refreshToken' }).min(1, 'Missing refreshToken').max(500),
});
const logoutSchema = z.object({ refreshToken: z.string().max(500).optional() });

const rateLimited = (res: Response, retryAfterSec: number) => {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} min.` },
  });
};

const invalidToken = (res: Response) => {
  res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' } });
};

// Accounts made before emails were lowercased keep their original case.
const findUserByEmail = (address: string) => {
  return db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, address))
    .limit(1)
    .then((rows) => rows[0]);
};

const userView = (user: typeof users.$inferSelect) => {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  };
};

const startSession = async (user: typeof users.$inferSelect) => {
  const refreshToken = generateRefreshToken();
  await db.insert(refreshTokens).values({ userId: user.id, token: hashToken(refreshToken) });
  return { accessToken: signAccessToken({ id: user.id, email: user.email }), refreshToken, user: userView(user) };
};

/** Throws MailError when the mail doesn't go out; callers decide whether that blocks the request. */
const sendVerifyEmail = async (user: typeof users.$inferSelect) => {
  const raw = await createEmailToken(user.id, 'verify', VERIFY_TOKEN_TTL_MS);
  const code = await createVerifyCode(user.id);
  const link = `${config.APP_URL}/verify-email?token=${raw}`;
  await sendMail({ to: user.email, ...verifyEmailMessage(link, code) });
};

const sendResetEmail = async (user: typeof users.$inferSelect) => {
  const raw = await createEmailToken(user.id, 'reset', RESET_TOKEN_TTL_MS);
  const code = await createEmailCode(user.id, 'reset-code', RESET_CODE_TTL_MS);
  const link = `${config.APP_URL}/reset-password?token=${raw}`;
  await sendMail({ to: user.email, ...resetPasswordMessage(link, code) });
};

const wrongCode = (res: Response) => {
  res
    .status(400)
    .json({ error: { code: 'INVALID_CODE', message: "That code isn't right. Check the email and try again." } });
};

const expiredCode = (res: Response) => {
  res.status(400).json({ error: { code: 'CODE_EXPIRED', message: 'That code no longer works. Send a new one.' } });
};

authRouter.post('/register', async (req, res) => {
  const limit = await registerLimiter.hit(req.ip ?? 'unknown');
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);

  const body = parseBody(registerSchema, req);
  if (await findUserByEmail(body.email)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Email already registered' } });
    return;
  }

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
  const signupClient = clientOf(req);
  const [user] = await db
    .insert(users)
    .values({ email: body.email, passwordHash, displayName: body.displayName, signupClient })
    .returning();

  // The account exists either way; Settings → "Resend" says what went wrong with the mail.
  await sendVerifyEmail(user).catch((err) => req.log.warn({ err }, 'verification email failed'));
  res.status(201).json(await startSession(user));
});

authRouter.post('/login', async (req, res) => {
  const body = parseBody(loginSchema, req);
  const limitKey = `${req.ip ?? 'unknown'}:${body.email}`;
  const lockout = await loginLimiter.blocked(limitKey);
  if (lockout.blocked) return rateLimited(res, lockout.retryAfterSec);

  const user = await findUserByEmail(body.email);
  // The admin account signs in on /admin only.
  if (!user || user.role !== 'user' || !(await bcrypt.compare(body.password, user.passwordHash))) {
    await loginLimiter.hit(limitKey);
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
    return;
  }

  await loginLimiter.reset(limitKey);
  const session = await startSession(user);
  // An unverified address gets a fresh link at each sign-in (at most 3 an hour, shared with
  // "Resend"), in the background: signing in doesn't wait for the mail server.
  if (!user.emailVerifiedAt && (await resendLimiter.hit(user.id)).allowed) {
    sendVerifyEmail(user).catch((err) => req.log.warn({ err }, 'verification email failed'));
  }
  res.json(session);
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = parseBody(refreshSchema, req);

  const [stored] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.token, hashToken(refreshToken)), eq(refreshTokens.revoked, false)))
    .limit(1);
  if (!stored || Date.now() - stored.createdAt.getTime() > REFRESH_TOKEN_TTL_MS) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked refresh token' } });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    return;
  }

  // Rotate: the spent row goes, the new one arrives in the same transaction.
  const newRefreshToken = generateRefreshToken();
  await db.transaction(async (tx) => {
    await tx.delete(refreshTokens).where(eq(refreshTokens.id, stored.id));
    await tx.insert(refreshTokens).values({ userId: user.id, token: hashToken(newRefreshToken) });
  });
  res.json({ accessToken: signAccessToken({ id: user.id, email: user.email }), refreshToken: newRefreshToken });
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = parseBody(logoutSchema, req);
  if (refreshToken) {
    await db.delete(refreshTokens).where(eq(refreshTokens.token, hashToken(refreshToken)));
  }
  res.json({ ok: true });
});

authRouter.post('/verify-email', async (req, res) => {
  const body = parseBody(verifySchema, req);
  const userId = await consumeEmailToken(body.token, 'verify');
  if (!userId) return invalidToken(res);

  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  res.json({ ok: true });
});

// The code from the email, typed into the app by the signed-in account it was sent to.
authRouter.post('/verify-email-code', requireAuth, async (req, res) => {
  const body = parseBody(verifyCodeSchema, req);
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (user.emailVerifiedAt) {
    res.json({ ok: true, alreadyVerified: true });
    return;
  }

  const result = await consumeVerifyCode(user.id, body.code);
  if (result === 'wrong') return wrongCode(res);
  if (result === 'expired') return expiredCode(res);
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)));
  res.json({ ok: true });
});

authRouter.post('/resend-verification', requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (user.emailVerifiedAt) {
    res.json({ ok: true, alreadyVerified: true });
    return;
  }

  const limit = await resendLimiter.hit(user.id);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);

  // Throws MailError, which tells the app the mail didn't go out.
  await sendVerifyEmail(user);
  res.json({ ok: true });
});

// Answers ok whether or not the address has an account, so it can't be used to probe for accounts.
// A server that can't send mail at all says so to everyone; a failed send is only logged.
authRouter.post('/forgot-password', async (req, res) => {
  const body = parseBody(forgotSchema, req);
  if (!mailConfigured()) throw new MailError('MAIL_UNAVAILABLE');
  const byIp = await forgotIpLimiter.hit(req.ip ?? 'unknown');
  if (!byIp.allowed) return rateLimited(res, byIp.retryAfterSec);
  const byEmail = await forgotEmailLimiter.hit(body.email);
  if (!byEmail.allowed) return rateLimited(res, byEmail.retryAfterSec);

  const user = await findUserByEmail(body.email);
  if (user?.role === 'user') {
    await sendResetEmail(user).catch((err) => req.log.warn({ err }, 'password reset email failed'));
  }
  res.json({ ok: true });
});

// The apps' "Forgot password": the code from the reset email, for that address, buys a short-lived
// token that POST /reset-password takes like the emailed link's. An address without an account
// gets the same answer as a wrong code.
authRouter.post('/verify-reset-code', async (req, res) => {
  const body = parseBody(resetCodeSchema, req);
  const limit = await resetCodeLimiter.hit(body.email);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);

  const user = await findUserByEmail(body.email);
  if (!user || user.role !== 'user') return wrongCode(res);
  const result = await consumeEmailCode(user.id, body.code, 'reset-code');
  if (result === 'wrong') return wrongCode(res);
  if (result === 'expired') return expiredCode(res);

  const resetToken = await createEmailToken(user.id, 'reset', RESET_AFTER_CODE_TTL_MS);
  res.json({ resetToken });
});

// Signed in: the current password, then the new one. Every other device is signed out; this one
// gets a fresh session.
authRouter.post('/change-password', requireAuth, async (req, res) => {
  const body = parseBody(changePasswordSchema, req);
  const limit = await changePasswordLimiter.blocked(req.user!.id);
  if (limit.blocked) return rateLimited(res, limit.retryAfterSec);

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  // requireAuth caches users for a minute: an account deleted meanwhile still gets here.
  if (!user) {
    forgetAuthUser(req.user!.id);
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User no longer exists' } });
    return;
  }
  if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
    await changePasswordLimiter.hit(user.id);
    res.status(400).json({ error: { code: 'WRONG_PASSWORD', message: "That isn't your current password" } });
    return;
  }
  await changePasswordLimiter.reset(user.id);

  const passwordHash = await bcrypt.hash(body.newPassword, BCRYPT_COST);
  const newRefreshToken = generateRefreshToken();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
    await tx.insert(refreshTokens).values({ userId: user.id, token: hashToken(newRefreshToken) });
  });
  res.json({ accessToken: signAccessToken({ id: user.id, email: user.email }), refreshToken: newRefreshToken });
});

authRouter.post('/reset-password', async (req, res) => {
  const body = parseBody(resetSchema, req);
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

  const reset = await db.transaction(async (tx) => {
    const userId = await consumeEmailToken(body.token, 'reset', tx);
    if (!userId) return false;
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    // Opening the emailed link proves the address works.
    await tx
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    // Sign out every device: whoever had the old password loses access.
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    return true;
  });

  if (!reset) return invalidToken(res);
  res.json({ ok: true });
});
