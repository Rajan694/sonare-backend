import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LyricsResolver,
  getDbLyricsOverride,
  isInScript,
  lyricsInScript,
  parseLrc,
  resolveLyricsInScript,
} from '../../src/services/lyrics.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

describe('lyrics.ts: resolver', () => {
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

describe('lyrics.ts: preferred script', () => {
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

  const hindi = 'तुम ही हो\nअब तुम ही हो';
  const roman = 'Tum hi ho\nAb tum hi ho';

  it('BE-LYR-SCRIPT-001: isInScript tells scripts apart by most of the letters', () => {
    expect(isInScript(hindi, 'devanagari')).toBe(true);
    expect(isInScript(hindi, 'latin')).toBe(false);
    expect(isInScript(roman, 'latin')).toBe(true);
    expect(isInScript('ਤੁਸੀਂ ਹੀ ਹੋ', 'gurmukhi')).toBe(true);
    // A Latin word or two in Devanagari lyrics doesn't change the script.
    expect(isInScript(`${hindi}\nOh baby`, 'devanagari')).toBe(true);
    // Timestamps, digits and punctuation aren't letters.
    expect(isInScript('[00:12.00] ♪ 123 …', 'latin')).toBe(false);
    expect(isInScript('', 'latin')).toBe(false);
  });

  it('BE-LYR-SCRIPT-002: lyricsInScript reads synced lines, else the plain text', () => {
    const base = { synced: true, provider: 'lrclib' as const, offsetMs: 0 };
    expect(lyricsInScript({ ...base, lines: [{ atMs: 0, text: 'तुम ही हो' }], plain: roman }, 'devanagari')).toBe(true);
    expect(lyricsInScript({ ...base, synced: false, lines: [], plain: roman }, 'latin')).toBe(true);
    expect(lyricsInScript({ ...base, synced: false, lines: [] }, 'latin')).toBe(false);
  });

  it('BE-LYR-SCRIPT-003: resolveLyricsInScript picks the synced version in that script, close in length', async () => {
    const lrcMock = mockAgent!.get('https://lrclib.net');
    const candidate = (id: number, text: string, extra: object = {}) => ({
      id,
      trackName: 'Tum Hi Ho',
      artistName: 'Arijit Singh',
      albumName: 'Aashiqui 2',
      duration: 262,
      instrumental: false,
      plainLyrics: text,
      syncedLyrics: null,
      ...extra,
    });
    lrcMock
      .intercept({ path: (p) => p.startsWith('/api/search') && p.includes('track_name'), method: 'GET' })
      .reply(200, [
        candidate(1, hindi, { syncedLyrics: '[00:10.00]तुम ही हो' }),
        // Romanised, but a different recording (two minutes longer): skipped.
        candidate(2, roman, { duration: 380, syncedLyrics: '[00:10.00]Tum hi ho' }),
        candidate(3, roman),
      ]);
    lrcMock
      .intercept({ path: (p) => p.startsWith('/api/search') && p.includes('q='), method: 'GET' })
      .reply(200, [
        candidate(4, roman, { duration: 263, syncedLyrics: '[00:11.00]Tum hi ho\n[00:15.00]Ab tum hi ho' }),
      ]);

    const found = await resolveLyricsInScript('Tum Hi Ho', 'Arijit Singh', 262_000, 'latin');
    expect(found).toMatchObject({ synced: true, provider: 'lrclib', offsetMs: 0 });
    expect(found!.lines).toEqual([
      { atMs: 11_000, text: 'Tum hi ho' },
      { atMs: 15_000, text: 'Ab tum hi ho' },
    ]);
  });

  it('BE-LYR-SCRIPT-004: resolveLyricsInScript is null when no version is in that script, or LRCLIB fails', async () => {
    const lrcMock = mockAgent!.get('https://lrclib.net');
    lrcMock
      .intercept({ path: (p) => p.startsWith('/api/search'), method: 'GET' })
      .reply(200, [
        {
          id: 1,
          trackName: 'X',
          artistName: 'Y',
          albumName: '',
          duration: 200,
          instrumental: false,
          plainLyrics: hindi,
          syncedLyrics: null,
        },
      ])
      .times(2);
    expect(await resolveLyricsInScript('X', 'Y', 200_000, 'latin')).toBeNull();

    lrcMock
      .intercept({ path: (p) => p.startsWith('/api/search'), method: 'GET' })
      .reply(500, {})
      .times(2);
    expect(await resolveLyricsInScript('X', 'Y', 200_000, 'latin')).toBeNull();
  });
});
