import { db } from './index.js';
import { favouriteTracks, playHistory, favouriteAlbums, artistFollows } from './schema.js';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';

export interface UserTrackFields {
  playCount: number;
  favourite: boolean;
  addedAt: number;
  lastPlayedAt?: number;
}

export async function getUserTrackDataMap(userId: string | undefined, trackIds: string[]): Promise<Map<string, UserTrackFields>> {
  const map = new Map<string, UserTrackFields>();
  if (!userId || trackIds.length === 0) return map;

  try {
    const rawIds = trackIds.map(id => id.startsWith('yt:') ? id.substring(3) : id);
    const allIds = [...new Set([...trackIds, ...rawIds])];

    const favs = await db.select().from(favouriteTracks).where(
      and(
        eq(favouriteTracks.userId, userId),
        inArray(favouriteTracks.trackRefId, allIds)
      )
    );

    const favMap = new Map<string, Date>();
    for (const f of favs) {
      favMap.set(f.trackRefId, f.addedAt);
    }

    const plays = await db.select({
      trackRefId: playHistory.trackRefId,
      count: sql<number>`count(*)::int`,
      lastPlayed: sql<Date | null>`max(${playHistory.playedAt})`,
    }).from(playHistory).where(
      and(
        eq(playHistory.userId, userId),
        inArray(playHistory.trackRefId, allIds)
      )
    ).groupBy(playHistory.trackRefId);

    const playMap = new Map<string, { count: number; lastPlayed?: number }>();
    for (const p of plays) {
      playMap.set(p.trackRefId, {
        count: p.count,
        lastPlayed: p.lastPlayed ? new Date(p.lastPlayed).getTime() : undefined,
      });
    }

    for (const id of trackIds) {
      const rawId = id.startsWith('yt:') ? id.substring(3) : id;
      const favAdded = favMap.get(id) || favMap.get(rawId);
      const playInfo = playMap.get(id) || playMap.get(rawId);

      map.set(id, {
        playCount: playInfo?.count || 0,
        favourite: !!favAdded,
        addedAt: favAdded ? new Date(favAdded).getTime() : Date.now(),
        lastPlayedAt: playInfo?.lastPlayed,
      });
    }
  } catch (e) {
    // If DB is offline or table missing, return empty map
  }

  return map;
}

export async function getUserTrackFields(userId: string | undefined, trackId: string): Promise<UserTrackFields> {
  const map = await getUserTrackDataMap(userId, [trackId]);
  return map.get(trackId) || {
    playCount: 0,
    favourite: false,
    addedAt: Date.now(),
    lastPlayedAt: undefined,
  };
}
