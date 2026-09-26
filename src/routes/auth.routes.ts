import { Router } from 'express';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { users, refreshTokens } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { signAccessToken, generateRefreshToken, requireAuth } from '../auth.js';
import { BadRequestError } from '../errors.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password || !displayName) {
      throw new BadRequestError('Missing required fields: email, password, displayName');
    }

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'Email already registered' } });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [user] = await db.insert(users).values({
      email,
      passwordHash,
      displayName,
    }).returning();

    const authUser = { id: user.id, email: user.email };
    const accessToken = signAccessToken(authUser);
    const refreshToken = generateRefreshToken();

    await db.insert(refreshTokens).values({
      userId: user.id,
      token: refreshToken,
    });

    res.status(201).json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
      },
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new BadRequestError('Missing email or password');
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }

    const authUser = { id: user.id, email: user.email };
    const accessToken = signAccessToken(authUser);
    const refreshToken = generateRefreshToken();

    await db.insert(refreshTokens).values({
      userId: user.id,
      token: refreshToken,
    });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
      },
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new BadRequestError('Missing refreshToken');
    }

    const [stored] = await db.select().from(refreshTokens).where(
      and(eq(refreshTokens.token, refreshToken), eq(refreshTokens.revoked, false))
    ).limit(1);

    if (!stored) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked refresh token' } });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }

    const authUser = { id: user.id, email: user.email };
    const newAccessToken = signAccessToken(authUser);
    const newRefreshToken = generateRefreshToken();

    // Rotate refresh token
    await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, stored.id));
    await db.insert(refreshTokens).values({
      userId: user.id,
      token: newRefreshToken,
    });

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.token, refreshToken));
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
