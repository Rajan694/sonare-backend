import { request } from 'undici';
import { config } from '../config.js';

async function fetchGenius<T>(path: string, query?: Record<string, any>): Promise<T | null> {
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
    headers: { Authorization: `Bearer ${config.GENIUS_CLIENT_ACCESS_TOKEN}` }
  });
  
  if (statusCode !== 200) {
    await body.dump();
    return null;
  }
  
  return body.json() as T;
}

export const Genius = {
  search(q: string) {
    return fetchGenius<any>('/search', { q });
  },
  
  song(id: number) {
    return fetchGenius<any>(`/songs/${id}`);
  }
};
