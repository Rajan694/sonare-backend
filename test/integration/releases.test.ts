import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import request from 'supertest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { clearReleasesCache, toAppReleases, type GitHubRelease } from '../../src/services/releases.js';
import { createAdminUser } from '../factories.js';

const GITHUB = 'https://api.github.com';
const LATEST = `/repos/${config.RELEASES_REPO}/releases/latest`;

const asset = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 1000 + id,
  state: 'uploaded',
  browser_download_url: `https://github.com/${config.RELEASES_REPO}/releases/download/v1.2.0/${name}`,
  updated_at: '2026-10-12T10:00:00Z',
  digest: `sha256:${'ab'.repeat(32)}`,
  ...extra,
});

const release: GitHubRelease = {
  tag_name: 'v1.2.0',
  body: 'Synced lyrics in more scripts.\n',
  assets: [
    asset(1, 'sonare-android-arm64.apk'),
    asset(2, 'sonare-1.2.0-android-x86_64-emulator.apk'),
    asset(3, 'sonare-linux-x64.AppImage'),
    asset(4, 'sonare-linux-x64.deb', { digest: null }),
    asset(5, 'sonare-linux-x64.tar.gz'),
    asset(6, 'sonare-windows-x64.exe'),
    asset(7, 'sonare-windows-x64.exe.sha256'),
    asset(8, 'sonare-linux-x64.AppImage', { state: 'starter' }),
  ] as GitHubRelease['assets'],
};

describe('App releases from GitHub', () => {
  const app = createApp();
  let agent: MockAgent;
  let original: Dispatcher;

  beforeEach(async () => {
    await clearReleasesCache();
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/127\.0\.0\.1|localhost/);
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(original);
  });

  const github = () => agent.get(GITHUB);

  it('BE-REL-001: lists the fixed-name builds of the latest release, nothing else', async () => {
    github().intercept({ path: LATEST, method: 'GET' }).reply(200, release);
    const res = await request(app).get('/api/v1/releases');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { fileName: string }) => r.fileName)).toEqual([
      'sonare-android-arm64.apk',
      'sonare-linux-x64.AppImage',
      'sonare-linux-x64.deb',
      'sonare-linux-x64.tar.gz',
      'sonare-windows-x64.exe',
    ]);
    expect(res.body.items[0]).toEqual({
      id: '1',
      platform: 'android',
      format: 'apk',
      version: '1.2.0',
      fileName: 'sonare-android-arm64.apk',
      sizeBytes: 1001,
      sha256: 'ab'.repeat(32),
      notes: 'Synced lyrics in more scripts.',
      uploadedAt: '2026-10-12T10:00:00Z',
      url: `https://github.com/${config.RELEASES_REPO}/releases/download/v1.2.0/sonare-android-arm64.apk`,
    });
    // An asset GitHub has no digest for can't be checked, but is still offered.
    expect(res.body.items.find((r: { format: string }) => r.format === 'deb').sha256).toBeNull();
  });

  it('BE-REL-002: asks GitHub once per 10 minutes, with the token when one is set', async () => {
    const saved = config.GITHUB_TOKEN;
    config.GITHUB_TOKEN = 'ghp_test';
    let auth: unknown;
    github()
      .intercept({ path: LATEST, method: 'GET' })
      .reply(200, (opts) => {
        auth = (opts.headers as Record<string, string>).Authorization;
        return release;
      });
    try {
      expect((await request(app).get('/api/v1/releases')).body.items).toHaveLength(5);
      // A second interceptor isn't registered: another call to GitHub would fail the request.
      expect((await request(app).get('/api/v1/releases')).body.items).toHaveLength(5);
      expect(auth).toBe('Bearer ghp_test');
    } finally {
      config.GITHUB_TOKEN = saved;
    }
  });

  it('BE-REL-003: no release yet is an empty list', async () => {
    github().intercept({ path: LATEST, method: 'GET' }).reply(404, { message: 'Not Found' });
    const res = await request(app).get('/api/v1/releases');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('BE-REL-004: when GitHub fails, the last good list is served; with none, 502', async () => {
    github().intercept({ path: LATEST, method: 'GET' }).reply(403, { message: 'API rate limit exceeded' });
    const none = await request(app).get('/api/v1/releases');
    expect(none.status).toBe(502);
    expect(none.body.error.code).toBe('UPSTREAM_UNAVAILABLE');

    github().intercept({ path: LATEST, method: 'GET' }).reply(200, release);
    expect((await request(app).get('/api/v1/releases')).body.items).toHaveLength(5);

    // Eleven minutes later the fresh copy is gone, and so is GitHub.
    const { redis } = await import('../../src/services/cache.js');
    await redis.del('releases:latest');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    github().intercept({ path: LATEST, method: 'GET' }).reply(503, 'down');
    const stale = await request(app).get('/api/v1/releases');
    expect(stale.status).toBe(200);
    expect(stale.body.items).toHaveLength(5);
  });

  it('BE-REL-005: a download redirects to the file on GitHub; unknown ids are 404', async () => {
    github().intercept({ path: LATEST, method: 'GET' }).reply(200, release);
    const res = await request(app).get('/api/v1/releases/6/download');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `https://github.com/${config.RELEASES_REPO}/releases/download/v1.2.0/sonare-windows-x64.exe`,
    );
    expect((await request(app).get('/api/v1/releases/2/download')).status).toBe(404); // emulator APK
    expect((await request(app).get('/api/v1/releases/999/download')).status).toBe(404);
    expect((await request(app).get('/api/v1/releases/not-a-number/download')).status).toBe(404);
  });

  it('BE-REL-006: the admin upload endpoints are gone', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/releases').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('BE-REL-007: toAppReleases strips the v from the tag and keeps an untagged version as is', () => {
    expect(toAppReleases({ ...release, tag_name: '2.0.0', body: null })[0]).toMatchObject({
      version: '2.0.0',
      notes: null,
    });
  });
});
