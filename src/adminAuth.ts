import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { db } from './db/index.js';
import { adminUsers } from './db/schema.js';

const ADMIN_AUDIENCE = 'sonare-admin';
// Its own key, derived from JWT_SECRET, so an app token can never pass as an admin token
// (or the reverse), even though both come from the same secret.
const ADMIN_KEY = crypto.createHmac('sha256', config.JWT_SECRET).update('sonare-admin-token').digest();
const ADMIN_TOKEN_TTL = '8h';

export interface AdminPrincipal {
  id: string;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminPrincipal;
    }
  }
}

export function signAdminToken(admin: { id: string; tokenVersion: number }): string {
  return jwt.sign({ ver: admin.tokenVersion }, ADMIN_KEY, {
    subject: admin.id,
    audience: ADMIN_AUDIENCE,
    expiresIn: ADMIN_TOKEN_TTL,
  });
}

function unauthorized(res: Response, message: string) {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
}

/** Admin API guard. A token stops working once the password it was issued under changes. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return unauthorized(res, 'Sign in to the admin page');

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), ADMIN_KEY, {
      audience: ADMIN_AUDIENCE,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
  } catch {
    return unauthorized(res, 'Your admin session has expired');
  }

  try {
    const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, String(payload.sub))).limit(1);
    if (!admin || admin.tokenVersion !== payload.ver) {
      return unauthorized(res, 'Your admin session has ended');
    }
    req.admin = { id: admin.id, username: admin.username };
    next();
  } catch (err) {
    next(err);
  }
}
