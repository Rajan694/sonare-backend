import { db } from '../db/index.js';
import { appSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { redis, isRedisAvailable } from './cache.js';
import { logger } from '../logger.js';

const PIPED_API_URL_KEY = 'piped_api_url';

/** In-memory cache of app settings, loaded at startup. */
const settingsCache = new Map<string, string>();

/** Load all settings from the database into memory. Called once at startup. */
export const loadSettings = async (): Promise<void> => {
  const rows = await db.select().from(appSettings);
  for (const row of rows) {
    settingsCache.set(row.key, row.value);
  }
  logger.info({ pipedUrl: pipedApiUrl() }, 'Settings loaded');
};

/** Get the Piped API URL: DB value if set, else the config value. */
export const pipedApiUrl = (): string => {
  const saved = settingsCache.get(PIPED_API_URL_KEY);
  return saved ?? config.PIPED_API_URL;
};

/** Set or clear the Piped API URL. Clears Piped caches on change. */
export const setPipedApiUrl = async (url: string | null): Promise<void> => {
  const current = settingsCache.get(PIPED_API_URL_KEY);
  const trimmed = url?.trim() ?? null;
  const trimmedOrEmpty = trimmed === '' ? null : trimmed;

  if (trimmedOrEmpty === current) return;

  if (trimmedOrEmpty) {
    await db
      .insert(appSettings)
      .values({ key: PIPED_API_URL_KEY, value: trimmedOrEmpty })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: trimmedOrEmpty, updatedAt: new Date() } });
    settingsCache.set(PIPED_API_URL_KEY, trimmedOrEmpty);
  } else {
    await db.delete(appSettings).where(eq(appSettings.key, PIPED_API_URL_KEY));
    settingsCache.delete(PIPED_API_URL_KEY);
  }

  await clearPipedCache();
  logger.info({ pipedUrl: pipedApiUrl() }, 'Piped URL updated');
};

/** Get the saved Piped API URL (may be null if not set). */
export const getSavedPipedApiUrl = (): string | null => {
  return settingsCache.get(PIPED_API_URL_KEY) ?? null;
};

/**
 * Clear Piped-related cached responses from Redis.
 * Uses SCAN + DEL to avoid blocking the server.
 * Silently ignores Redis being unavailable.
 */
const clearPipedCache = async (): Promise<void> => {
  if (!isRedisAvailable()) return;

  const patterns = [
    'sonare:stream:*',
    'sonare:search:*',
    'sonare:searchNext:*',
    'sonare:suggestions:*',
    'sonare:trending:*',
    'sonare:channel:*',
    'sonare:playlist:*',
    'sonare:playlistNext:*',
  ];

  try {
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [nextCursor, rawKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (rawKeys.length > 0) {
          const keys = rawKeys.map((k) => (k.startsWith('sonare:') ? k.slice(7) : k));
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    }
    logger.info('Piped cache cleared');
  } catch (err) {
    logger.warn({ err }, 'Failed to clear Piped cache');
  }
};
