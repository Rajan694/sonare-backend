import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../logger.js';

// Play history is capped per user (Neon's free plan is 0.5 GB): the newest plays are kept, older
// ones go. Recently played, most played, play counts and "You may like" all read from these.

export const PLAY_HISTORY_MAX_PER_USER = 1000;

/** Every user: everything past their newest `max` plays. Logged, never thrown. */
export const prunePlayHistory = async (max = PLAY_HISTORY_MAX_PER_USER): Promise<void> => {
  try {
    await db.execute(sql`
      DELETE FROM play_history WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY played_at DESC, id DESC) AS n
          FROM play_history
        ) ranked
        WHERE n > ${max}
      )
    `);
  } catch (err) {
    logger.warn({ err }, 'Could not prune play history');
  }
};

/** One user, after a sync added plays: cheap, it uses the (user_id, played_at) index. */
export const prunePlayHistoryForUser = async (userId: string, max = PLAY_HISTORY_MAX_PER_USER): Promise<void> => {
  try {
    await db.execute(sql`
      DELETE FROM play_history WHERE id IN (
        SELECT id FROM play_history WHERE user_id = ${userId}
        ORDER BY played_at DESC, id DESC OFFSET ${max}
      )
    `);
  } catch (err) {
    logger.warn({ err }, 'Could not prune play history');
  }
};
