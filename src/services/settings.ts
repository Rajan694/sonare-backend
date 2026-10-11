import { db } from '../db/index.js';
import { appSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { redis, isRedisAvailable } from './cache.js';
import { logger } from '../logger.js';

const PIPED_API_URL_KEY = 'piped_api_url';
const YOUTUBE_CLIENTS_KEY = 'youtube_clients';
const IN_APP_YOUTUBE_KEY = 'in_app_youtube';

/** All allowed youtubei.js client names. */
export const ALLOWED_YOUTUBE_CLIENTS = [
  'IOS',
  'WEB',
  'MWEB',
  'WEB_KIDS',
  'YTMUSIC',
  'ANDROID',
  'ANDROID_VR',
  'VISIONOS',
  'YTSTUDIO_ANDROID',
  'YTMUSIC_ANDROID',
  'TV',
  'TV_SIMPLY',
  'TV_EMBEDDED',
  'WEB_EMBEDDED',
  'WEB_CREATOR',
] as const;

export type YouTubeClient = (typeof ALLOWED_YOUTUBE_CLIENTS)[number];

export const DEFAULT_YOUTUBE_CLIENTS: string[] = ['VISIONOS'];
export const DEFAULT_IN_APP_YOUTUBE = true;

interface SettingEntry {
  value: string;
  updatedAt: Date;
}

/** In-memory cache of app settings, loaded at startup. */
const settingsCache = new Map<string, SettingEntry>();

/** Load all settings from the database into memory. Called once at startup. */
export const loadSettings = async (): Promise<void> => {
  const rows = await db.select().from(appSettings);
  settingsCache.clear();
  for (const row of rows) {
    settingsCache.set(row.key, { value: row.value, updatedAt: new Date(row.updatedAt) });
  }
  logger.info(
    { pipedUrl: pipedApiUrl(), youtubeClients: youtubeClients(), inAppYoutube: inAppYoutube() },
    'Settings loaded',
  );
};

/** Get the Piped API URL: DB value if set, else the config value. */
export const pipedApiUrl = (): string => {
  const saved = settingsCache.get(PIPED_API_URL_KEY)?.value;
  return saved ?? config.PIPED_API_URL;
};

/** Get the saved Piped API URL (may be null if not set). */
export const getSavedPipedApiUrl = (): string | null => {
  return settingsCache.get(PIPED_API_URL_KEY)?.value ?? null;
};

/** Set or clear the Piped API URL. Clears Piped caches on change. */
export const setPipedApiUrl = async (url: string | null): Promise<void> => {
  const current = settingsCache.get(PIPED_API_URL_KEY)?.value;
  const trimmed = url?.trim() ?? null;
  const trimmedOrEmpty = trimmed === '' ? null : trimmed;

  if (trimmedOrEmpty === current) return;

  const now = new Date();
  if (trimmedOrEmpty) {
    await db
      .insert(appSettings)
      .values({ key: PIPED_API_URL_KEY, value: trimmedOrEmpty, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: trimmedOrEmpty, updatedAt: now } });
    settingsCache.set(PIPED_API_URL_KEY, { value: trimmedOrEmpty, updatedAt: now });
  } else {
    await db.delete(appSettings).where(eq(appSettings.key, PIPED_API_URL_KEY));
    settingsCache.delete(PIPED_API_URL_KEY);
  }

  await clearPipedCache();
  logger.info({ pipedUrl: pipedApiUrl() }, 'Piped URL updated');
};

/** Get the ordered YouTube client list: DB value if set, else default. */
export const youtubeClients = (): string[] => {
  const saved = settingsCache.get(YOUTUBE_CLIENTS_KEY)?.value;
  if (!saved) return [...DEFAULT_YOUTUBE_CLIENTS];
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
  } catch {
    // ignore malformed
  }
  return [...DEFAULT_YOUTUBE_CLIENTS];
};

/** Get the saved YouTube clients (null if not saved). */
export const getSavedYoutubeClients = (): string[] | null => {
  const saved = settingsCache.get(YOUTUBE_CLIENTS_KEY)?.value;
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
  } catch {
    // ignore
  }
  return null;
};

/** Set or clear the YouTube clients list. Does NOT clear Piped cache. */
export const setYoutubeClients = async (clients: string[] | null): Promise<void> => {
  if (clients === null) {
    await db.delete(appSettings).where(eq(appSettings.key, YOUTUBE_CLIENTS_KEY));
    settingsCache.delete(YOUTUBE_CLIENTS_KEY);
  } else {
    const value = JSON.stringify(clients);
    const now = new Date();
    await db
      .insert(appSettings)
      .values({ key: YOUTUBE_CLIENTS_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
    settingsCache.set(YOUTUBE_CLIENTS_KEY, { value, updatedAt: now });
  }
  logger.info({ youtubeClients: youtubeClients() }, 'YouTube clients updated');
};

/** Get the in-app YouTube kill switch: DB value if set, else default (true). */
export const inAppYoutube = (): boolean => {
  const saved = settingsCache.get(IN_APP_YOUTUBE_KEY)?.value;
  if (saved === undefined) return DEFAULT_IN_APP_YOUTUBE;
  return saved === 'true';
};

/** Get the saved in-app YouTube value (null if not saved). */
export const getSavedInAppYoutube = (): boolean | null => {
  const saved = settingsCache.get(IN_APP_YOUTUBE_KEY)?.value;
  if (saved === undefined) return null;
  return saved === 'true';
};

/** Set or clear the in-app YouTube kill switch. Does NOT clear Piped cache. */
export const setInAppYoutube = async (enabled: boolean | null): Promise<void> => {
  if (enabled === null) {
    await db.delete(appSettings).where(eq(appSettings.key, IN_APP_YOUTUBE_KEY));
    settingsCache.delete(IN_APP_YOUTUBE_KEY);
  } else {
    const value = enabled ? 'true' : 'false';
    const now = new Date();
    await db
      .insert(appSettings)
      .values({ key: IN_APP_YOUTUBE_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
    settingsCache.set(IN_APP_YOUTUBE_KEY, { value, updatedAt: now });
  }
  logger.info({ inAppYoutube: inAppYoutube() }, 'In-app YouTube updated');
};

/**
 * Max updated_at of the in-app youtube / youtube_clients rows, in ms.
 * Returns 0 when neither row exists.
 */
export const settingsUpdatedAt = (): number => {
  const t1 = settingsCache.get(YOUTUBE_CLIENTS_KEY)?.updatedAt.getTime() ?? 0;
  const t2 = settingsCache.get(IN_APP_YOUTUBE_KEY)?.updatedAt.getTime() ?? 0;
  return Math.max(t1, t2);
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
