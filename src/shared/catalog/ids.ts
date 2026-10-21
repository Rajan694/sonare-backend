// GENERATED from sonare-frontend/shared/catalog/ids.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// ID helpers for YouTube catalog - port of backend/src/ids.ts
// Pure functions, no Node APIs.

export type SourceId = `yt:${string}` | `local:${string}` | `sonare:${string}`;

export class CatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

export const idHelpers = {
  prefixYt(id: string): `yt:${string}` {
    return `yt:${id}`;
  },

  prefixLocal(hash: string): `local:${string}` {
    return `local:${hash}`;
  },

  prefixSonare(uuid: string): `sonare:${string}` {
    return `sonare:${uuid}`;
  },

  extractYtId(fullId: string): string {
    if (!fullId.startsWith('yt:')) {
      throw new CatalogInputError(`Invalid yt ID: ${fullId}`);
    }
    return fullId.substring(3);
  },

  extractChannelIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/\/channel\/(UC[\w-]+)/);
    if (match) return match[1];
    return null;
  },

  /**
   * Artist id for a catalog item: `yt:<channelId>` only when the uploader URL names a real
   * channel. Without a channel, artist is empty (clients hide "Go to artist").
   */
  artistIdFromUrl(url: string | undefined | null): string {
    const channelId = idHelpers.extractChannelIdFromUrl(url ?? undefined);
    return channelId ? idHelpers.prefixYt(channelId) : '';
  },

  extractListIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  },
};

export type ParsedYouTubeLink =
  | { kind: 'playlist'; id: `yt:${string}` }
  | { kind: 'song'; id: `yt:${string}` };

const YT_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const YT_LIST_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Parses a YouTube URL pasted into search.
 * Accepts youtube.com (and www., m., music.) and youtu.be.
 *
 * Rules:
 * - /playlist?list= -> playlist
 * - a link with v= -> song (even if list= is also attached)
 * - /shorts/<id> -> song
 * - youtu.be/<id> -> song (even if list= is also attached)
 * - list= without v -> playlist
 * - plain text / non-matching -> null
 */
export function parseYouTubeLink(text: string): ParsedYouTubeLink | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const isYouTubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
  const isShortHost = host === 'youtu.be' || host.endsWith('.youtu.be');

  if (!isYouTubeHost && !isShortHost) {
    return null;
  }

  const v = url.searchParams.get('v');
  const rawList = url.searchParams.get('list');
  const list = rawList && YT_LIST_ID_REGEX.test(rawList) ? rawList : null;

  const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';

  // 1. /playlist?list= -> playlist
  if (normalizedPath === '/playlist' && list) {
    return { kind: 'playlist', id: idHelpers.prefixYt(list) };
  }

  // 2. Video link with v= -> song (even if list= is attached)
  if (v && YT_VIDEO_ID_REGEX.test(v)) {
    return { kind: 'song', id: idHelpers.prefixYt(v) };
  }

  // 3. /shorts/<11-char id> -> song
  const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
  if (shortsMatch) {
    return { kind: 'song', id: idHelpers.prefixYt(shortsMatch[1]) };
  }

  // 4. youtu.be/<11-char id> -> song (even if list= is attached)
  if (isShortHost) {
    const shortMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
    if (shortMatch) {
      return { kind: 'song', id: idHelpers.prefixYt(shortMatch[1]) };
    }
  }

  // 5. list= without v -> playlist
  if (list) {
    return { kind: 'playlist', id: idHelpers.prefixYt(list) };
  }

  return null;
}
