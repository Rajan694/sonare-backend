import { request } from 'undici';
import { config } from '../config.js';

async function fetchLrc<T>(path: string, query?: Record<string, any>): Promise<T> {
  const url = new URL(path, config.LRCLIB_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  
  const { statusCode, body } = await request(url, {
    headers: { 'User-Agent': config.LRCLIB_USER_AGENT }
  });
  
  if (statusCode === 404) {
    await body.dump();
    return null as any;
  }
  
  if (statusCode !== 200) {
    await body.dump();
    throw new Error(`LRCLIB error ${statusCode}`);
  }
  
  return body.json() as T;
}

export const Lrclib = {
  get(track_name: string, artist_name: string, album_name: string, duration?: number) {
    return fetchLrc<any>('/api/get', { track_name, artist_name, album_name, duration });
  },
  
  search(q?: string, track_name?: string, artist_name?: string, album_name?: string) {
    return fetchLrc<any[]>('/api/search', { q, track_name, artist_name, album_name });
  },
  
  getById(id: number) {
    return fetchLrc<any>(`/api/get/${id}`);
  }
};
