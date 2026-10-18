import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminUser, createUser } from '../factories.js';
import { getAiProvider, listAiProviders } from '../../src/services/ai/providers.js';
import { recordAiUsage } from '../../src/services/ai/usage.js';
import { FIRST_URL, SECOND_URL, failure, reply, resetAi, stubProviders } from '../aiFakes.js';

const app = createApp();

/** The check a create or change starts runs in the background; wait for it. */
const settled = async (id: string) => {
  for (let i = 0; i < 50 && getAiProvider(id)?.status === 'unknown'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Admin: AI providers', () => {
  let auth: { Authorization: string };

  beforeEach(async () => {
    await resetAi();
    const { token } = await createAdminUser();
    auth = { Authorization: `Bearer ${token}` };
  });
  afterAll(resetAi);

  const add = (body: Record<string, unknown>) => request(app).post('/api/v1/admin/ai/providers').set(auth).send(body);

  it('BE-AI-025: the AI admin routes need an admin token, not a user one', async () => {
    expect((await request(app).get('/api/v1/admin/ai/providers')).status).toBe(401);
    const { token } = await createUser();
    const asUser = await request(app).get('/api/v1/admin/ai/providers').set('Authorization', `Bearer ${token}`);
    expect(asUser.status).toBe(401);
    expect((await request(app).get('/api/v1/admin/analytics/ai')).status).toBe(401);
  });

  it('BE-AI-026: adding a provider never returns its key, and checks it right away', async () => {
    const calls = stubProviders({ [FIRST_URL]: [reply('OK')] });
    const res = await add({
      name: 'OpenRouter',
      baseUrl: FIRST_URL,
      apiKey: 'sk-or-v1-abcdef123456',
      model: 'openrouter/free',
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('sk-or-v1');
    expect(res.body).toMatchObject({
      name: 'OpenRouter',
      keyHint: '…3456',
      enabled: true,
      position: 0,
      status: 'unknown',
    });

    await settled(res.body.id);
    expect(calls).toHaveLength(1);
    const list = await request(app).get('/api/v1/admin/ai/providers').set(auth);
    expect(list.body.available).toBe(true);
    expect(list.body.providers[0]).toMatchObject({ status: 'ok', lastError: null });
    expect(typeof list.body.providers[0].lastCheckedAt).toBe('number');
    expect(JSON.stringify(list.body)).not.toContain('sk-or-v1');
  });

  it('BE-AI-027: adding validates the fields', async () => {
    const res = await add({ name: '', baseUrl: 'ftp://x', apiKey: '', model: 'm' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(listAiProviders()).toHaveLength(0);
  });

  it('BE-AI-028: editing a name keeps the key and status; a new key resets it to unknown and re-checks', async () => {
    stubProviders({ [FIRST_URL]: [reply('OK'), failure(401, 'Invalid API key')] });
    const { body } = await add({ name: 'A', baseUrl: FIRST_URL, apiKey: 'sk-old-key-0001', model: 'm' });
    await settled(body.id);

    const renamed = await request(app)
      .patch(`/api/v1/admin/ai/providers/${body.id}`)
      .set(auth)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', keyHint: '…0001', status: 'ok' });

    const rekeyed = await request(app)
      .patch(`/api/v1/admin/ai/providers/${body.id}`)
      .set(auth)
      .send({ apiKey: 'sk-new-key-0002' });
    expect(rekeyed.body).toMatchObject({ keyHint: '…0002', status: 'unknown' });
    await settled(body.id);
    expect(getAiProvider(body.id)).toMatchObject({ status: 'down', apiKey: 'sk-new-key-0002' });

    const empty = await request(app).patch(`/api/v1/admin/ai/providers/${body.id}`).set(auth).send({});
    expect(empty.status).toBe(400);
  });

  it('BE-AI-029: disabling hides AI when it was the only provider; enabling checks it again', async () => {
    const calls = stubProviders({ [FIRST_URL]: [reply('OK')] });
    const { body } = await add({ name: 'A', baseUrl: FIRST_URL, apiKey: 'sk-0123456789', model: 'm' });
    await settled(body.id);
    const off = await request(app).patch(`/api/v1/admin/ai/providers/${body.id}`).set(auth).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    expect((await request(app).get('/api/v1/app-config')).body.ai).toBe(false);

    const on = await request(app).patch(`/api/v1/admin/ai/providers/${body.id}`).set(auth).send({ enabled: true });
    expect(on.body.status).toBe('unknown');
    await settled(body.id);
    expect(calls).toHaveLength(2);
    expect((await request(app).get('/api/v1/app-config')).body.ai).toBe(true);
  });

  it('BE-AI-030: Check now reports the result and the provider; unknown ids are 404', async () => {
    stubProviders({ [FIRST_URL]: [reply('OK'), failure(429, 'Quota exceeded for today')] });
    const { body } = await add({ name: 'A', baseUrl: FIRST_URL, apiKey: 'sk-0123456789', model: 'm' });
    await settled(body.id);
    const check = await request(app).post(`/api/v1/admin/ai/providers/${body.id}/check`).set(auth);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      ok: false,
      error: '429 Quota exceeded for today',
      provider: { status: 'down' },
    });
    expect(typeof check.body.ms).toBe('number');
    expect(check.body.provider.retryAt).toBeGreaterThan(Date.now());

    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await request(app).post(`/api/v1/admin/ai/providers/${missing}/check`).set(auth)).status).toBe(404);
    expect(
      (await request(app).patch(`/api/v1/admin/ai/providers/${missing}`).set(auth).send({ name: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/v1/admin/ai/providers/${missing}`).set(auth)).status).toBe(404);
  });

  it('BE-AI-031: providers are reordered with every id once, and deleted', async () => {
    stubProviders({ [FIRST_URL]: [reply('OK')], [SECOND_URL]: [reply('OK')] });
    const a = (await add({ name: 'A', baseUrl: FIRST_URL, apiKey: 'sk-0123456789', model: 'm' })).body;
    const b = (await add({ name: 'B', baseUrl: SECOND_URL, apiKey: 'sk-9876543210', model: 'm' })).body;
    expect(b.position).toBe(1);

    const partial = await request(app)
      .put('/api/v1/admin/ai/providers/order')
      .set(auth)
      .send({ ids: [b.id] });
    expect(partial.status).toBe(400);
    const twice = await request(app)
      .put('/api/v1/admin/ai/providers/order')
      .set(auth)
      .send({ ids: [b.id, b.id] });
    expect(twice.status).toBe(400);

    const ordered = await request(app)
      .put('/api/v1/admin/ai/providers/order')
      .set(auth)
      .send({ ids: [b.id, a.id] });
    expect(ordered.status).toBe(200);
    expect(ordered.body.providers.map((p: { name: string }) => p.name)).toEqual(['B', 'A']);
    expect(listAiProviders().map((p) => p.name)).toEqual(['B', 'A']);

    expect((await request(app).delete(`/api/v1/admin/ai/providers/${b.id}`).set(auth)).body).toEqual({ ok: true });
    const list = await request(app).get('/api/v1/admin/ai/providers').set(auth);
    expect(list.body.providers.map((p: { name: string }) => p.name)).toEqual(['A']);
  });

  it('BE-AI-032: /admin/analytics/ai sums calls and tokens by provider, feature and day', async () => {
    const today = new Date();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const p1 = '11111111-1111-1111-1111-111111111111';
    const p2 = '22222222-2222-2222-2222-222222222222';
    await recordAiUsage(
      {
        providerId: p1,
        providerName: 'Old name',
        feature: 'titles',
        ok: true,
        promptTokens: 100,
        completionTokens: 50,
      },
      twoDaysAgo,
    );
    await recordAiUsage(
      {
        providerId: p1,
        providerName: 'OpenRouter',
        feature: 'titles',
        ok: true,
        promptTokens: 300,
        completionTokens: 150,
      },
      today,
    );
    await recordAiUsage({ providerId: p1, providerName: 'OpenRouter', feature: 'search', ok: false }, today);
    await recordAiUsage(
      { providerId: p2, providerName: 'Gemini', feature: 'health', ok: true, promptTokens: 5, completionTokens: 1 },
      today,
    );

    const res = await request(app).get('/api/v1/admin/analytics/ai?days=7').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.totals).toEqual({ calls: 4, failures: 1, promptTokens: 405, completionTokens: 201 });
    expect(res.body.byProvider).toEqual([
      { providerId: p1, name: 'OpenRouter', calls: 3, failures: 1, promptTokens: 400, completionTokens: 200 },
      { providerId: p2, name: 'Gemini', calls: 1, failures: 0, promptTokens: 5, completionTokens: 1 },
    ]);
    expect(res.body.byFeature.map((f: { feature: string }) => f.feature)).toEqual(['titles', 'health', 'search']);
    expect(res.body.series).toHaveLength(7);
    expect(res.body.series[6]).toEqual({
      day: today.toISOString().slice(0, 10),
      calls: 3,
      failures: 1,
      promptTokens: 305,
      completionTokens: 151,
    });
    expect(res.body.series[4]).toMatchObject({
      day: twoDaysAgo.toISOString().slice(0, 10),
      calls: 1,
      promptTokens: 100,
    });
    expect(res.body.series[0]).toMatchObject({ calls: 0, promptTokens: 0 });

    const one = await request(app).get('/api/v1/admin/analytics/ai?days=1').set(auth);
    expect(one.body.totals.calls).toBe(3);
    const clamped = await request(app).get('/api/v1/admin/analytics/ai?days=500').set(auth);
    expect(clamped.body.series).toHaveLength(90);
  });
});
