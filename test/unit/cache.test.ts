import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachedPiped, PermanentCache, TTL, streamTtl } from '../../src/services/cache.js';
import type * as T from '../../src/upstream/piped.types.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { samplePipedChannel, samplePipedPlaylist, samplePipedStream } from '../factories.js';

describe('cache.ts: Redis & in-memory fallback', () => {
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-CACHE-001: CachedPiped.getStream caches response on first fetch and returns cached data on second fetch', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/streams/cachedStream1', method: 'GET' }).reply(200, samplePipedStream('cachedStream1'));

    const res1 = await CachedPiped.getStream('cachedStream1');
    expect(res1).toMatchObject({ id: 'cachedStream1' });

    // Second call should not hit mock agent because it is served from cache
    const res2 = await CachedPiped.getStream('cachedStream1');
    expect(res2).toMatchObject({ id: 'cachedStream1' });
  });

  it('BE-CACHE-002: CachedPiped.playlist caches playlist metadata', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/playlists/PLcache1', method: 'GET' }).reply(200, samplePipedPlaylist('PLcache1'));

    const p1 = await CachedPiped.playlist('PLcache1');
    expect(p1).toMatchObject({ id: 'PLcache1' });

    const p2 = await CachedPiped.playlist('PLcache1');
    expect(p2).toMatchObject({ id: 'PLcache1' });
  });

  it('BE-CACHE-003: CachedPiped.channel caches artist channel metadata', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/channel/UCcache1', method: 'GET' }).reply(200, samplePipedChannel('UCcache1'));

    const c1 = await CachedPiped.channel('UCcache1');
    expect(c1.id).toBe('UCcache1');

    const c2 = await CachedPiped.channel('UCcache1');
    expect(c2.id).toBe('UCcache1');
  });

  it('BE-CACHE-004: PermanentCache stores and retrieves lyrics', async () => {
    await PermanentCache.setLyrics('testTrack1', {
      provider: 'lrclib',
      synced: false,
      offsetMs: 0,
      lines: [],
      plain: 'Cached lyrics text',
    });

    const cached = await PermanentCache.getLyrics('testTrack1');
    expect(cached).not.toBeNull();
    expect(cached?.plain).toBe('Cached lyrics text');
  });

  it('BE-CACHE-005: PermanentCache stores and retrieves audio peaks', async () => {
    const samplePeaks = [0.1, 0.5, 0.9, 0.3];
    await PermanentCache.setPeaks('peakVid1', samplePeaks);

    const peaks = await PermanentCache.getPeaks('peakVid1');
    expect(peaks).toEqual(samplePeaks);
  });

  it('BE-CACHE-006: streamTtl never caches a /streams answer past its urls expiring', () => {
    const now = 1_800_000_000_000;
    const at = (expireSec: number | null) =>
      ({
        audioStreams: [{ url: `http://localhost:8091/videoplayback?c=WEB${expireSec ? `&expire=${expireSec}` : ''}` }],
        videoStreams: [],
      }) as unknown as T.Streams;
    expect(streamTtl(at(now / 1000 + 6 * 3600), now)).toBe(TTL.streamsMeta);
    expect(streamTtl(at(now / 1000 + 600), now)).toBe(300);
    expect(streamTtl(at(now / 1000 + 120), now)).toBe(0);
    expect(streamTtl(at(null), now)).toBe(TTL.streamsMeta);
  });
});

describe('cache.ts: Redis degradation', () => {
  it('BE-CACHE-DEG-001: setCached and getCached work gracefully', async () => {
    await PermanentCache.setLyrics('testDeg', {
      provider: 'lrclib',
      synced: false,
      offsetMs: 0,
      lines: [],
      plain: 'Degradation text',
    });
    const res = await PermanentCache.getLyrics('testDeg');
    expect(res?.plain).toBe('Degradation text');
  });

  it('BE-CACHE-DEG-002: CachedPiped.trending caches trending results', async () => {
    const original = getGlobalDispatcher();
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    const client = mockAgent.get('http://localhost:8090');
    // Only one response is mocked: a second request to Piped would fail the test.
    client
      .intercept({ path: '/trending?region=US', method: 'GET' })
      .reply(200, [{ url: '/watch?v=trend1', title: 'Trending One', type: 'stream' }]);

    const first = await CachedPiped.trending('US');
    const second = await CachedPiped.trending('US');
    expect(first).toEqual([{ url: '/watch?v=trend1', title: 'Trending One', type: 'stream' }]);
    expect(second).toEqual(first);
    mockAgent.assertNoPendingInterceptors();
    await mockAgent.close();
    setGlobalDispatcher(original);
  });
});
