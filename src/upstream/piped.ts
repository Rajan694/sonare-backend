import { request } from 'undici';
import { pipedApiUrl } from '../systemConfig.js';
import * as T from './piped.types.js';

export class UpstreamError extends Error {
  public status: number;
  /** Piped itself could not be reached, as opposed to answering this one request with an error. */
  public unreachable: boolean;
  constructor(message: string, status: number, unreachable = false) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.unreachable = unreachable;
  }
}

// Nothing listening, or the host is gone. A slow answer (headers/body timeout) is a problem
// with one request - a long extraction - not an outage.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function networkError(e: any): UpstreamError {
  if (UNREACHABLE_CODES.has(e?.code)) {
    return new UpstreamError(`Piped is unreachable at ${pipedApiUrl()} (${e.code})`, 502, true);
  }
  return new UpstreamError(`Piped network error: ${e.message}`, 502);
}

async function fetchPiped<TRes>(path: string, options: { method?: string; query?: Record<string, string | number> } = {}): Promise<TRes> {
  const url = new URL(path, pipedApiUrl());
  if (options.query) {
    for (const [key, val] of Object.entries(options.query)) {
      if (val !== undefined && val !== null && val !== '') {
        url.searchParams.set(key, String(val));
      }
    }
  }

  let attempt = 0;
  while (attempt < 2) {
    try {
      const { statusCode, body } = await request(url, {
        method: (options.method || 'GET') as any,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Sonare/1.0',
        },
        bodyTimeout: 5000,
        headersTimeout: 5000,
      });

      if (statusCode >= 200 && statusCode < 300) {
        return await body.json() as TRes;
      }

      if (statusCode >= 500 && attempt === 0) {
        attempt++;
        await body.dump();
        continue;
      }

      await body.dump();
      throw new UpstreamError(`Piped returned ${statusCode} for ${path}`, 502);
    } catch (e: any) {
      if (e instanceof UpstreamError) throw e;
      if (attempt === 0) {
        attempt++;
        continue;
      }
      throw networkError(e);
    }
  }
  throw new UpstreamError('Unreachable', 502);
}

export type PipedClient = typeof Piped;

export const Piped = {
  getStream(videoId: string) {
    return fetchPiped<T.Streams>(`/streams/${encodeURIComponent(videoId)}`);
  },

  search(q: string, filter?: string) {
    return fetchPiped<T.SearchPage>('/search', { query: { q, filter: filter || 'all' } });
  },

  searchNextPage(q: string, nextpage: string, filter?: string) {
    return fetchPiped<T.SearchPage>('/nextpage/search', { query: { q, nextpage, filter: filter || 'all' } });
  },

  suggestions(query: string) {
    return fetchPiped<string[]>('/suggestions', { query: { query } });
  },

  trending(region: string = 'IN') {
    return fetchPiped<T.StreamItem[]>('/trending', { query: { region } });
  },

  channel(id: string) {
    return fetchPiped<T.Channel>(`/channel/${encodeURIComponent(id)}`);
  },

  channelTabs(data: string) {
    // /channels/tabs returns stuff
    return fetchPiped<any>('/channels/tabs', { query: { data } });
  },

  playlist(id: string) {
    return fetchPiped<T.Playlist>(`/playlists/${encodeURIComponent(id)}`);
  },

  playlistNextPage(id: string, nextpage: string) {
    return fetchPiped<any>(`/nextpage/playlists/${encodeURIComponent(id)}`, { query: { nextpage } });
  },

  async healthcheck(): Promise<boolean> {
    const url = new URL('/healthcheck', pipedApiUrl());
    let attempt = 0;
    while (attempt < 2) {
      try {
        const { statusCode, body } = await request(url, {
          method: 'GET',
          headers: { 'User-Agent': 'Sonare/1.0' },
          bodyTimeout: 5000,
          headersTimeout: 5000,
        });
        await body.dump();
        if (statusCode >= 200 && statusCode < 300) {
          return true;
        }
        if (statusCode >= 500 && attempt === 0) {
          attempt++;
          continue;
        }
        throw new UpstreamError(`Piped returned ${statusCode} for /healthcheck`, 502);
      } catch (e: any) {
        if (e instanceof UpstreamError) throw e;
        if (attempt === 0) {
          attempt++;
          continue;
        }
        throw networkError(e);
      }
    }
    throw new UpstreamError('Unreachable', 502);
  }
};
