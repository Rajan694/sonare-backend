// YouTube image urls. Piped hands them out rewritten through its proxy
// (`http://<proxy>/vi/…?host=i.ytimg.com`). The backend fetches images itself, so it goes to
// Google's CDN directly: covers cached for weeks then don't break when the proxy URL changes.

const IMAGE_HOSTS = /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com)$/;

/** The CDN url behind a Piped-proxied image url; anything else comes back unchanged. */
export function directImageUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = url.slice(q + 1).split('&');
  const host = params.find((p) => p.startsWith('host='))?.slice('host='.length);
  if (!host || !IMAGE_HOSTS.test(host)) return url;

  let path: string;
  try {
    path = new URL(url.slice(0, q)).pathname;
  } catch {
    return url;
  }
  // Raw strings, not URLSearchParams: re-encoding could change a signed cover's `rs`/`sqp`.
  const rest = params.filter((p) => p && !p.startsWith('host=') && !p.startsWith('qhash='));
  return `https://${host}${path}${rest.length ? `?${rest.join('&')}` : ''}`;
}

export type YtThumbName = 'mqdefault' | 'hq720' | 'maxresdefault';

/** A video's thumbnail on i.ytimg.com - the one place these urls are built by hand. */
export function ytThumbUrl(videoId: string, name: YtThumbName): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${name}.jpg`;
}
