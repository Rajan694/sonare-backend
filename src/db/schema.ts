import { pgTable, uuid, text, timestamp, integer, boolean, primaryKey, jsonb, index } from 'drizzle-orm/pg-core';

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
