import { request } from 'undici';
import { config } from '../config.js';

/** A track from LRCLIB's /api/get and /api/search. */
export interface LrclibTrack {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

type Query = Record<string, string | number | undefined | null>;

/** Null when LRCLIB has no such track (404). */
const fetchLrc = async <T>(path: string, query?: Query): Promise<T | null> => {
  const url = new URL(path, config.LRCLIB_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  // undici waits 5 minutes for headers by default; a stalled LRCLIB should fail fast instead.
  const { statusCode, body } = await request(url, {
    headers: { 'User-Agent': config.LRCLIB_USER_AGENT },
    headersTimeout: 8000,
    bodyTimeout: 8000,
  });

  if (statusCode === 404) {
    await body.dump();
    return null;
  }

  if (statusCode !== 200) {
    await body.dump();
    throw new Error(`LRCLIB error ${statusCode}`);
  }

  return (await body.json()) as T;
};

export const Lrclib = {
  get(track_name: string, artist_name: string, album_name?: string, duration?: number) {
    return fetchLrc<LrclibTrack>('/api/get', { track_name, artist_name, album_name, duration });
  },

  search(q?: string, track_name?: string, artist_name?: string, album_name?: string) {
    return fetchLrc<LrclibTrack[]>('/api/search', { q, track_name, artist_name, album_name });
  },

  getById(id: number) {
    return fetchLrc<LrclibTrack>(`/api/get/${id}`);
  },
};
