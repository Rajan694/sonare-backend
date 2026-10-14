import crypto from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { hashToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { emailTokens } from '../db/schema.js';

export type EmailTokenPurpose = 'verify' | 'reset';

export const VERIFY_TOKEN_TTL_MS = 24 * 3600_000;
export const RESET_TOKEN_TTL_MS = 3600_000;
/** The 6-digit code in the verification email, typed into the app instead of opening the link. */
export const VERIFY_CODE_TTL_MS = 30 * 60_000;
/** The 6-digit code in the password-reset email ("forgot password" in the apps). */
export const RESET_CODE_TTL_MS = 30 * 60_000;
/** What a correct reset code buys: one password change within this time. */
export const RESET_AFTER_CODE_TTL_MS = 15 * 60_000;
/** Wrong guesses before a code stops working (a new email brings a new one). */
export const VERIFY_CODE_MAX_ATTEMPTS = 5;

/** The emailed codes: verifying the address, and resetting the password. */
export type EmailCodePurpose = 'verify-code' | 'reset-code';

/**
 * Issues a single-use token for an emailed link and returns the raw value. Only its hash is
 * stored, and any earlier unused token of the same purpose stops working.
 */
export const createEmailToken = async (userId: string, purpose: EmailTokenPurpose, ttlMs: number): Promise<string> => {
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
};

/**
 * Marks the token used and returns its user id, or null when it is unknown, used or expired.
 * The update itself checks the token is still unused, so two concurrent requests can't both win.
 */
export const consumeEmailToken = async (
  raw: string,
  purpose: EmailTokenPurpose,
  tx: Pick<typeof db, 'update'> = db,
): Promise<string | null> => {
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
};

// A code is only 6 digits, so it is tied to its account (the hash covers the user id: the same
// digits for two people never clash) and checked against that account's one live code, which
// stops working after VERIFY_CODE_MAX_ATTEMPTS wrong guesses.
const codeHash = (userId: string, code: string) => hashToken(`${userId}:${code}`);

/** Issues a fresh code of that purpose (any earlier one stops working) and returns it. */
export const createEmailCode = async (
  userId: string,
  purpose: EmailCodePurpose = 'verify-code',
  ttlMs: number = VERIFY_CODE_TTL_MS,
): Promise<string> => {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
  await db.insert(emailTokens).values({
    userId,
    purpose,
    // The purpose is part of the hash: the same digits for verifying and resetting never clash.
    tokenHash: purpose === 'verify-code' ? codeHash(userId, code) : codeHash(userId, `${purpose}:${code}`),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return code;
};

/** Issues a fresh verification code (any earlier one stops working) and returns it. */
export const createVerifyCode = (userId: string): Promise<string> => createEmailCode(userId, 'verify-code');

export type VerifyCodeResult = 'ok' | 'wrong' | 'expired';

/**
 * Checks `code` against the account's live code. 'ok' uses it up; 'wrong' counts a guess;
 * 'expired' means there is no usable code (none sent, timed out, used, or this guess was the
 * last one allowed).
 */
export const consumeEmailCode = async (
  userId: string,
  code: string,
  purpose: EmailCodePurpose = 'verify-code',
): Promise<VerifyCodeResult> => {
  const now = new Date();
  const live = and(
    eq(emailTokens.userId, userId),
    eq(emailTokens.purpose, purpose),
    isNull(emailTokens.usedAt),
    gt(emailTokens.expiresAt, now),
  );
  const hash = purpose === 'verify-code' ? codeHash(userId, code) : codeHash(userId, `${purpose}:${code}`);
  const [used] = await db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(and(live, eq(emailTokens.tokenHash, hash)))
    .returning({ id: emailTokens.id });
  if (used) return 'ok';

  // Count the wrong guess; the last allowed one retires the code.
  const [guessed] = await db
    .update(emailTokens)
    .set({
      attempts: sql`${emailTokens.attempts} + 1`,
      usedAt: sql`case when ${emailTokens.attempts} + 1 >= ${VERIFY_CODE_MAX_ATTEMPTS} then now() else null end`,
    })
    .where(live)
    .returning({ attempts: emailTokens.attempts });
  return guessed && guessed.attempts < VERIFY_CODE_MAX_ATTEMPTS ? 'wrong' : 'expired';
};

export const consumeVerifyCode = (userId: string, code: string): Promise<VerifyCodeResult> =>
  consumeEmailCode(userId, code, 'verify-code');
