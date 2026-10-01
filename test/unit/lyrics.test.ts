import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LyricsResolver, getDbLyricsOverride, parseLrc } from '../../src/lyrics.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

describe('lyrics.ts: resolver', () => {
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

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

  it('BE-LYR-COV-001: parseLrc handles offset tags and negative timestamps correctly', () => {
    const lrc = `[offset: 500]\n[00:01.00] Line at 1s + 500ms`;
    const parsed = parseLrc(lrc);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].atMs).toBe(1500);
  });

  it('BE-LYR-COV-002: LyricsResolver resolves via fuzzy search on LRCLIB', async () => {
    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/get?track_name=FuzzySong&artist_name=FuzzyArtist&album_name=&duration=0',
        method: 'GET',
      })
      .reply(404, {});
    lrcMock
      .intercept({
        path: '/api/search?track_name=FuzzySong&artist_name=FuzzyArtist&album_name=',
        method: 'GET',
      })
      .reply(200, [
        {
          id: 999,
          trackName: 'FuzzySong (Remix)',
          syncedLyrics: '[00:05.00] Fuzzy line',
          plainLyrics: 'Fuzzy line',
        },
      ]);

    const res = await LyricsResolver.resolve('trackFuzzy', 'FuzzySong', 'FuzzyArtist');
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('lrclib');
    expect(res?.synced).toBe(true);
  });

  it('BE-LYR-COV-003: LyricsResolver resolves via Genius fallback when LRCLIB fuzzy returns empty', async () => {
    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({
        path: '/api/get?track_name=GeniusOnly&artist_name=GeniusArtist&album_name=&duration=0',
        method: 'GET',
      })
      .reply(404, {});
    lrcMock
      .intercept({
        path: '/api/search?track_name=GeniusOnly&artist_name=GeniusArtist&album_name=',
        method: 'GET',
      })
      .reply(200, []);

    const geniusMock = mockAgent!.get('https://api.genius.com');
    geniusMock
      .intercept({
        path: '/search?q=GeniusOnly%20GeniusArtist',
        method: 'GET',
      })
      .reply(200, {
        response: {
          hits: [
            {
              result: {
                id: 111,
                url: 'https://genius.com/test-song',
              },
            },
          ],
        },
      });

    const res = await LyricsResolver.resolve('trackGenius', 'GeniusOnly', 'GeniusArtist');
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('genius');
    expect(res?.attribution?.url).toBe('https://genius.com/test-song');
  });

  it('BE-LYR-COV-004: getDbLyricsOverride handles missing user id gracefully', async () => {
    const res = await getDbLyricsOverride('some_track', undefined);
    expect(res).toBeNull();
  });
});

describe('lyrics.ts: parseLrc', () => {
  it('BE-PURE-009: parseLrc accurately parses standard LRC timestamps and text', () => {
    const lrc = `[00:12.50]Hello world\n[01:05.12]Second line\n[02:00.00]Final outro`;
    const parsed = parseLrc(lrc);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].atMs).toBe(12500);
    expect(parsed[0].text).toBe('Hello world');
    expect(parsed[1].atMs).toBe(65120);
    expect(parsed[1].text).toBe('Second line');
    expect(parsed[2].atMs).toBe(120000);
    expect(parsed[2].text).toBe('Final outro');
  });

  it('BE-PURE-010: parseLrc ignores metadata headers and blank lines', () => {
    const lrc = `[ar:Rick Astley]\n[ti:Never Gonna Give You Up]\n\n[00:10.00]First real lyric\n`;
    const parsed = parseLrc(lrc);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('First real lyric');
  });
});
