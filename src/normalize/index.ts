import { LRUCache } from 'lru-cache';
import { signStreamToken } from '../services/token.js';
import { PermanentCache } from '../services/cache.js';
import { directImageUrl } from '../upstream/ytImages.js';
import { setCatalogImages } from '../shared/catalog/normalize.js';

// The normalizers themselves are the apps' own (sonare-frontend/shared/catalog/normalize.ts,
// copied into src/shared by the root repo's scripts/sync-shared-catalog.mjs), so the backend
// and in-app YouTube map Piped results the same way. Only the artwork urls differ: the backend
// points them at its own artwork routes, which resize and cache the images.
export {
  normalizeChannelTabAlbum,
  normalizeChannelToArtist,
  normalizePlaylistToAlbum,
  normalizeStreamItemToAlbum,
  normalizeStreamItemToArtist,
  normalizeStreamItemToTrack,
  normalizeStreamToTrack,
  withUserFields,
} from '../shared/catalog/normalize.js';

// Album covers in search / artist results are resizable googleusercontent urls
// (`=w544-h544`), while the playlist endpoint only offers a signed full-size one (~2MB).
// Remember the resizable one per album so the artwork route can serve thumbnails. Redis
// keeps them across restarts; the in-memory copy saves the round trip.
const albumThumbs = new LRUCache<string, string>({ max: 5000, ttl: 7 * 24 * 3600 * 1000 });

const rememberAlbumThumb = (rawId: string, proxied: string | undefined) => {
  if (rawId === 'unknown' || !proxied || !/=w\d+-h\d+/.test(proxied)) return;
  // Stored without the Piped proxy's address, which can change while this is cached.
  const url = directImageUrl(proxied);
  if (albumThumbs.get(rawId) === url) return;
  albumThumbs.set(rawId, url);
  void PermanentCache.setAlbumThumb(rawId, url);
};

export const albumThumbFor = async (rawId: string): Promise<string | undefined> => {
  const known = albumThumbs.get(rawId);
  if (known) return known;
  const cached = await PermanentCache.getAlbumThumb(rawId);
  // Entries saved before 2026-10 still carry the proxy's address.
  const stored = cached ? directImageUrl(cached) : undefined;
  if (stored) albumThumbs.set(rawId, stored);
  return stored;
};

/** A 30-day image token; the backend fetches the image straight from Google's CDN. */
export const proxyImageUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  return `/api/v1/image/${signStreamToken(directImageUrl(url), 30 * 24 * 3600 * 1000)}`;
};

setCatalogImages({
  track: (videoId) => `/api/v1/tracks/yt:${videoId}/artwork`,
  artist: (ytid, raw) => (ytid !== 'yt:unknown' ? `/api/v1/artists/${ytid}/artwork` : proxyImageUrl(raw)),
  album: (ytid, raw) => {
    rememberAlbumThumb(ytid.replace(/^yt:/, ''), raw);
    return ytid !== 'yt:unknown' ? `/api/v1/albums/${ytid}/artwork` : proxyImageUrl(raw);
  },
});
