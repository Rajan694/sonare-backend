import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { Piped, UpstreamError } from '../../src/upstream/piped.js';
import { Lrclib } from '../../src/upstream/lrclib.js';
import { Genius } from '../../src/upstream/genius.js';

describe('Upstream clients (Piped, LRCLIB, Genius)', () => {
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

  describe('Piped Client', () => {
    it('BE-UPS-001: Piped.search queries search endpoint and returns results', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/search?q=test&filter=all',
          method: 'GET',
        })
        .reply(200, {
          items: [{ url: '/watch?v=123', title: 'Test', type: 'stream' }],
          nextpage: null,
        });

      const res = await Piped.search('test', 'all');
      expect(res.items).toHaveLength(1);
      expect(res.items[0].title).toBe('Test');
    });

    it('BE-UPS-002: Piped.searchNextPage queries nextpage search endpoint', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/nextpage/search?nextpage=cur123&q=test&filter=music_songs',
          method: 'GET',
        })
        .reply(200, {
          items: [{ url: '/watch?v=paged1', title: 'Paged', type: 'stream' }],
          nextpage: null,
        });

      const res = await Piped.searchNextPage('test', 'cur123', 'music_songs');
      expect(res.items).toHaveLength(1);
      expect(res.items[0].title).toBe('Paged');
    });

    it('BE-UPS-003: Piped.getStream fetches video stream details', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/streams/stream123',
          method: 'GET',
        })
        .reply(200, {
          title: 'Stream Title',
          duration: 200,
          audioStreams: [],
        });

      const res = await Piped.getStream('stream123');
      expect(res.title).toBe('Stream Title');
      expect(res.duration).toBe(200);
    });

    it('BE-UPS-004: Piped.playlist fetches playlist details', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/playlists/PLtest1',
          method: 'GET',
        })
        .reply(200, {
          name: 'Playlist Title',
          videos: 5,
        });

      const res = await Piped.playlist('PLtest1');
      expect(res.name).toBe('Playlist Title');
      expect(res.videos).toBe(5);
    });

    it('BE-UPS-005: Piped.channel fetches channel details', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/channel/UCtestChannel',
          method: 'GET',
        })
        .reply(200, {
          name: 'Artist Channel',
          subscriberCount: 10000,
        });

      const res = await Piped.channel('UCtestChannel');
      expect(res.name).toBe('Artist Channel');
      expect(res.subscriberCount).toBe(10000);
    });

    it('BE-UPS-006: Piped.suggestions returns search suggestion strings', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/suggestions?query=hello',
          method: 'GET',
        })
        .reply(200, ['hello world', 'hello adele']);

      const res = await Piped.suggestions('hello');
      expect(res).toEqual(['hello world', 'hello adele']);
    });

    it('BE-UPS-007: Piped throws UpstreamError on 500 error response', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/streams/err500',
          method: 'GET',
        })
        .reply(500, { error: 'Internal Piped error' });

      await expect(Piped.getStream('err500')).rejects.toThrow(UpstreamError);
    });

    it('BE-UPS-008: Piped throws UpstreamError when network fails or connection refused', async () => {
      const client = mockAgent!.get('http://localhost:8090');
      client
        .intercept({
          path: '/streams/netErr',
          method: 'GET',
        })
        .replyWithError(new Error('ECONNREFUSED'));

      await expect(Piped.getStream('netErr')).rejects.toThrow(UpstreamError);
    });
  });

  describe('Lrclib Client', () => {
    it('BE-UPS-009: Lrclib.get fetches lyrics successfully for track and artist', async () => {
      const client = mockAgent!.get('https://lrclib.net');
      client
        .intercept({
          path: '/api/get?track_name=Song&artist_name=Artist',
          method: 'GET',
        })
        .reply(200, {
          id: 1,
          trackName: 'Song',
          artistName: 'Artist',
          plainLyrics: 'La la la',
          syncedLyrics: '[00:01.00] La la la',
          duration: 180,
        });

      const lyrics = await Lrclib.get('Song', 'Artist');
      expect(lyrics).toBeDefined();
      expect(lyrics?.plainLyrics).toBe('La la la');
    });

    it('BE-UPS-010: Lrclib.get returns null when lyrics not found (404)', async () => {
      const client = mockAgent!.get('https://lrclib.net');
      client
        .intercept({
          path: '/api/get?track_name=NotFound&artist_name=Nobody',
          method: 'GET',
        })
        .reply(404, { error: 'Not found' });

      const lyrics = await Lrclib.get('NotFound', 'Nobody');
      expect(lyrics).toBeNull();
    });

    it('BE-UPS-011: Lrclib.search queries search endpoint on lrclib', async () => {
      const client = mockAgent!.get('https://lrclib.net');
      client
        .intercept({
          path: '/api/search?q=bohemian%20rhapsody',
          method: 'GET',
        })
        .reply(200, [
          {
            id: 2,
            trackName: 'Bohemian Rhapsody',
            artistName: 'Queen',
            plainLyrics: 'Is this the real life?',
          },
        ]);

      const results = await Lrclib.search('bohemian rhapsody');
      expect(results).toHaveLength(1);
      expect(results[0].trackName).toBe('Bohemian Rhapsody');
    });
  });

  describe('Genius Client', () => {
    it('BE-UPS-012: Genius.search searches Genius API and returns song hits', async () => {
      const client = mockAgent!.get('https://api.genius.com');
      client
        .intercept({
          path: '/search?q=Song',
          method: 'GET',
        })
        .reply(200, {
          response: {
            hits: [
              {
                result: {
                  id: 123,
                  title: 'Song',
                  url: 'https://genius.com/Song-lyrics',
                },
              },
            ],
          },
        });

      const hit = await Genius.search('Song');
      expect(hit?.response?.hits).toHaveLength(1);
      expect(hit?.response?.hits[0].result.title).toBe('Song');
    });

    it('BE-UPS-013: Genius.song fetches song details by id', async () => {
      const client = mockAgent!.get('https://api.genius.com');
      client
        .intercept({
          path: '/songs/123',
          method: 'GET',
        })
        .reply(200, {
          response: {
            song: {
              id: 123,
              title: 'Song Title',
            },
          },
        });

      const res = await Genius.song(123);
      expect(res?.response?.song?.title).toBe('Song Title');
    });
  });
});

describe('Piped client: extra branches', () => {
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

  it('BE-PIPED-EXTRA-001: Piped.trending fetches trending streams with custom region', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client
      .intercept({ path: '/trending?region=US', method: 'GET' })
      .reply(200, [{ url: '/watch?v=usTrack1', title: 'US Track' }]);

    const res = await Piped.trending('US');
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('US Track');
  });

  it('BE-PIPED-EXTRA-002: Piped.playlistNextPage fetches paged playlist streams', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client
      .intercept({ path: '/nextpage/playlists/PLpagedPl?nextpage=next123', method: 'GET' })
      .reply(200, { relatedStreams: [{ url: '/watch?v=pl1' }], nextpage: null });

    const res = await Piped.playlistNextPage('PLpagedPl', 'next123');
    expect(res.relatedStreams).toHaveLength(1);
  });
});
