import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createUser, samplePipedChannel, samplePipedStream, isLocalTestHost } from '../factories.js';
import { db } from '../../src/db/index.js';
import { artistFollows, favouriteTracks, playlists, playlistTracks } from '../../src/db/schema.js';
import { PermanentCache } from '../../src/services/cache.js';
import { saveDbLyricsOverride } from '../../src/services/lyrics.js';

// Browse categories, the Library's derived artists, the preferred lyrics script and album
// cover hints that survive a restart.

describe('Browse categories, library artists, lyrics script, cover hints', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect(isLocalTestHost);
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  const piped = () => mockAgent!.get('http://localhost:8090');
  const lrclib = () => mockAgent!.get('https://lrclib.net');

  /** A song by `name` on channel `channel`. */
  const stream = (id: string, name: string, channel: string) => ({
    ...samplePipedStream(id),
    uploader: `${name} - Topic`,
    uploaderUrl: `/channel/${channel}`,
  });

  // ---- GET /genres ----

  it('BE-BROWSE-001: GET /api/v1/genres lists the Indian and mood categories, each with its search', async () => {
    const res = await request(app).get('/api/v1/genres');
    expect(res.status).toBe(200);
    const names = res.body.map((g: { name: string }) => g.name);
    expect(names).toEqual(
      expect.arrayContaining(['Popular', 'Top this year', 'Punjabi', 'Bhojpuri', 'Devotional', 'Party', 'Sad']),
    );
    expect(names).not.toContain('Ambient');
    for (const g of res.body) {
      expect(g).toEqual({ id: expect.any(String), name: expect.any(String), query: expect.any(String) });
    }
    expect(new Set(res.body.map((g: { id: string }) => g.id)).size).toBe(res.body.length);
  });

  it('BE-BROWSE-002: "Top this year" searches for the current year', async () => {
    const res = await request(app).get('/api/v1/genres');
    const top = res.body.find((g: { id: string }) => g.id === 'top-this-year');
    expect(top.query).toBe(`top songs ${new Date().getFullYear()}`);
  });

  // ---- GET /me/library/artists ----

  it('BE-LIBART-001: followed artists come first, then the artists of liked and playlisted songs by song count', async () => {
    const { user, token } = await createUser();
    await db.insert(artistFollows).values({ userId: user.id, artistId: 'UCfollowed' });
    await db.insert(favouriteTracks).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'v1' },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'v2' },
      { userId: user.id, trackRefKind: 'server', trackRefId: 'v3' },
    ]);
    await db.insert(playlists).values({ id: 'sonare:mix', userId: user.id, name: 'Mix', kind: 'synced' });
    await db.insert(playlistTracks).values([
      // Already liked: counted once.
      { playlistId: 'sonare:mix', position: 0, trackRefKind: 'server', trackRefId: 'v1' },
      { playlistId: 'sonare:mix', position: 1, trackRefKind: 'server', trackRefId: 'v4' },
    ]);

    piped().intercept({ path: '/channel/UCfollowed', method: 'GET' }).reply(200, samplePipedChannel('UCfollowed'));
    piped()
      .intercept({ path: '/streams/v1', method: 'GET' })
      .reply(200, stream('v1', 'Diljit Dosanjh', 'UCdiljit'));
    piped()
      .intercept({ path: '/streams/v2', method: 'GET' })
      .reply(200, stream('v2', 'Arijit Singh', 'UCarijit'));
    piped()
      .intercept({ path: '/streams/v3', method: 'GET' })
      .reply(200, stream('v3', 'Diljit Dosanjh', 'UCdiljit'));
    // A song by the followed artist doesn't list them twice.
    piped()
      .intercept({ path: '/streams/v4', method: 'GET' })
      .reply(200, stream('v4', 'Rick Astley', 'UCfollowed'));

    const res = await request(app).get('/api/v1/me/library/artists').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.items.map((a: { id: string }) => a.id)).toEqual(['yt:UCfollowed', 'yt:UCdiljit', 'yt:UCarijit']);
    expect(res.body.items[0]).toMatchObject({ following: true, name: 'Rick Astley' });
    expect(res.body.items[1]).toEqual({
      id: 'yt:UCdiljit',
      name: 'Diljit Dosanjh',
      songCount: 2,
      albumCount: 0,
      localTrackCount: 0,
      following: false,
      thumbnail: '/api/v1/artists/yt:UCdiljit/artwork',
    });
    expect(res.body.items[2]).toMatchObject({ name: 'Arijit Singh', songCount: 1, following: false });
  });

  it("BE-LIBART-002: songs Piped can't describe, local songs and other users' playlists are left out", async () => {
    const { user, token } = await createUser();
    const other = await createUser({ email: 'other@example.com' });
    await db.insert(favouriteTracks).values([
      { userId: user.id, trackRefKind: 'server', trackRefId: 'gone' },
      { userId: user.id, trackRefKind: 'local', trackRefId: 'fp-123' },
    ]);
    await db.insert(playlists).values({ id: 'sonare:theirs', userId: other.user.id, name: 'Theirs', kind: 'synced' });
    await db
      .insert(playlistTracks)
      .values({ playlistId: 'sonare:theirs', position: 0, trackRefKind: 'server', trackRefId: 'theirs1' });
    piped().intercept({ path: '/streams/gone', method: 'GET' }).reply(500, { error: 'Video unavailable' });

    const res = await request(app).get('/api/v1/me/library/artists').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], meta: { total: 0 } });
  });

  // ---- GET /tracks/:id/lyrics?script= ----

  const hindiLrc = '[00:10.00]तुम ही हो\n[00:14.00]अब तुम ही हो';
  const romanLrc = '[00:10.50]Tum hi ho\n[00:14.50]Ab tum hi ho';

  /** LRCLIB's exact match is the Devanagari version. */
  const exactMatchIsHindi = () => {
    lrclib()
      .intercept({ path: (p) => p.startsWith('/api/get?'), method: 'GET' })
      .reply(200, { id: 1, syncedLyrics: hindiLrc, plainLyrics: 'तुम ही हो\nअब तुम ही हो' });
  };

  /** Answers LRCLIB searches with `results`; returns how many were made. */
  const searchResults = (results: object[], times = 2) => {
    const calls = { count: 0 };
    lrclib()
      .intercept({ path: (p) => p.startsWith('/api/search'), method: 'GET' })
      .reply(() => {
        calls.count++;
        return {
          statusCode: 200,
          data: JSON.stringify(results),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(times);
    return calls;
  };

  const romanCandidate = {
    id: 2,
    trackName: 'Never Gonna Give You Up',
    artistName: 'Rick Astley',
    albumName: '',
    duration: 213,
    instrumental: false,
    plainLyrics: 'Tum hi ho\nAb tum hi ho',
    syncedLyrics: romanLrc,
  };

  it('BE-LYRICS-007: script=latin swaps Devanagari lyrics for the romanised LRCLIB version', async () => {
    piped().intercept({ path: '/streams/scr1', method: 'GET' }).reply(200, samplePipedStream('scr1'));
    exactMatchIsHindi();
    searchResults([romanCandidate]);

    const res = await request(app).get('/api/v1/tracks/yt:scr1/lyrics?script=latin');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ synced: true, provider: 'lrclib' });
    expect(res.body.lines).toEqual([
      { atMs: 10_500, text: 'Tum hi ho' },
      { atMs: 14_500, text: 'Ab tum hi ho' },
    ]);

    // The same track without a preference still gets the original.
    const original = await request(app).get('/api/v1/tracks/yt:scr1/lyrics');
    expect(original.body.lines[0].text).toBe('तुम ही हो');
  });

  it('BE-LYRICS-008: lyrics already in the preferred script are served without another LRCLIB search', async () => {
    piped().intercept({ path: '/streams/scr2', method: 'GET' }).reply(200, samplePipedStream('scr2'));
    exactMatchIsHindi();
    const searches = searchResults([romanCandidate]);

    const res = await request(app).get('/api/v1/tracks/yt:scr2/lyrics?script=devanagari');
    expect(res.status).toBe(200);
    expect(res.body.lines[0].text).toBe('तुम ही हो');
    expect(searches.count).toBe(0);
    expect(await PermanentCache.getScriptLyrics('scr2', 'devanagari')).toBeNull();
  });

  it('BE-LYRICS-009: with no version in that script the original stays, and the miss is remembered', async () => {
    piped().intercept({ path: '/streams/scr3', method: 'GET' }).reply(200, samplePipedStream('scr3'));
    exactMatchIsHindi();
    const searches = searchResults([{ ...romanCandidate, syncedLyrics: hindiLrc, plainLyrics: 'तुम ही हो' }], 4);

    const first = await request(app).get('/api/v1/tracks/yt:scr3/lyrics?script=latin');
    expect(first.status).toBe(200);
    expect(first.body.lines[0].text).toBe('तुम ही हो');
    expect(await PermanentCache.getScriptLyrics('scr3', 'latin')).toEqual({ lyrics: null });

    expect(searches.count).toBe(2);

    // Asked again: answered from the cache, LRCLIB isn't searched again.
    const again = await request(app).get('/api/v1/tracks/yt:scr3/lyrics?script=latin');
    expect(again.status).toBe(200);
    expect(again.body.lines[0].text).toBe('तुम ही हो');
    expect(searches.count).toBe(2);
  });

  it("BE-LYRICS-010: the user's own lyrics win over the preferred script", async () => {
    const { user, token } = await createUser();
    await saveDbLyricsOverride('scr4', user.id, { lrc: '[00:01.00]मेरे बोल' });

    const res = await request(app)
      .get('/api/v1/tracks/yt:scr4/lyrics?script=latin')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'user', synced: true });
    expect(res.body.lines).toEqual([{ atMs: 1000, text: 'मेरे बोल' }]);
  });

  it('BE-LYRICS-011: an unknown script is a 400; "original" behaves like no preference', async () => {
    const bad = await request(app).get('/api/v1/tracks/yt:scr5/lyrics?script=klingon');
    expect(bad.status).toBe(400);

    piped().intercept({ path: '/streams/scr5', method: 'GET' }).reply(200, samplePipedStream('scr5'));
    exactMatchIsHindi();
    const res = await request(app).get('/api/v1/tracks/yt:scr5/lyrics?script=original');
    expect(res.status).toBe(200);
    expect(res.body.lines[0].text).toBe('तुम ही हो');
  });

  it('BE-LYRICS-012: when the version search fails, the original lyrics are still served', async () => {
    piped().intercept({ path: '/streams/scr6', method: 'GET' }).reply(200, samplePipedStream('scr6'));
    exactMatchIsHindi();
    lrclib()
      .intercept({ path: (p) => p.startsWith('/api/search'), method: 'GET' })
      .reply(503, {})
      .times(2);

    const res = await request(app).get('/api/v1/tracks/yt:scr6/lyrics?script=latin');
    expect(res.status).toBe(200);
    expect(res.body.lines[0].text).toBe('तुम ही हो');
  });

  // ---- album cover hints ----

  it('BE-COVER-001: a cover hint kept in Redis serves a small album cover without asking Piped', async () => {
    await PermanentCache.setAlbumThumb('PLstored1', 'https://lh3.googleusercontent.com/cover=w544-h544-l90-rj');
    // No Piped intercept: the playlist endpoint would fail the request.
    const res = await request(app).get('/api/v1/albums/yt:PLstored1/artwork?size=140');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/api\/v1\/image\//);
  });

  it('BE-COVER-002: covers seen in search results are written to Redis for 30 days', async () => {
    piped()
      .intercept({ path: (p) => p.startsWith('/search?'), method: 'GET' })
      .reply(200, {
        items: [
          {
            type: 'playlist',
            url: '/playlist?list=PLseen1',
            name: 'Seen album',
            thumbnail: 'https://lh3.googleusercontent.com/seen=w544-h544-l90-rj',
            uploaderName: 'Someone',
            uploaderUrl: '/channel/UCsomeone',
            videos: 9,
          },
        ],
        nextpage: null,
      });

    const res = await request(app).get('/api/v1/search?q=seen&type=albums');
    expect(res.status).toBe(200);
    await expect
      .poll(() => PermanentCache.getAlbumThumb('PLseen1'))
      .toBe('https://lh3.googleusercontent.com/seen=w544-h544-l90-rj');
  });
});
