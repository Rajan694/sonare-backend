import { Lrclib } from '../upstream/lrclib.js';
import { Genius } from '../upstream/genius.js';
import { db } from '../db/index.js';
import { lyricsOverrides } from '../db/schema.js';
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

/**
 * Scripts a user can prefer lyrics in. LRCLIB has no language field, but often holds the
 * same song in more than one script (a Hindi song in Devanagari and in romanised Hinglish),
 * so the preference picks the version written in that script.
 */
export const LYRICS_SCRIPTS = [
  'original',
  'latin',
  'devanagari',
  'gurmukhi',
  'arabic',
  'bengali',
  'gujarati',
  'tamil',
  'telugu',
] as const;
export type LyricsScript = (typeof LYRICS_SCRIPTS)[number];

const SCRIPT_LETTERS: Record<Exclude<LyricsScript, 'original'>, RegExp> = {
  latin: /\p{Script=Latin}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  gurmukhi: /\p{Script=Gurmukhi}/gu,
  arabic: /\p{Script=Arabic}/gu,
  bengali: /\p{Script=Bengali}/gu,
  gujarati: /\p{Script=Gujarati}/gu,
  tamil: /\p{Script=Tamil}/gu,
  telugu: /\p{Script=Telugu}/gu,
};

/** True when most of the letters in `text` are in `script`. */
export function isInScript(text: string, script: Exclude<LyricsScript, 'original'>): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const inScript = text.match(SCRIPT_LETTERS[script])?.length ?? 0;
  return inScript / letters >= 0.6;
}

function lyricsText(l: Pick<ResolvedLyrics, 'lines' | 'plain'>): string {
  return l.lines.length > 0 ? l.lines.map((x) => x.text).join('\n') : (l.plain ?? '');
}

/** Whether resolved lyrics are already in the preferred script. */
export function lyricsInScript(l: ResolvedLyrics, script: Exclude<LyricsScript, 'original'>): boolean {
  return isInScript(lyricsText(l), script);
}

/**
 * The LRCLIB version of a song written in `script`, synced first and closest in length.
 * Null when LRCLIB has none.
 */
export async function resolveLyricsInScript(
  trackName: string,
  artistName: string,
  durationMs: number | undefined,
  script: Exclude<LyricsScript, 'original'>,
): Promise<ResolvedLyrics | null> {
  let candidates: Awaited<ReturnType<typeof Lrclib.search>> = [];
  try {
    const [byFields, byQuery] = await Promise.all([
      Lrclib.search(undefined, trackName, artistName).catch(() => null),
      Lrclib.search(`${trackName} ${artistName}`).catch(() => null),
    ]);
    const seen = new Set<number>();
    candidates = [...(byFields ?? []), ...(byQuery ?? [])].filter((c) => !seen.has(c.id) && !!seen.add(c.id));
  } catch {
    return null;
  }

  const durationSec = durationMs ? durationMs / 1000 : 0;
  const matches = candidates
    .filter((c) => !c.instrumental)
    // A different song with the same title is worse than no match: keep it within 15s.
    .filter((c) => !durationSec || !c.duration || Math.abs(c.duration - durationSec) <= 15)
    .filter((c) => isInScript(c.syncedLyrics ?? c.plainLyrics ?? '', script))
    .sort(
      (a, b) =>
        Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) ||
        Math.abs((a.duration ?? 0) - durationSec) - Math.abs((b.duration ?? 0) - durationSec),
    );
  const best = matches[0];
  if (!best) return null;
  return best.syncedLyrics
    ? {
        synced: true,
        provider: 'lrclib',
        offsetMs: 0,
        lines: parseLrc(best.syncedLyrics),
        plain: best.plainLyrics ?? undefined,
      }
    : { synced: false, provider: 'lrclib', offsetMs: 0, lines: [], plain: best.plainLyrics ?? undefined };
}

export async function getDbLyricsOverride(trackId: string, userId?: string) {
  try {
    if (userId) {
      const [row] = await db
        .select()
        .from(lyricsOverrides)
        .where(and(eq(lyricsOverrides.trackId, trackId), eq(lyricsOverrides.userId, userId)))
        .limit(1);
      if (row) return row;
    }
    // Fallback to any user's override if no specific userId match
    const [anyRow] = await db.select().from(lyricsOverrides).where(eq(lyricsOverrides.trackId, trackId)).limit(1);
    return anyRow || null;
  } catch {
    return null;
  }
}

export async function saveDbLyricsOverride(trackId: string, userId: string, data: { lrc?: string; plain?: string }) {
  const now = new Date();
  await db
    .insert(lyricsOverrides)
    .values({
      trackId,
      userId,
      lrc: data.lrc || null,
      plain: data.plain || null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [lyricsOverrides.userId, lyricsOverrides.trackId],
      set: {
        lrc: data.lrc || null,
        plain: data.plain || null,
        updatedAt: now,
      },
    });
}

export async function saveDbLyricsOffset(trackId: string, userId: string, offsetMs: number) {
  const now = new Date();
  await db
    .insert(lyricsOverrides)
    .values({
      trackId,
      userId,
      offsetMs,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [lyricsOverrides.userId, lyricsOverrides.trackId],
      set: {
        offsetMs,
        updatedAt: now,
      },
    });
}

export async function deleteDbLyricsOverride(trackId: string, userId?: string) {
  if (userId) {
    await db
      .delete(lyricsOverrides)
      .where(and(eq(lyricsOverrides.trackId, trackId), eq(lyricsOverrides.userId, userId)));
  } else {
    await db.delete(lyricsOverrides).where(eq(lyricsOverrides.trackId, trackId));
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
    userId?: string,
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
          found = {
            synced: true,
            provider: 'lrclib',
            lines: parseLrc(exact.syncedLyrics),
            plain: exact.plainLyrics ?? undefined,
          };
        } else if (exact.plainLyrics) {
          found = { synced: false, provider: 'lrclib', lines: [], plain: exact.plainLyrics };
        }
      }
    } catch {}

    if (!found) {
      try {
        const fuzzyList = await Lrclib.search(undefined, trackName, artistName, albumName || '');
        if (fuzzyList && fuzzyList.length > 0) {
          const bestSynced = fuzzyList.find((f) => f.syncedLyrics);
          if (bestSynced?.syncedLyrics) {
            found = {
              synced: true,
              provider: 'lrclib',
              lines: parseLrc(bestSynced.syncedLyrics),
              plain: bestSynced.plainLyrics ?? undefined,
            };
          } else {
            const bestPlain = fuzzyList.find((f) => f.plainLyrics);
            if (bestPlain?.plainLyrics) {
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
          attribution: { name: 'Genius', url: hit.url },
        };
      }
    } catch {}

    return null;
  },
};
