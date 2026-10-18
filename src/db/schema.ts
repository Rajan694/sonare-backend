import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  primaryKey,
  jsonb,
  index,
  bigserial,
  bigint,
  date,
  customType,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  emailVerifiedAt: timestamp('email_verified_at'),
  /** 'user' for app accounts; 'admin' signs in to /admin only and cannot use the apps. */
  role: text('role').default('user').notNull(),
  /** Bumped on an admin password change; admin tokens carry it, so older tokens stop working. */
  tokenVersion: integer('token_version').default(0).notNull(),
  lastLoginAt: timestamp('last_login_at'),
  passwordChangedAt: timestamp('password_changed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  token: text('token').notNull().unique(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const favouriteTracks = pgTable(
  'favourite_tracks',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    trackRefKind: text('track_ref_kind').notNull(),
    trackRefId: text('track_ref_id').notNull(),
    matchedServerId: text('matched_server_id'),
    addedAt: timestamp('added_at').defaultNow().notNull(),
    meta: jsonb('meta'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.trackRefKind, t.trackRefId] }),
  }),
);

export const favouriteAlbums = pgTable(
  'favourite_albums',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    albumId: text('album_id').notNull(),
    addedAt: timestamp('added_at').defaultNow().notNull(),
    meta: jsonb('meta'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.albumId] }),
  }),
);

export const artistFollows = pgTable(
  'artist_follows',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    artistId: text('artist_id').notNull(),
    addedAt: timestamp('added_at').defaultNow().notNull(),
    meta: jsonb('meta'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.artistId] }),
  }),
);

export const playHistory = pgTable(
  'play_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    trackRefKind: text('track_ref_kind').notNull(),
    trackRefId: text('track_ref_id').notNull(),
    matchedServerId: text('matched_server_id'),
    playedAt: timestamp('played_at').notNull(),
    msPlayed: integer('ms_played').notNull(),
    meta: jsonb('meta'),
  },
  (t) => ({
    userPlayedAtIdx: index('play_history_user_played_at_idx').on(t.userId, t.playedAt),
    userTrackRefIdx: index('play_history_user_track_ref_idx').on(t.userId, t.trackRefKind, t.trackRefId),
  }),
);

export const playlists = pgTable('playlists', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playlistId: text('playlist_id')
      .references(() => playlists.id, { onDelete: 'cascade' })
      .notNull(),
    position: integer('position').notNull(),
    trackRefKind: text('track_ref_kind').notNull(),
    trackRefId: text('track_ref_id').notNull(),
    matchedServerId: text('matched_server_id'),
    meta: jsonb('meta'),
  },
  (t) => ({
    playlistPositionIdx: index('playlist_tracks_playlist_position_idx').on(t.playlistId, t.position),
  }),
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    /** Wrong guesses at an emailed code; the code stops working after a few. */
    attempts: integer('attempts').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('email_tokens_user_id_idx').on(t.userId),
  }),
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  eqPreset: text('eq_preset').default('Sonare'),
  gapless: boolean('gapless').default(true),
  normalization: boolean('normalization').default(true),
  downloadQuality: text('download_quality').default('high'),
  stayOffline: boolean('stay_offline').default(false),
  streamQuality: text('stream_quality').default('high'),
  downloadFormat: text('download_format').default('opus'),
});

export const playerState = pgTable('player_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  trackRefKind: text('track_ref_kind'),
  trackRefId: text('track_ref_id'),
  positionMs: integer('position_ms').default(0),
  queue: jsonb('queue').$type<unknown[]>().default([]),
  index: integer('index').default(0),
  shuffle: boolean('shuffle').default(false),
  repeat: text('repeat').default('off'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const lyricsOverrides = pgTable(
  'lyrics_overrides',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    trackId: text('track_id').notNull(),
    offsetMs: integer('offset_ms').default(0),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.trackId] }),
  }),
);

// --- Admin analytics (/admin on the web build).

/** One row per API request, for the admin analytics. Pruned after 30 days. */
export const requestLogs = pgTable(
  'request_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at').defaultNow().notNull(),
    method: text('method').notNull(),
    /** The matched route pattern (`/api/v1/tracks/:id`), not the raw url. */
    route: text('route').notNull(),
    status: integer('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    userId: uuid('user_id'),
    /** web | linux | mobile, from the apps' X-Sonare-Client header; null for anything else. */
    client: text('client'),
  },
  (t) => ({
    atIdx: index('request_logs_at_idx').on(t.at),
  }),
);

/**
 * Backend errors and crash reports from the apps. A burst of the same error (Piped down, every
 * request failing) collapses into one row with a count rather than thousands of rows.
 */
export const errorLogs = pgTable(
  'error_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** backend | web | linux | mobile */
    source: text('source').notNull(),
    level: text('level').default('error').notNull(),
    code: text('code'),
    message: text('message').notNull(),
    stack: text('stack'),
    method: text('method'),
    route: text('route'),
    status: integer('status'),
    userId: uuid('user_id'),
    userAgent: text('user_agent'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    count: integer('count').default(1).notNull(),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  },
  (t) => ({
    lastSeenIdx: index('error_logs_last_seen_at_idx').on(t.lastSeenAt),
  }),
);

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Server-side metadata cache written only by the backend from Piped results.
 * kind = 'track' | 'album' | 'artist'; id = raw YouTube id (no "yt:" prefix).
 */
export const catalogItems = pgTable(
  'catalog_items',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.id] }),
    // The newest 50,000 are kept (pruneCatalogItems).
    updatedAtIdx: index('catalog_items_updated_at_idx').on(t.updatedAt),
  }),
);

/** Postgres has bytea; drizzle-orm's pg-core has no builder for it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Waveforms the apps measured and uploaded (first upload wins, for everyone). Redis caches them
 * in front; this table is what survives a Redis restart. One byte per bar (loudness 0..1 as
 * 0..255): 150 bars are 150 bytes, which matters on Neon's 0.5 GB.
 */
export const waveforms = pgTable('waveforms', {
  trackId: text('track_id').primaryKey(),
  peaks: bytea('peaks').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Lyrics found on LRCLIB, so a song's lyrics are looked up there once. `key` is the YouTube id,
 * or `id|title|artist` when only the app knew the song, with `:script` for a preferred script.
 * `lyrics` null records that LRCLIB had none; such misses expire (`expiresAt`) and are asked again.
 */
export const lyricsCache = pgTable(
  'lyrics_cache',
  {
    key: text('key').primaryKey(),
    lyrics: jsonb('lyrics'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    createdIdx: index('lyrics_cache_created_at_idx').on(t.createdAt),
  }),
);

// --- AI (services/ai): the LLM providers the admin set up, and what they used.

/**
 * An OpenAI-compatible chat-completions endpoint, tried in `position` order. `status` is what the
 * last call or health check found; a `down` provider is skipped until `retryAt`.
 */
export const aiProviders = pgTable('ai_providers', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  position: integer('position').default(0).notNull(),
  /** ok | down | unknown */
  status: text('status').default('unknown').notNull(),
  lastCheckedAt: timestamp('last_checked_at'),
  lastOkAt: timestamp('last_ok_at'),
  lastError: text('last_error'),
  retryAt: timestamp('retry_at'),
  latencyMs: integer('latency_ms'),
  /** Failures in a row, for the backoff. */
  failures: integer('failures').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Calls and tokens per UTC day, provider and feature, for the admin analytics. No foreign key:
 * a deleted provider's history stays, under the name it had.
 */
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    day: date('day').notNull(),
    providerId: uuid('provider_id').notNull(),
    providerName: text('provider_name').notNull(),
    /** you-may-like | search | playlist | titles | health */
    feature: text('feature').notNull(),
    calls: integer('calls').default(0).notNull(),
    failures: integer('failures').default(0).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).default(0).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.providerId, t.feature] }),
  }),
);
