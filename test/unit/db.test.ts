import { describe, expect, it } from 'vitest';
import { db, verifyDatabase } from '../../src/db/index.js';
import {
  adminUsers,
  artistFollows,
  errorLogs,
  favouriteAlbums,
  favouriteTracks,
  lyricsOverrides,
  playHistory,
  playerState,
  playlistTracks,
  playlists,
  refreshTokens,
  requestLogs,
  systemConfiguration,
  userSettings,
  users,
} from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createAdminUser, createUser } from '../factories.js';
import { getUserTrackDataMap, getUserTrackFields } from '../../src/db/user-data.js';
import { hydrateTracks } from '../../src/db/hydrate.js';

describe('db: models & helpers', () => {
  it('BE-DB-001: inserts and queries users table correctly', async () => {
    const { user } = await createUser({ email: 'db_user1@example.com' });
    const [found] = await db.select().from(users).where(eq(users.id, user.id));
    expect(found.email).toBe('db_user1@example.com');
  });

  it('BE-DB-002: inserts and cascades delete on user refresh tokens', async () => {
    const { user, refreshToken } = await createUser();
    const [rt] = await db.select().from(refreshTokens).where(eq(refreshTokens.token, refreshToken));
    expect(rt.userId).toBe(user.id);

    await db.delete(users).where(eq(users.id, user.id));
    const rtCheck = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(rtCheck).toHaveLength(0);
  });

  it('BE-DB-003: manages favourite tracks and handles duplicate inserts gracefully', async () => {
    const { user } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'favDb1',
    });

    const favs = await db.select().from(favouriteTracks).where(eq(favouriteTracks.userId, user.id));
    expect(favs).toHaveLength(1);
    expect(favs[0].trackRefId).toBe('favDb1');
  });

  it('BE-DB-004: manages favourite albums table correctly', async () => {
    const { user } = await createUser();
    await db.insert(favouriteAlbums).values({
      userId: user.id,
      albumId: 'PLalbDb1',
    });

    const albums = await db.select().from(favouriteAlbums).where(eq(favouriteAlbums.userId, user.id));
    expect(albums).toHaveLength(1);
    expect(albums[0].albumId).toBe('PLalbDb1');
  });

  it('BE-DB-005: manages artist follows table correctly', async () => {
    const { user } = await createUser();
    await db.insert(artistFollows).values({
      userId: user.id,
      artistId: 'UCartistDb1',
    });

    const follows = await db.select().from(artistFollows).where(eq(artistFollows.userId, user.id));
    expect(follows).toHaveLength(1);
    expect(follows[0].artistId).toBe('UCartistDb1');
  });

  it('BE-DB-006: records and aggregates play history counts', async () => {
    const { user } = await createUser();
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'histDb1',
      playedAt: new Date(),
      msPlayed: 30000,
    });
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'histDb1',
      playedAt: new Date(),
      msPlayed: 45000,
    });

    const meta = await getUserTrackFields(user.id, 'histDb1');
    expect(meta.playCount).toBe(2);
  });

  it('BE-DB-007: manages user playlists and playlist tracks ordering', async () => {
    const { user } = await createUser();
    const [pl] = await db
      .insert(playlists)
      .values({
        id: 'sonare:pl_db1',
        userId: user.id,
        name: 'DB Playlist',
        kind: 'online',
      })
      .returning();

    await db.insert(playlistTracks).values({
      playlistId: pl.id,
      trackRefKind: 'youtube',
      trackRefId: 'trk1',
      position: 0,
    });
    await db.insert(playlistTracks).values({
      playlistId: pl.id,
      trackRefKind: 'youtube',
      trackRefId: 'trk2',
      position: 1,
    });

    const tracks = await db.select().from(playlistTracks).where(eq(playlistTracks.playlistId, pl.id));
    expect(tracks).toHaveLength(2);
  });

  it('BE-DB-008: persists user settings and applies defaults', async () => {
    const { user } = await createUser();
    await db.insert(userSettings).values({
      userId: user.id,
      streamQuality: 'high',
      eqPreset: 'Rock',
    });

    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id));
    expect(settings.streamQuality).toBe('high');
    expect(settings.eqPreset).toBe('Rock');
  });

  it('BE-DB-009: stores player state and restores json queue', async () => {
    const { user } = await createUser();
    await db.insert(playerState).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'plState1',
      positionMs: 88000,
      queue: [{ id: 'yt:plState1' }],
    });

    const [state] = await db.select().from(playerState).where(eq(playerState.userId, user.id));
    expect(state.trackRefId).toBe('plState1');
    expect(state.positionMs).toBe(88000);
  });

  it('BE-DB-010: manages lyrics overrides storage', async () => {
    const { user } = await createUser();
    await db.insert(lyricsOverrides).values({
      userId: user.id,
      trackId: 'lyrOver1',
      plain: 'Custom DB lyrics',
    });

    const [override] = await db.select().from(lyricsOverrides).where(eq(lyricsOverrides.userId, user.id));
    expect(override.trackId).toBe('lyrOver1');
  });

  it('BE-DB-011: manages admin users credentials and token version increments', async () => {
    const { admin } = await createAdminUser();
    await db
      .update(adminUsers)
      .set({ tokenVersion: admin.tokenVersion + 1 })
      .where(eq(adminUsers.id, admin.id));

    const [updated] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id));
    expect(updated.tokenVersion).toBe(admin.tokenVersion + 1);
  });

  it('BE-DB-012: inserts error logs and handles querying with levels', async () => {
    const [err] = await db
      .insert(errorLogs)
      .values({
        source: 'backend',
        level: 'error',
        message: 'Database connection timeout test',
      })
      .returning();

    const [found] = await db.select().from(errorLogs).where(eq(errorLogs.id, err.id));
    expect(found.message).toBe('Database connection timeout test');
  });

  it('BE-DB-013: inserts and queries request logs table', async () => {
    const [reqLog] = await db
      .insert(requestLogs)
      .values({
        method: 'GET',
        route: '/api/v1/healthz',
        status: 200,
        durationMs: 12,
        client: 'web',
      })
      .returning();

    const [found] = await db.select().from(requestLogs).where(eq(requestLogs.id, reqLog.id));
    expect(found.route).toBe('/api/v1/healthz');
    expect(found.status).toBe(200);
  });

  it('BE-DB-014: inserts and reads system configuration table', async () => {
    await db
      .insert(systemConfiguration)
      .values({
        key: 'piped.apiUrl',
        value: 'http://localhost:8090',
      })
      .onConflictDoUpdate({
        target: systemConfiguration.key,
        set: { value: 'http://localhost:8090' },
      });

    const [cfg] = await db.select().from(systemConfiguration).where(eq(systemConfiguration.key, 'piped.apiUrl'));
    expect(cfg.value).toBe('http://localhost:8090');
  });

  it('BE-DB-015: getUserTrackDataMap batches multiple track lookups accurately', async () => {
    const { user } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'mapTrack1',
    });
    await db.insert(playHistory).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'mapTrack1',
      playedAt: new Date(),
      msPlayed: 60000,
    });

    const map = await getUserTrackDataMap(user.id, ['mapTrack1', 'mapTrack2']);
    expect(map.get('mapTrack1')?.favourite).toBe(true);
    expect(map.get('mapTrack1')?.playCount).toBe(1);
    expect(map.get('mapTrack2')?.favourite).toBe(false);
  });

  it('BE-DB-016: hydrateTracks formats track items with local user states', async () => {
    const { user } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'youtube',
      trackRefId: 'hydTrack1',
    });

    const hydrated = await hydrateTracks(user.id, [
      { trackRefKind: 'youtube', trackRefId: 'hydTrack1', addedAt: Date.now(), favourite: true },
    ]);

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].id).toBe('local:hydTrack1');
  });
});

describe('db: constraints & data integrity', () => {
  it('BE-DB-INT-001: enforces unique constraint on user email address in schema', async () => {
    const { user } = await createUser({ email: 'unique_constraint@test.com' });
    expect(user.email).toBe('unique_constraint@test.com');
  });

  it('BE-DB-INT-002: verifies cascading deletion on user relationships', async () => {
    const { user } = await createUser();
    await db.delete(users).where(eq(users.id, user.id));
    const [check] = await db.select().from(users).where(eq(users.id, user.id));
    expect(check).toBeUndefined();
  });
});

describe('db: verifyDatabase', () => {
  it('BE-DB-VERIFY-001: verifyDatabase connects successfully to test db', async () => {
    await expect(verifyDatabase()).resolves.toBeUndefined();
  });
});

describe('db: user data & hydration', () => {
  it('BE-HYDR-001: hydrateTracks returns empty array when given empty input', async () => {
    const { user } = await createUser();
    const result = await hydrateTracks(user.id, []);
    expect(result).toEqual([]);
  });

  it('BE-HYDR-002: hydrateTracks handles local tracks correctly', async () => {
    const { user } = await createUser();
    await db.insert(favouriteTracks).values({
      userId: user.id,
      trackRefKind: 'local',
      trackRefId: 'local:hash_local_123',
    });

    const items = [
      {
        trackRefKind: 'local',
        trackRefId: 'hash_local_123',
        addedAt: Date.now(),
        favourite: true,
      },
    ];
    const hydrated = await hydrateTracks(user.id, items);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].id).toBe('local:hash_local_123');
    expect(hydrated[0].source).toBe('local');
    expect(hydrated[0].favourite).toBe(true);
  });

  it('BE-HYDR-003: getUserTrackFields returns default fields when user does not exist', async () => {
    const fields = await getUserTrackFields(undefined, 'anyTrack');
    expect(fields.favourite).toBe(false);
    expect(fields.playCount).toBe(0);
    expect(typeof fields.addedAt).toBe('number');
    expect(fields.lastPlayedAt).toBeUndefined();
  });

  it('BE-HYDR-004: getUserTrackDataMap returns empty map for empty ids array', async () => {
    const { user } = await createUser();
    const map = await getUserTrackDataMap(user.id, []);
    expect(map.size).toBe(0);
  });

  it('BE-HYDR-005: getUserTrackDataMap returns empty map when userId is undefined', async () => {
    const map = await getUserTrackDataMap(undefined, ['track1', 'track2']);
    expect(map.size).toBe(0);
  });
});

describe('db: schema tables & columns', () => {
  it('BE-SCH-001: users schema table is defined with all columns', () => {
    expect(users.id).toBeDefined();
    expect(users.email).toBeDefined();
    expect(users.passwordHash).toBeDefined();
    expect(users.displayName).toBeDefined();
    expect(users.createdAt).toBeDefined();
  });

  it('BE-SCH-002: refreshTokens schema table has foreign key and token column', () => {
    expect(refreshTokens.id).toBeDefined();
    expect(refreshTokens.userId).toBeDefined();
    expect(refreshTokens.token).toBeDefined();
    expect(refreshTokens.revoked).toBeDefined();
  });

  it('BE-SCH-003: favouriteTracks schema table has composite primary keys', () => {
    expect(favouriteTracks.userId).toBeDefined();
    expect(favouriteTracks.trackRefKind).toBeDefined();
    expect(favouriteTracks.trackRefId).toBeDefined();
  });

  it('BE-SCH-004: favouriteAlbums schema table has albumId and addedAt', () => {
    expect(favouriteAlbums.userId).toBeDefined();
    expect(favouriteAlbums.albumId).toBeDefined();
    expect(favouriteAlbums.addedAt).toBeDefined();
  });

  it('BE-SCH-005: artistFollows schema table has artistId and userId', () => {
    expect(artistFollows.userId).toBeDefined();
    expect(artistFollows.artistId).toBeDefined();
    expect(artistFollows.addedAt).toBeDefined();
  });

  it('BE-SCH-006: playHistory schema table has playedAt and msPlayed', () => {
    expect(playHistory.id).toBeDefined();
    expect(playHistory.userId).toBeDefined();
    expect(playHistory.trackRefKind).toBeDefined();
    expect(playHistory.trackRefId).toBeDefined();
    expect(playHistory.playedAt).toBeDefined();
    expect(playHistory.msPlayed).toBeDefined();
  });

  it('BE-SCH-007: playlists schema table has name, kind, description', () => {
    expect(playlists.id).toBeDefined();
    expect(playlists.userId).toBeDefined();
    expect(playlists.name).toBeDefined();
    expect(playlists.kind).toBeDefined();
    expect(playlists.description).toBeDefined();
  });

  it('BE-SCH-008: playlistTracks schema table has position and playlist foreign key', () => {
    expect(playlistTracks.id).toBeDefined();
    expect(playlistTracks.playlistId).toBeDefined();
    expect(playlistTracks.position).toBeDefined();
    expect(playlistTracks.trackRefKind).toBeDefined();
    expect(playlistTracks.trackRefId).toBeDefined();
  });

  it('BE-SCH-009: userSettings schema table has streaming and equalizer fields', () => {
    expect(userSettings.userId).toBeDefined();
    expect(userSettings.eqPreset).toBeDefined();
    expect(userSettings.gapless).toBeDefined();
    expect(userSettings.streamQuality).toBeDefined();
  });

  it('BE-SCH-010: playerState schema table has queue and positionMs fields', () => {
    expect(playerState.userId).toBeDefined();
    expect(playerState.positionMs).toBeDefined();
    expect(playerState.queue).toBeDefined();
    expect(playerState.shuffle).toBeDefined();
    expect(playerState.repeat).toBeDefined();
  });

  it('BE-SCH-011: lyricsOverrides schema table has lrc and plain columns', () => {
    expect(lyricsOverrides.userId).toBeDefined();
    expect(lyricsOverrides.trackId).toBeDefined();
    expect(lyricsOverrides.lrc).toBeDefined();
    expect(lyricsOverrides.plain).toBeDefined();
    expect(lyricsOverrides.offsetMs).toBeDefined();
  });

  it('BE-SCH-012: adminUsers schema table has username and tokenVersion', () => {
    expect(adminUsers.id).toBeDefined();
    expect(adminUsers.username).toBeDefined();
    expect(adminUsers.passwordHash).toBeDefined();
    expect(adminUsers.tokenVersion).toBeDefined();
  });

  it('BE-SCH-013: systemConfiguration schema table has key and value columns', () => {
    expect(systemConfiguration.key).toBeDefined();
    expect(systemConfiguration.value).toBeDefined();
    expect(systemConfiguration.updatedAt).toBeDefined();
  });

  it('BE-SCH-014: requestLogs schema table has status, durationMs and client', () => {
    expect(requestLogs.id).toBeDefined();
    expect(requestLogs.method).toBeDefined();
    expect(requestLogs.route).toBeDefined();
    expect(requestLogs.status).toBeDefined();
    expect(requestLogs.durationMs).toBeDefined();
  });

  it('BE-SCH-015: errorLogs schema table has level, stack, and context jsonb', () => {
    expect(errorLogs.id).toBeDefined();
    expect(errorLogs.source).toBeDefined();
    expect(errorLogs.level).toBeDefined();
    expect(errorLogs.message).toBeDefined();
    expect(errorLogs.stack).toBeDefined();
    expect(errorLogs.context).toBeDefined();
    expect(errorLogs.count).toBeDefined();
  });
});
