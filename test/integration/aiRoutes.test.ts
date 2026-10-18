import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { playHistory } from '../../src/db/schema.js';
import { redis } from '../../src/services/cache.js';
import { getAiProvider, updateAiProvider } from '../../src/services/ai/providers.js';
import { resetTitleWorker, runTitleBatch } from '../../src/services/ai/titles.js';
import { createUser } from '../factories.js';
import { FIRST_URL, SECOND_URL, failure, replyJson, resetAi, stubProviders, twoProviders } from '../aiFakes.js';

const app = createApp();

const addPlays = async (userId: string, songs: [string, string, string][], times = 1) => {
  let at = Date.now() - 1000 * 60 * 60;
  for (let n = 0; n < times; n++) {
    for (const [id, title, artist] of songs) {
      at += 1000;
      await db.insert(playHistory).values({
        userId,
        trackRefKind: 'server',
        trackRefId: id,
        playedAt: new Date(at),
        msPlayed: 60_000,
        meta: { title, artist, artistId: 'yt:UC1', durationMs: 200_000 },
      });
    }
  }
};

const SONGS: [string, string, string][] = [
  ['vid0000001', 'Tum Hi Ho', 'Arijit Singh'],
  ['vid0000002', 'Kesariya', 'Arijit Singh'],
  ['vid0000003', 'Raataan Lambiyan', 'Jubin Nautiyal'],
];

describe('AI routes', () => {
  beforeEach(async () => {
    await resetAi();
    resetTitleWorker();
  });
  afterAll(resetAi);

  it('BE-AI-015: the signed-in AI routes answer 401 when signed out', async () => {
    expect((await request(app).get('/api/v1/me/ai/you-may-like')).status).toBe(401);
    expect((await request(app).get('/api/v1/ai/search?q=sad songs')).status).toBe(401);
    expect((await request(app).post('/api/v1/me/ai/playlist').send({ prompt: 'rainy day' })).status).toBe(401);
  });

  it('BE-AI-016: with no provider answering they answer 503 AI_UNAVAILABLE', async () => {
    const { token } = await createUser();
    const auth = { Authorization: `Bearer ${token}` };
    const search = await request(app).get('/api/v1/ai/search?q=sad songs').set(auth);
    expect(search.status).toBe(503);
    expect(search.body.error.code).toBe('AI_UNAVAILABLE');
    const playlist = await request(app).post('/api/v1/me/ai/playlist').set(auth).send({ prompt: 'rainy day' });
    expect(playlist.body.error.code).toBe('AI_UNAVAILABLE');
  });

  it('BE-AI-017: you-may-like with fewer than 5 plays answers no picks without asking the AI', async () => {
    await twoProviders();
    const calls = stubProviders({ [FIRST_URL]: [replyJson({ picks: [] })], [SECOND_URL]: [replyJson({ picks: [] })] });
    const { user, token } = await createUser();
    await addPlays(user.id, SONGS.slice(0, 2), 2);
    const res = await request(app).get('/api/v1/me/ai/you-may-like').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ picks: [], basedOn: [] });
    expect(calls).toHaveLength(0);
  });

  it('BE-AI-018: you-may-like sends the listening history, drops listed and repeated songs, and caches', async () => {
    await twoProviders();
    const calls = stubProviders({
      [FIRST_URL]: [
        replyJson({
          picks: [
            { title: 'Tum Hi Ho', artist: 'Arijit Singh', reason: 'Already played' },
            { title: 'Channa Mereya', artist: 'Arijit Singh', reason: 'Because you play Arijit Singh' },
            { title: 'channa mereya ', artist: 'ARIJIT SINGH' },
            { title: 'Lut Gaye', artist: 'Jubin Nautiyal', reason: null },
            { title: '', artist: 'Nobody' },
          ],
        }),
      ],
      [SECOND_URL]: [replyJson({ picks: [] })],
    });
    const { user, token } = await createUser();
    await addPlays(user.id, SONGS, 3);

    const res = await request(app).get('/api/v1/me/ai/you-may-like').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.picks).toEqual([
      { title: 'Channa Mereya', artist: 'Arijit Singh', reason: 'Because you play Arijit Singh' },
      { title: 'Lut Gaye', artist: 'Jubin Nautiyal' },
    ]);
    expect(res.body.basedOn).toEqual(['Arijit Singh', 'Jubin Nautiyal']);
    const asked = calls[0].body.messages[1].content;
    expect(asked).toContain('Tum Hi Ho — Arijit Singh (3 plays)');
    expect(asked).toContain('Most played artists: Arijit Singh, Jubin Nautiyal');

    const again = await request(app).get('/api/v1/me/ai/you-may-like').set('Authorization', `Bearer ${token}`);
    expect(again.body).toEqual(res.body);
    expect(calls).toHaveLength(1);
  });

  it('BE-AI-019: search plans are deduped, capped at 4, and cached for everyone by the request text', async () => {
    await twoProviders();
    const calls = stubProviders({
      [FIRST_URL]: [
        replyJson({
          summary: ' Sad Punjabi songs from the 2010s ',
          queries: [
            'Soch Hardy Sandhu',
            'soch hardy sandhu',
            'Qismat Ammy Virk',
            '',
            'Mann Bharrya B Praak',
            'Ik Saal Jassi Gill',
            'Extra',
          ],
        }),
      ],
      [SECOND_URL]: [replyJson({ queries: [] })],
    });
    const { token } = await createUser();
    const res = await request(app)
      .get('/api/v1/ai/search?q=Sad punjabi songs 2010s')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      summary: 'Sad Punjabi songs from the 2010s',
      queries: ['Soch Hardy Sandhu', 'Qismat Ammy Virk', 'Mann Bharrya B Praak', 'Ik Saal Jassi Gill'],
    });
    expect(calls[0].body.messages[1].content).toContain('Request: "Sad punjabi songs 2010s"');

    const other = await createUser();
    const cached = await request(app)
      .get('/api/v1/ai/search?q=  sad PUNJABI songs 2010s ')
      .set('Authorization', `Bearer ${other.token}`);
    expect(cached.body).toEqual(res.body);
    expect(calls).toHaveLength(1);

    const short = await request(app).get('/api/v1/ai/search?q=a').set('Authorization', `Bearer ${token}`);
    expect(short.status).toBe(400);
  });

  it('BE-AI-020: a playlist draft is validated, deduped, and needs 3 songs (else the next provider is asked)', async () => {
    await twoProviders();
    const calls = stubProviders({
      [FIRST_URL]: [replyJson({ name: 'Rain', picks: [{ title: 'Only One', artist: 'X' }] })],
      [SECOND_URL]: [
        replyJson({
          name: 'Rainy Evening Acoustic',
          description: 'Soft Hindi songs for a grey evening.',
          picks: [
            { title: 'Tum Se Hi', artist: 'Mohit Chauhan', reason: 'ignored' },
            { title: 'Agar Tum Saath Ho', artist: 'Alka Yagnik, Arijit Singh' },
            { title: 'Tum Se Hi', artist: 'Mohit Chauhan' },
            { title: 'Phir Le Aya Dil', artist: 'Arijit Singh' },
          ],
        }),
      ],
    });
    const { token } = await createUser();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).post('/api/v1/me/ai/playlist').set(auth).send({ prompt: 'ab' })).status).toBe(400);
    expect(
      (await request(app).post('/api/v1/me/ai/playlist').set(auth).send({ prompt: 'rain', count: 5 })).status,
    ).toBe(400);

    const res = await request(app)
      .post('/api/v1/me/ai/playlist')
      .set(auth)
      .send({ prompt: 'Rainy evening, Hindi acoustic', count: 15 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Rainy Evening Acoustic',
      description: 'Soft Hindi songs for a grey evening.',
      picks: [
        { title: 'Tum Se Hi', artist: 'Mohit Chauhan' },
        { title: 'Agar Tum Saath Ho', artist: 'Alka Yagnik, Arijit Singh' },
        { title: 'Phir Le Aya Dil', artist: 'Arijit Singh' },
      ],
    });
    expect(calls.map((c) => c.url)).toEqual([FIRST_URL, SECOND_URL]);
    expect(calls[1].body.messages[1].content).toContain('Give 15 real, released songs');
    expect(calls[1].body.max_tokens).toBe(15 * 40 + 300);
  });

  it('BE-AI-021: playlists are limited to 10 an hour per user', async () => {
    await twoProviders();
    stubProviders({
      [FIRST_URL]: [
        replyJson({ name: 'Mix', description: '', picks: [1, 2, 3].map((n) => ({ title: `Song ${n}`, artist: 'A' })) }),
      ],
      [SECOND_URL]: [failure(500, 'unused')],
    });
    const { token } = await createUser();
    const send = () =>
      request(app).post('/api/v1/me/ai/playlist').set('Authorization', `Bearer ${token}`).send({ prompt: 'road trip' });
    for (let n = 0; n < 10; n++) expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('BE-AI-022: /ai/titles answers stored fixes at once, queues the rest, and the worker fills them in', async () => {
    await twoProviders();
    await redis.set('ai:title:known00001', JSON.stringify({ title: 'Kesariya', artist: 'Arijit Singh' }));
    const calls = stubProviders({
      [FIRST_URL]: [
        replyJson({
          fixes: [
            { id: 'messy00001', title: 'Tum Hi Ho', artist: 'Arijit Singh' },
            { id: 'notasked01', title: 'Injected', artist: 'Nobody' },
          ],
        }),
      ],
      [SECOND_URL]: [replyJson({ fixes: [] })],
    });
    const items = [
      { id: 'known00001', title: 'Kesariya | Brahmastra', artist: 'Sony Music India' },
      { id: 'messy00001', title: 'Tum Hi Ho | Aashiqui 2 | Arijit Singh', artist: 'T-Series' },
      { id: 'messy00002', title: 'Some Upload | Label', artist: 'Label' },
    ];
    const first = await request(app).post('/api/v1/ai/titles').send({ items });
    expect(first.status).toBe(200);
    expect(first.body.fixes).toEqual({ known00001: { title: 'Kesariya', artist: 'Arijit Singh' } });

    expect(await runTitleBatch()).toBe(1);
    const asked = calls[0].body.messages[1].content;
    expect(asked).toContain('"id":"messy00001"');
    expect(asked).not.toContain('known00001');

    const second = await request(app).post('/api/v1/ai/titles').send({ items });
    expect(second.body.fixes).toEqual({
      known00001: { title: 'Kesariya', artist: 'Arijit Singh' },
      messy00001: { title: 'Tum Hi Ho', artist: 'Arijit Singh' },
    });
    expect(await redis.get('ai:title:notasked01')).toBeNull();
    expect(JSON.parse((await redis.get('ai:title:messy00001'))!)).toEqual({
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh',
    });
    // messy00002 got no answer: not queued again for now.
    expect(await runTitleBatch()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('BE-AI-023: /ai/titles validates its input and never answers 503 when AI is down', async () => {
    const bad = await request(app)
      .post('/api/v1/ai/titles')
      .send({ items: [{ id: 'x', title: 'y', artist: '' }] });
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/v1/ai/titles').send({ items: [] })).status).toBe(400);

    const res = await request(app)
      .post('/api/v1/ai/titles')
      .send({ items: [{ id: 'abcdef1234', title: 'A | B', artist: 'C' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fixes: {} });
    expect(await runTitleBatch()).toBe(0);
  });

  it('BE-AI-024: a provider that answers then gets marked ok, and its latency is kept', async () => {
    const { first } = await twoProviders();
    await updateAiProvider(first.id, { status: 'unknown', latencyMs: null });
    stubProviders({ [FIRST_URL]: [replyJson({ queries: ['x y'] })], [SECOND_URL]: [replyJson({ queries: [] })] });
    const { token } = await createUser();
    await request(app).get('/api/v1/ai/search?q=anything at all').set('Authorization', `Bearer ${token}`);
    const p = getAiProvider(first.id)!;
    expect(p.status).toBe('ok');
    expect(typeof p.latencyMs).toBe('number');
    expect(p.lastOkAt).toBeInstanceOf(Date);
  });
});
