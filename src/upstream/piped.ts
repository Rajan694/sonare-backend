import { request, type Dispatcher } from 'undici';
import { config } from '../config.js';
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
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function networkError(e: unknown): UpstreamError {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
    return new UpstreamError(`Piped is unreachable at ${config.PIPED_API_URL} (${code})`, 502, true);
  }
  return new UpstreamError(`Piped network error: ${e instanceof Error ? e.message : String(e)}`, 502);
}

/** Rejects with an "unreachable" UpstreamError if `promise` hasn't settled after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError(`Piped did not answer within ${ms} ms`, 502, true)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchPiped<TRes>(
  path: string,
  options: { method?: Dispatcher.HttpMethod; query?: Record<string, string | number> } = {},
): Promise<TRes> {
  const url = new URL(path, config.PIPED_API_URL);
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
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Sonare/1.0',
        },
        bodyTimeout: 5000,
        headersTimeout: 5000,
      });

      if (statusCode >= 200 && statusCode < 300) {
        return (await body.json()) as TRes;
      }

      if (statusCode >= 500 && attempt === 0) {
        attempt++;
        await body.dump();
        continue;
      }

      await body.dump();
      throw new UpstreamError(`Piped returned ${statusCode} for ${path}`, 502);
    } catch (e) {
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
    return fetchPiped<T.ChannelTabPage>('/channels/tabs', { query: { data } });
  },

  playlist(id: string) {
    return fetchPiped<T.Playlist>(`/playlists/${encodeURIComponent(id)}`);
  },

  playlistNextPage(id: string, nextpage: string) {
    return fetchPiped<T.PlaylistPage>(`/nextpage/playlists/${encodeURIComponent(id)}`, { query: { nextpage } });
  },

  /**
   * `timeoutMs` bounds each attempt, connecting included. The abort signal alone does not
   * cut a TCP connect short (undici then waits its own 10 s connect timeout), hence the
   * timer. `/healthz` passes a short timeout with no retry, so a Piped outage can't make the
   * health check itself time out.
   */
  async healthcheck({
    timeoutMs = 5000,
    retry = true,
  }: { timeoutMs?: number; retry?: boolean } = {}): Promise<boolean> {
    const url = new URL('/healthcheck', config.PIPED_API_URL);
    const attempts = retry ? 2 : 1;
    let attempt = 0;
    while (attempt < attempts) {
      try {
        const { statusCode, body } = await withTimeout(
          request(url, {
            method: 'GET',
            headers: { 'User-Agent': 'Sonare/1.0' },
            signal: AbortSignal.timeout(timeoutMs),
          }),
          timeoutMs,
        );
        await body.dump();
        if (statusCode >= 200 && statusCode < 300) {
          return true;
        }
        if (statusCode >= 500 && attempt < attempts - 1) {
          attempt++;
          continue;
        }
        throw new UpstreamError(`Piped returned ${statusCode} for /healthcheck`, 502);
      } catch (e) {
        if (e instanceof UpstreamError) throw e;
        if (attempt < attempts - 1) {
          attempt++;
          continue;
        }
        throw networkError(e);
      }
    }
    throw new UpstreamError('Unreachable', 502);
  },
};
