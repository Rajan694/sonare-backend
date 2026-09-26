import { pgTable, uuid, text, timestamp, integer, boolean, primaryKey, jsonb, index, bigserial } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').notNull().unique(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const favouriteTracks = pgTable('favourite_tracks', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  trackRefKind: text('track_ref_kind').notNull(),
  trackRefId: text('track_ref_id').notNull(),
  matchedServerId: text('matched_server_id'),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.trackRefKind, t.trackRefId] }),
}));

export const favouriteAlbums = pgTable('favourite_albums', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  albumId: text('album_id').notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.albumId] }),
}));

export const artistFollows = pgTable('artist_follows', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  artistId: text('artist_id').notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.artistId] }),
}));

export const playHistory = pgTable('play_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  trackRefKind: text('track_ref_kind').notNull(),
  trackRefId: text('track_ref_id').notNull(),
  matchedServerId: text('matched_server_id'),
  playedAt: timestamp('played_at').notNull(),
  msPlayed: integer('ms_played').notNull(),
}, (t) => ({
  userPlayedAtIdx: index('play_history_user_played_at_idx').on(t.userId, t.playedAt),
  userTrackRefIdx: index('play_history_user_track_ref_idx').on(t.userId, t.trackRefKind, t.trackRefId),
}));

export const playlists = pgTable('playlists', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const playlistTracks = pgTable('playlist_tracks', {
  id: uuid('id').defaultRandom().primaryKey(),
  playlistId: text('playlist_id').references(() => playlists.id, { onDelete: 'cascade' }).notNull(),
  position: integer('position').notNull(),
  trackRefKind: text('track_ref_kind').notNull(),
  trackRefId: text('track_ref_id').notNull(),
  matchedServerId: text('matched_server_id'),
}, (t) => ({
  playlistPositionIdx: index('playlist_tracks_playlist_position_idx').on(t.playlistId, t.position),
}));

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  eqPreset: text('eq_preset').default('Flat'),
  gapless: boolean('gapless').default(false),
  normalization: boolean('normalization').default(true),
  downloadQuality: text('download_quality').default('high'),
  stayOffline: boolean('stay_offline').default(false),
});

export const playerState = pgTable('player_state', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  trackRefKind: text('track_ref_kind'),
  trackRefId: text('track_ref_id'),
  positionMs: integer('position_ms').default(0),
  queue: jsonb('queue').$type<any[]>().default([]),
  index: integer('index').default(0),
  shuffle: boolean('shuffle').default(false),
  repeat: text('repeat').default('off'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const lyricsOverrides = pgTable('lyrics_overrides', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  trackId: text('track_id').notNull(),
  lrc: text('lrc'),
  plain: text('plain'),
  offsetMs: integer('offset_ms').default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.trackId] }),
}));

// --- Admin (/admin on the web build). Separate from `users`: an app account never gets admin
// access, and the admin login is not an app account.

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** Bumped on a password change; admin tokens carry it, so older tokens stop working. */
  tokenVersion: integer('token_version').default(0).notNull(),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** System-wide settings, edited from the admin page. A null value means "use the .env default". */
export const systemConfiguration = pgTable('system_configuration', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>(),
  description: text('description'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedBy: text('updated_by'),
});

/** One row per API request, for the admin analytics. Pruned after 30 days. */
export const requestLogs = pgTable('request_logs', {
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
}, (t) => ({
  atIdx: index('request_logs_at_idx').on(t.at),
}));

/**
 * Backend errors and crash reports from the apps. A burst of the same error (Piped down, every
 * request failing) collapses into one row with a count rather than thousands of rows.
 */
export const errorLogs = pgTable('error_logs', {
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
}, (t) => ({
  lastSeenIdx: index('error_logs_last_seen_at_idx').on(t.lastSeenAt),
}));
