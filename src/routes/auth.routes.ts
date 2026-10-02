import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, refreshTokens } from '../db/schema.js';
import { signAccessToken, generateRefreshToken, hashToken, requireAuth } from '../auth.js';
import { BadRequestError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import { config } from '../config.js';
import { sendMail, verifyEmailMessage, resetPasswordMessage } from '../mail.js';
import { createEmailToken, consumeEmailToken, RESET_TOKEN_TTL_MS, VERIFY_TOKEN_TTL_MS } from '../emailTokens.js';

export const authRouter = Router();

const BCRYPT_COST = 10;

const loginLimiter = createRateLimiter({ name: 'login', max: 5, windowMs: 15 * 60_000 });
const registerLimiter = createRateLimiter({ name: 'register', max: 10, windowMs: 60 * 60_000 });
const resendLimiter = createRateLimiter({ name: 'verify-resend', max: 3, windowMs: 60 * 60_000 });
const forgotIpLimiter = createRateLimiter({ name: 'forgot-ip', max: 5, windowMs: 60 * 60_000 });
const forgotEmailLimiter = createRateLimiter({ name: 'forgot-email', max: 3, windowMs: 60 * 60_000 });

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

function parseBody<T>(schema: z.ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request');
  }
  return parsed.data;
}

function rateLimited(res: Response, retryAfterSec: number) {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} min.` },
  });
}

function invalidToken(res: Response) {
  res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' } });
}

// Accounts made before emails were lowercased keep their original case.
function findUserByEmail(address: string) {
  return db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, address))
    .limit(1)
    .then((rows) => rows[0]);
}

function userView(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  };
}

async function startSession(user: typeof users.$inferSelect) {
  const refreshToken = generateRefreshToken();
  await db.insert(refreshTokens).values({ userId: user.id, token: hashToken(refreshToken) });
  return { accessToken: signAccessToken({ id: user.id, email: user.email }), refreshToken, user: userView(user) };
}

/** Mail failures are logged, never surfaced: the account action itself already succeeded. */
async function sendVerifyEmail(req: Request, user: typeof users.$inferSelect) {
  const raw = await createEmailToken(user.id, 'verify', VERIFY_TOKEN_TTL_MS);
  const link = `${config.APP_URL}/verify-email?token=${raw}`;
  await sendMail({ to: user.email, ...verifyEmailMessage(link) }).catch((err) =>
    req.log.warn({ err }, 'verification email failed'),
  );
}

async function sendResetEmail(req: Request, user: typeof users.$inferSelect) {
  const raw = await createEmailToken(user.id, 'reset', RESET_TOKEN_TTL_MS);
  const link = `${config.APP_URL}/reset-password?token=${raw}`;
  await sendMail({ to: user.email, ...resetPasswordMessage(link) }).catch((err) =>
    req.log.warn({ err }, 'password reset email failed'),
  );
}

authRouter.post('/register', async (req, res) => {
  const limit = await registerLimiter.hit(req.ip ?? 'unknown');
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);

  const body = parseBody(registerSchema, req);
  if (await findUserByEmail(body.email)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Email already registered' } });
    return;
  }

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
  const [user] = await db
    .insert(users)
    .values({ email: body.email, passwordHash, displayName: body.displayName })
    .returning();

  await sendVerifyEmail(req, user);
  res.status(201).json(await startSession(user));
});

authRouter.post('/login', async (req, res) => {
  const body = parseBody(loginSchema, req);
  const limitKey = `${req.ip ?? 'unknown'}:${body.email}`;
  const lockout = await loginLimiter.blocked(limitKey);
  if (lockout.blocked) return rateLimited(res, lockout.retryAfterSec);

  const user = await findUserByEmail(body.email);
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    await loginLimiter.hit(limitKey);
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
    return;
  }

  await loginLimiter.reset(limitKey);
  res.json(await startSession(user));
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) throw new BadRequestError('Missing refreshToken');

  const [stored] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.token, hashToken(refreshToken)), eq(refreshTokens.revoked, false)))
    .limit(1);
  if (!stored) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked refresh token' } });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    return;
  }

  // Rotate: the old refresh token is spent.
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, stored.id));
  const session = await startSession(user);
  res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken });
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (refreshToken) {
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.token, hashToken(refreshToken)));
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

authRouter.post('/resend-verification', requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (user.emailVerifiedAt) {
    res.json({ ok: true, alreadyVerified: true });
    return;
  }

  const limit = await resendLimiter.hit(user.id);
  if (!limit.allowed) return rateLimited(res, limit.retryAfterSec);

  await sendVerifyEmail(req, user);
  res.json({ ok: true });
});

// Always answers ok, whether or not the address has an account, so it can't be used to probe for accounts.
authRouter.post('/forgot-password', async (req, res) => {
  const body = parseBody(forgotSchema, req);
  const byIp = await forgotIpLimiter.hit(req.ip ?? 'unknown');
  if (!byIp.allowed) return rateLimited(res, byIp.retryAfterSec);
  const byEmail = await forgotEmailLimiter.hit(body.email);
  if (!byEmail.allowed) return rateLimited(res, byEmail.retryAfterSec);

  const user = await findUserByEmail(body.email);
  if (user) await sendResetEmail(req, user);
  res.json({ ok: true });
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
    await tx.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.userId, userId));
    return true;
  });

  if (!reset) return invalidToken(res);
  res.json({ ok: true });
});
