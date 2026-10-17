// GENERATED from sonare-frontend/shared/catalog/titleFixes.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// Cleaner titles for messy YouTube uploads ("Tum Hi Ho | Aashiqui 2 | Arijit Singh | T-Series"),
// worked out by the backend's AI (POST /ai/titles) and remembered here by raw video id.
//
// The normalizers call applyTitleFix for every song they map. A song with a known fix gets it;
// one whose title still looks messy is noted, and each app's title sync (shared/ai/titleSync.ts)
// sends the noted ones to the backend in batches. The backend uses the same registry for the
// songs it maps itself. A song mapped before its fix arrived shows the fix the next time it is
// mapped. Sync code only: no imports, nothing async.

export interface TitleFix {
  title: string;
  artist: string;
}

export interface PendingTitle {
  id: string;
  title: string;
  artist: string;
}

/** Most fixes kept in memory; the oldest go first. */
export const MAX_TITLE_FIXES = 5000;
/** Most songs waiting to be asked about. */
const MAX_PENDING = 500;
/** A song is asked about at most this many times, this far apart, before it is left alone. */
const MAX_TRIES = 3;
const RETRY_MS = 90_000;

const fixes = new Map<string, TitleFix>();
const pending = new Map<string, PendingTitle & { tries: number; nextAt: number }>();
/** Songs given up on (asked MAX_TRIES times with no answer): not noted again. */
const givenUp = new Set<string>();

// Words that mark a video upload rather than a song title.
const NOISE =
  /\b(official|lyrics?|lyrical|full (song|video|audio)|video song|audio song|music video|visuali[sz]er|hd|4k|remaster(ed)?|feat\.?|ft\.?|prod\.?|from ["“]|movie|film)\b/i;

/**
 * True when a title (already stripped of "(Official Video)" and the like) still reads like a
 * video upload: separators, credits, hashtags, or the uploader's name inside it. Songs from
 * "- Topic" channels are YouTube Music's own metadata and never count.
 */
export const looksMessy = (title: string, rawUploader: string | undefined): boolean => {
  if (!title) return false;
  const uploader = (rawUploader ?? '').trim();
  if (/\s-\s*Topic$/i.test(uploader)) return false;
  if (/[|#｜]/.test(title) || /\s[-–—]\s/.test(title)) return true;
  if (NOISE.test(title)) return true;
  if (title.length > 60) return true;
  const name = uploader.toLowerCase();
  return name.length > 2 && title.toLowerCase().includes(name);
};

const rawId = (id: string): string => (id.startsWith('yt:') ? id.slice(3) : id);

/**
 * The title and artist to show for a song: its fix when there is one, else what was given.
 * A messy title without a fix is noted for the next batch (see takePendingTitles).
 */
export const applyTitleFix = (
  videoId: string,
  title: string,
  artist: string,
  rawUploader?: string,
): TitleFix => {
  const id = rawId(videoId);
  if (!id || id === 'unknown') return { title, artist };
  const fix = fixes.get(id);
  if (fix) return fix;
  if (!pending.has(id) && !givenUp.has(id) && looksMessy(title, rawUploader)) {
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    pending.set(id, { id, title, artist, tries: 0, nextAt: 0 });
  }
  return { title, artist };
};

/** Remember fixes (from the backend, or from storage at start-up). Answered songs stop being noted. */
export const addTitleFixes = (entries: Record<string, TitleFix>): void => {
  for (const [key, fix] of Object.entries(entries)) {
    if (!fix || typeof fix.title !== 'string' || typeof fix.artist !== 'string' || !fix.title.trim()) continue;
    const id = rawId(key);
    fixes.delete(id);
    fixes.set(id, { title: fix.title.trim(), artist: fix.artist.trim() });
    pending.delete(id);
  }
  while (fixes.size > MAX_TITLE_FIXES) fixes.delete(fixes.keys().next().value as string);
};

/**
 * Up to `max` noted songs that are due to be asked about. Each one taken counts as a try; one
 * still unanswered after MAX_TRIES is dropped and not noted again.
 */
export const takePendingTitles = (max = 40, now = Date.now()): PendingTitle[] => {
  const out: PendingTitle[] = [];
  for (const entry of pending.values()) {
    if (out.length >= max) break;
    if (entry.nextAt > now) continue;
    if (entry.tries >= MAX_TRIES) {
      pending.delete(entry.id);
      givenUp.add(entry.id);
      continue;
    }
    entry.tries += 1;
    entry.nextAt = now + RETRY_MS;
    out.push({ id: entry.id, title: entry.title, artist: entry.artist });
  }
  return out;
};

/** The fixes held now, newest last: what an app saves to storage. */
export const titleFixesSnapshot = (max = 2000): Record<string, TitleFix> => {
  const all = [...fixes.entries()];
  return Object.fromEntries(all.slice(Math.max(0, all.length - max)));
};

export const pendingTitleCount = (): number => pending.size;

/** Tests only. */
export const resetTitleFixes = (): void => {
  fixes.clear();
  pending.clear();
  givenUp.clear();
};
