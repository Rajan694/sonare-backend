import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { hashToken } from './auth.js';
import { db } from './db/index.js';
import { emailTokens } from './db/schema.js';

export type EmailTokenPurpose = 'verify' | 'reset';

export const VERIFY_TOKEN_TTL_MS = 24 * 3600_000;
export const RESET_TOKEN_TTL_MS = 3600_000;

/**
 * Issues a single-use token for an emailed link and returns the raw value. Only its hash is
 * stored, and any earlier unused token of the same purpose stops working.
 */
export async function createEmailToken(userId: string, purpose: EmailTokenPurpose, ttlMs: number): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
  await db.insert(emailTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

/**
 * Marks the token used and returns its user id, or null when it is unknown, used or expired.
 * The update itself checks the token is still unused, so two concurrent requests can't both win.
 */
export async function consumeEmailToken(
  raw: string,
  purpose: EmailTokenPurpose,
  tx: Pick<typeof db, 'update'> = db,
): Promise<string | null> {
  const now = new Date();
  const [token] = await tx
    .update(emailTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailTokens.tokenHash, hashToken(raw)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now),
      ),
    )
    .returning({ userId: emailTokens.userId });
  return token?.userId ?? null;
}
