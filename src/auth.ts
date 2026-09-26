import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
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

export function signAccessToken(payload: AuthUser): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '15m' });
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function signRefreshToken(payload?: AuthUser): string {
  return generateRefreshToken();
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
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
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' }
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthUser;
    // Verify user still exists
    const [user] = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'User no longer exists' }
      });
      return;
    }
    req.user = decoded;
    next();
  } catch (err: any) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Token is invalid or expired' }
    });
  }
}
