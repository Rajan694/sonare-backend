import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env.test'), override: true });

import { beforeEach, afterAll } from 'vitest';
import { sql } from '../src/db/index.js';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';

// Verify redis is db15
const redisUrl = new URL(config.REDIS_URL);
if (redisUrl.pathname !== '/15') {
  throw new Error(`REDIS_URL must use database 15, got: ${config.REDIS_URL}`);
}

const redis = new Redis(config.REDIS_URL);

beforeEach(async () => {
  // Truncate tables between tests
  await sql.unsafe(`
    TRUNCATE TABLE 
      play_history,
      playlist_tracks,
      playlists,
      favourite_tracks,
      favourite_albums,
      artist_follows,
      lyrics_overrides,
      player_state,
      user_settings,
      refresh_tokens,
      email_tokens,
      users
    CASCADE;
  `);

  // Flush all keys on test db15
  const keys = await redis.keys('*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

afterAll(async () => {
  await redis.quit();
  await sql.end();
});
