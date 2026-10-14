import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signAccessToken = (payload: AuthUser): string => {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '15m' });
};

export const generateRefreshToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthUser;
    req.user = decoded;
  } catch {}
  next();
};

// A user row almost never changes, so a short in-memory cache spares the users lookup on every
// authenticated request. Only positive results are kept, and a deleted account is dropped with
// forgetAuthUser so its next request still gets 401.
const AUTH_USER_TTL_MS = 60_000;
const AUTH_USER_CACHE_MAX = 5000;
const knownUsers = new Map<string, number>();

export const forgetAuthUser = (id: string): void => {
  knownUsers.delete(id);
};

const isKnownUser = (id: string): boolean => {
  const expiresAt = knownUsers.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    knownUsers.delete(id);
    return false;
  }
  return true;
};

const rememberUser = (id: string): void => {
  // Re-set so the newest entry is last; evict the oldest by insertion order when full.
  knownUsers.delete(id);
  if (knownUsers.size >= AUTH_USER_CACHE_MAX) {
    const oldest = knownUsers.keys().next().value;
    if (oldest !== undefined) knownUsers.delete(oldest);
  }
  knownUsers.set(id, Date.now() + AUTH_USER_TTL_MS);
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' },
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthUser;
    // Verify user still exists, reaching the database only when not cached.
    if (!isKnownUser(decoded.id)) {
      const [user] = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
      if (!user) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'User no longer exists' },
        });
        return;
      }
      rememberUser(decoded.id);
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Token is invalid or expired' },
    });
  }
};
