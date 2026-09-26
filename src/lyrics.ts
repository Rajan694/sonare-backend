import { Lrclib } from './upstream/lrclib.js';
import { Genius } from './upstream/genius.js';
import { db } from './db/index.js';
import { lyricsOverrides } from './db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface LyricsLine {
  atMs: number;
  text: string;
}

export interface ResolvedLyrics {
  synced: boolean;
  provider: 'lrclib' | 'genius' | 'tags' | 'user';
  offsetMs: number;
  lines: LyricsLine[];
  plain?: string;
  attribution?: { name: string; url: string };
}

export async function getDbLyricsOverride(trackId: string, userId?: string) {
  try {
    if (userId) {
      const [row] = await db.select().from(lyricsOverrides).where(
        and(eq(lyricsOverrides.trackId, trackId), eq(lyricsOverrides.userId, userId))
      ).limit(1);
      if (row) return row;
    }
    // Fallback to any user's override if no specific userId match
    const [anyRow] = await db.select().from(lyricsOverrides).where(
      eq(lyricsOverrides.trackId, trackId)
    ).limit(1);
    return anyRow || null;
  } catch {
    return null;
  }
}

export async function saveDbLyricsOverride(trackId: string, userId: string, data: { lrc?: string; plain?: string }) {
  const now = new Date();
  await db.insert(lyricsOverrides).values({
    trackId,
    userId,
    lrc: data.lrc || null,
    plain: data.plain || null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [lyricsOverrides.userId, lyricsOverrides.trackId],
    set: {
      lrc: data.lrc || null,
      plain: data.plain || null,
      updatedAt: now,
    }
  });
}

export async function saveDbLyricsOffset(trackId: string, userId: string, offsetMs: number) {
  const now = new Date();
  await db.insert(lyricsOverrides).values({
    trackId,
    userId,
    offsetMs,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [lyricsOverrides.userId, lyricsOverrides.trackId],
    set: {
      offsetMs,
      updatedAt: now,
    }
  });
}

export async function deleteDbLyricsOverride(trackId: string, userId?: string) {
  if (userId) {
    await db.delete(lyricsOverrides).where(
      and(eq(lyricsOverrides.trackId, trackId), eq(lyricsOverrides.userId, userId))
    );
  } else {
    await db.delete(lyricsOverrides).where(
      eq(lyricsOverrides.trackId, trackId)
    );
  }
}

export function parseLrc(lrc: string): LyricsLine[] {
  const lines = lrc.split('\n');
  const result: LyricsLine[] = [];
  const tagRegex = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  
  const offsetMatch = lrc.match(/\[offset:\s*([+-]?\d+)\]/i);
  const offset = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;

  for (const line of lines) {
    let match;
    const timestamps: number[] = [];
    
    while ((match = tagRegex.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      timestamps.push(Math.floor((minutes * 60 + seconds) * 1000));
    }
    
    if (timestamps.length > 0) {
      const text = line.replace(/\[[a-zA-Z0-9:]+(?:\.\d+)?\]/g, '').trim(); 
      for (const t of timestamps) {
        result.push({ atMs: Math.max(0, t + offset), text });
      }
    }
  }
  
  return result.sort((a, b) => a.atMs - b.atMs);
}

export const LyricsResolver = {
  async resolve(
    trackId: string,
    trackName: string,
    artistName: string,
    albumName?: string,
    durationMs?: number,
    userId?: string
  ): Promise<ResolvedLyrics | null> {
    const override = await getDbLyricsOverride(trackId, userId);
    if (override && (override.lrc || override.plain)) {
      return {
        synced: !!override.lrc,
        provider: 'user',
        offsetMs: override.offsetMs || 0,
        lines: override.lrc ? parseLrc(override.lrc) : [],
        plain: override.plain || override.lrc?.replace(/\[.*?\]/g, '').trim(),
      };
    }

    let found: Partial<ResolvedLyrics> | null = null;
    try {
      const exact = await Lrclib.get(trackName, artistName, albumName || '', durationMs ? durationMs / 1000 : 0);
      if (exact) {
        if (exact.syncedLyrics) {
          found = { synced: true, provider: 'lrclib', lines: parseLrc(exact.syncedLyrics), plain: exact.plainLyrics };
        } else if (exact.plainLyrics) {
          found = { synced: false, provider: 'lrclib', lines: [], plain: exact.plainLyrics };
        }
      }
    } catch {} 

    if (!found) {
      try {
        const fuzzyList = await Lrclib.search(undefined, trackName, artistName, albumName || '');
        if (fuzzyList && fuzzyList.length > 0) {
          const bestSynced = fuzzyList.find((f: any) => f.syncedLyrics);
          if (bestSynced) {
            found = { synced: true, provider: 'lrclib', lines: parseLrc(bestSynced.syncedLyrics), plain: bestSynced.plainLyrics };
          } else {
            const bestPlain = fuzzyList.find((f: any) => f.plainLyrics);
            if (bestPlain) {
              found = { synced: false, provider: 'lrclib', lines: [], plain: bestPlain.plainLyrics };
            }
          }
        }
      } catch {}
    }

    if (found) {
      return { ...found, offsetMs: override?.offsetMs || 0 } as ResolvedLyrics;
    }

    if (!trackName) return null;

    try {
      const gRes = await Genius.search(`${trackName} ${artistName}`);
      if (gRes && gRes.response?.hits?.length > 0) {
        const hit = gRes.response.hits[0].result;
        return {
          synced: false,
          provider: 'genius',
          offsetMs: override?.offsetMs || 0,
          lines: [],
          attribution: { name: 'Genius', url: hit.url }
        };
      }
    } catch {}

    return null;
  }
};
