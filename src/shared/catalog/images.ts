// GENERATED from sonare-frontend/shared/catalog/images.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// YouTube image URLs - port of backend/src/upstream/ytImages.ts and resize rules.
// Pure string operations only. No Node APIs, no DOM, no URL class.

const IMAGE_HOSTS = /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com)$/;

/**
 * The CDN URL behind a Piped-proxied image URL; anything else comes back unchanged.
 * String ops only.
 */
export function directImageUrl(url: string): string;
export function directImageUrl(url: undefined): undefined;
export function directImageUrl(url: string | undefined): string | undefined;
export function directImageUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = url.slice(q + 1).split('&');
  const host = params.find((p) => p.startsWith('host='))?.slice('host='.length);
  if (!host || !IMAGE_HOSTS.test(host)) return url;

  const withoutQuery = url.slice(0, q);
  const schemeIdx = withoutQuery.indexOf('://');
  let path = withoutQuery;
  if (schemeIdx >= 0) {
    const slashIdx = withoutQuery.indexOf('/', schemeIdx + 3);
    path = slashIdx >= 0 ? withoutQuery.slice(slashIdx) : '/';
  }

  // Raw strings, not URLSearchParams: re-encoding could change a signed cover's `rs`/`sqp`.
  const rest = params.filter((p) => p && !p.startsWith('host=') && !p.startsWith('qhash='));
  return `https://${host}${path}${rest.length ? `?${rest.join('&')}` : ''}`;
}

/**
 * Direct thumbnail URL for a track (video).
 * Uses mqdefault (16:9 without black bars), matching backend artwork route.
 */
export const trackThumbUrl = (videoId: string): string => {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
};

/**
 * Resizes an image URL according to backend rules in handlePlaylistArtwork and artist artwork.
 * String ops only.
 * - Album covers are signed (/s_p/...&rs=...); skip signed `rs=` URLs.
 * - Swap maxresdefault / hqdefault / mqdefault depending on target size.
 * - Replaces `=s\d+` with `=s${size}` and `=w\d+-h\d+` with `=w${size}-h${size}`.
 */
export function sizedImageUrl(url: string, size: 64 | 140 | 300 | 640): string;
export function sizedImageUrl(url: undefined, size: 64 | 140 | 300 | 640): undefined;
export function sizedImageUrl(url: string | undefined, size: 64 | 140 | 300 | 640): string | undefined;
export function sizedImageUrl(url: string | undefined, size: 64 | 140 | 300 | 640): string | undefined {
  if (!url) return url;
  // Album covers are signed (/s_p/...&rs=...); renaming the file breaks the signature.
  const signed = /[?&]rs=/.test(url);
  if (signed) return url;

  let res = url;
  if (size <= 140) {
    res = res.replace('/maxresdefault.jpg', '/mqdefault.jpg').replace('/hqdefault.jpg', '/mqdefault.jpg');
  } else if (size <= 300) {
    res = res.replace('/maxresdefault.jpg', '/hqdefault.jpg');
  }

  res = res.replace(/=s\d+/, `=s${size}`).replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
  return res;
}
