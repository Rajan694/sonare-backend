import { request } from 'undici';
import { config } from '../config.js';
import { UpstreamError } from '../upstream/piped.js';
import { isRedisAvailable, redis } from './cache.js';

// App builds are the assets of the latest GitHub release of RELEASES_REPO, under fixed names
// (../sonare-frontend/buildFE.sh `prod all` makes them). The intro page links to them
// directly; GET /releases describes them for the apps' update check.

export const PLATFORMS = ['android', 'linux', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The files a release carries; other assets (the emulator APK, checksums) are left out. */
export const RELEASE_ASSETS: Record<string, { platform: Platform; format: string }> = {
  'sonare-android-arm64.apk': { platform: 'android', format: 'apk' },
  'sonare-linux-x64.AppImage': { platform: 'linux', format: 'appimage' },
  'sonare-linux-x64.deb': { platform: 'linux', format: 'deb' },
  'sonare-linux-x64.tar.gz': { platform: 'linux', format: 'tar.gz' },
  'sonare-windows-x64.exe': { platform: 'windows', format: 'exe' },
};

/** What the apps see (shared/apiTypes.ts AppRelease). */
export interface AppRelease {
  /** The GitHub asset id. */
  id: string;
  platform: Platform;
  format: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string | null;
  notes: string | null;
  uploadedAt: string;
  url: string;
}

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  state?: string;
  browser_download_url: string;
  updated_at: string;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  body: string | null;
  assets: GitHubAsset[];
}

export const toAppReleases = (release: GitHubRelease): AppRelease[] => {
  const version = release.tag_name.replace(/^v/, '');
  return release.assets.flatMap((asset) => {
    const kind = RELEASE_ASSETS[asset.name];
    if (!kind || (asset.state && asset.state !== 'uploaded')) return [];
    return [
      {
        id: String(asset.id),
        ...kind,
        version,
        fileName: asset.name,
        sizeBytes: asset.size,
        sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null,
        notes: release.body?.trim() || null,
        uploadedAt: asset.updated_at,
        url: asset.browser_download_url,
      },
    ];
  });
};

const fetchLatest = async (): Promise<AppRelease[]> => {
  const url = `https://api.github.com/repos/${config.RELEASES_REPO}/releases/latest`;
  let res;
  try {
    res = await request(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Sonare',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(config.GITHUB_TOKEN && { Authorization: `Bearer ${config.GITHUB_TOKEN}` }),
      },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
  } catch (err) {
    throw new UpstreamError(`GitHub is unreachable (${(err as Error).message})`, 502, true);
  }
  // No release published yet.
  if (res.statusCode === 404) {
    await res.body.dump();
    return [];
  }
  if (res.statusCode !== 200) {
    await res.body.dump();
    // 403/429 is GitHub's rate limit (60 an hour per IP without GITHUB_TOKEN).
    throw new UpstreamError(`GitHub answered ${res.statusCode} for the latest release`, 502, true);
  }
  return toAppReleases((await res.body.json()) as GitHubRelease);
};

// Fresh for 10 minutes; the last good answer is kept a week, for when GitHub fails.
const FRESH_TTL_S = 10 * 60;
const LAST_GOOD_TTL_S = 7 * 24 * 60 * 60;
const FRESH_KEY = 'releases:latest';
const LAST_GOOD_KEY = 'releases:last-good';

// Redis is shared and survives restarts; this copy covers a Redis outage.
let memory: { items: AppRelease[]; at: number } | null = null;

const readCache = async (key: string): Promise<AppRelease[] | null> => {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as AppRelease[]) : null;
  } catch {
    return null;
  }
};

const writeCache = async (items: AppRelease[]): Promise<void> => {
  memory = { items, at: Date.now() };
  if (!isRedisAvailable()) return;
  const raw = JSON.stringify(items);
  await Promise.all([
    redis.set(FRESH_KEY, raw, 'EX', FRESH_TTL_S),
    redis.set(LAST_GOOD_KEY, raw, 'EX', LAST_GOOD_TTL_S),
  ]).catch(() => {});
};

/** The latest release's builds, from cache when fresh, else from GitHub, else the last good list. */
export const latestReleases = async (): Promise<AppRelease[]> => {
  const fresh =
    (await readCache(FRESH_KEY)) ?? (memory && Date.now() - memory.at < FRESH_TTL_S * 1000 ? memory.items : null);
  if (fresh) return fresh;
  try {
    const items = await fetchLatest();
    await writeCache(items);
    return items;
  } catch (err) {
    const lastGood = (await readCache(LAST_GOOD_KEY)) ?? memory?.items;
    if (lastGood) return lastGood;
    throw err;
  }
};

/** Forget the cached lists (tests). */
export const clearReleasesCache = async (): Promise<void> => {
  memory = null;
  if (isRedisAvailable()) await redis.del(FRESH_KEY, LAST_GOOD_KEY).catch(() => {});
};
