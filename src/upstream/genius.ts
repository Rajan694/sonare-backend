import { request } from 'undici';
import { config } from '../config.js';

// Only the fields Sonare reads.
export interface GeniusSearch {
  response: { hits: { result: { id: number; url: string; title?: string } }[] };
}

export interface GeniusSong {
  response: { song: { id: number; url: string; title?: string } };
}

async function fetchGenius<T>(path: string, query?: Record<string, string | undefined>): Promise<T | null> {
  if (!config.GENIUS_CLIENT_ACCESS_TOKEN) return null;

  const url = new URL(path, 'https://api.genius.com');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const { statusCode, body } = await request(url, {
    headers: { Authorization: `Bearer ${config.GENIUS_CLIENT_ACCESS_TOKEN}` },
  });

  if (statusCode !== 200) {
    await body.dump();
    return null;
  }

  return (await body.json()) as T;
}

export const Genius = {
  search(q: string) {
    return fetchGenius<GeniusSearch>('/search', { q });
  },

  song(id: number) {
    return fetchGenius<GeniusSong>(`/songs/${id}`);
  },
};
