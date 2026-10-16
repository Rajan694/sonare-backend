import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { aiProviders, aiUsageDaily, appSettings } from '../../src/db/schema.js';
import {
  aiAvailable,
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  loadAiProviders,
  seedAiProvidersFromEnv,
  updateAiProvider,
} from '../../src/services/ai/providers.js';
import { askAi } from '../../src/services/ai/llm.js';
import { checkAiProvider, isCheckDue, OK_RECHECK_MS, runDueAiChecks } from '../../src/services/ai/health.js';
import { AiUnavailableError } from '../../src/errors.js';
import { FIRST_URL, SECOND_URL, failure, reply, resetAi, stubProviders, twoProviders } from '../aiFakes.js';

const prompt = { system: 's', user: 'u', maxTokens: 50 };
const keep = (text: string) => text;

describe('AI providers and failover', () => {
  beforeEach(async () => {
    await resetAi();
    await db.delete(appSettings);
  });
  afterAll(resetAi);

  it('BE-AI-005: providers from the environment are added once; one deleted stays deleted', async () => {
    const env = [
      {
        slug: 'openrouter',
        name: 'OpenRouter',
        apiKey: 'sk-or-123456789',
        baseUrl: FIRST_URL,
        model: 'openrouter/free',
      },
      { slug: 'gemini', name: 'Google AI Studio', apiKey: undefined, baseUrl: SECOND_URL, model: 'g' },
    ];
    await seedAiProvidersFromEnv(env);
    await seedAiProvidersFromEnv(env);
    expect(listAiProviders().map((p) => p.name)).toEqual(['OpenRouter']);

    await deleteAiProvider(listAiProviders()[0].id);
    await seedAiProvidersFromEnv(env);
    await loadAiProviders();
    expect(listAiProviders()).toHaveLength(0);
    const [marker] = await db.select().from(appSettings).where(eq(appSettings.key, 'ai_env_seeded_openrouter'));
    expect(marker).toBeDefined();
  });

  it('BE-AI-006: a 429 marks the first provider down until its Retry-After, and the second answers', async () => {
    const { first, second } = await twoProviders();
    const calls = stubProviders({
      [FIRST_URL]: [failure(429, 'Rate limit exceeded: free-models-per-day', { 'Retry-After': '7200' })],
      [SECOND_URL]: [reply('hello')],
    });

    const before = Date.now();
    expect(await askAi('search', prompt, keep)).toBe('hello');
    expect(calls.map((c) => c.url)).toEqual([FIRST_URL, SECOND_URL]);
    expect(calls[1].body).toMatchObject({ model: 'm2', max_tokens: 50 });
    expect(calls[1].headers.Authorization).toBe('Bearer sk-second-1111bbbb');

    const down = getAiProvider(first.id)!;
    expect(down.status).toBe('down');
    expect(down.failures).toBe(1);
    expect(down.lastError).toBe('429 Rate limit exceeded: free-models-per-day');
    expect(down.retryAt!.getTime()).toBeGreaterThanOrEqual(before + 7200_000);
    expect(getAiProvider(second.id)).toMatchObject({ status: 'ok', failures: 0, lastError: null });

    // Saved, not only in memory.
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, first.id));
    expect(row.status).toBe('down');

    // While down it isn't asked.
    expect(await askAi('search', prompt, keep)).toBe('hello');
    expect(calls.map((c) => c.url)).toEqual([FIRST_URL, SECOND_URL, SECOND_URL]);
  });

  it('BE-AI-007: a rejected key is down for an hour; a 400 or an unusable answer moves on without marking down', async () => {
    const { first, second } = await twoProviders();
    stubProviders({ [FIRST_URL]: [failure(401, 'Invalid API key')], [SECOND_URL]: [reply('ok')] });
    await askAi('search', prompt, keep);
    const down = getAiProvider(first.id)!;
    expect(down.status).toBe('down');
    expect(down.retryAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);

    await updateAiProvider(first.id, { status: 'ok', failures: 0, retryAt: null });
    stubProviders({ [FIRST_URL]: [failure(400, 'max_tokens too large')], [SECOND_URL]: [reply('ok')] });
    await askAi('search', prompt, keep);
    expect(getAiProvider(first.id)).toMatchObject({ status: 'ok', lastError: '400 max_tokens too large' });

    stubProviders({ [FIRST_URL]: [reply('not what was asked')], [SECOND_URL]: [reply('{"good":true}')] });
    const value = await askAi('search', prompt, (t) => (t.startsWith('{') ? t : null));
    expect(value).toBe('{"good":true}');
    expect(getAiProvider(first.id)!.status).toBe('ok');
    expect(getAiProvider(second.id)!.status).toBe('ok');
  });

  it('BE-AI-008: an answer brings a down provider back; the backoff grows with each failure', async () => {
    const { first } = await twoProviders();
    await updateAiProvider(first.id, { status: 'down', failures: 2, retryAt: new Date(Date.now() - 1000) });
    stubProviders({ [FIRST_URL]: [reply('back')], [SECOND_URL]: [reply('unused')] });
    expect(await askAi('search', prompt, keep)).toBe('back');
    expect(getAiProvider(first.id)).toMatchObject({ status: 'ok', failures: 0, retryAt: null });

    await updateAiProvider(first.id, { failures: 2 });
    stubProviders({ [FIRST_URL]: [failure(503, 'overloaded')], [SECOND_URL]: [reply('x')] });
    await askAi('search', prompt, keep);
    const p = getAiProvider(first.id)!;
    expect(p.failures).toBe(3);
    const wait = p.retryAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
  });

  it('BE-AI-009: none answering, none set up, or all disabled: AiUnavailableError', async () => {
    await expect(askAi('search', prompt, keep)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(aiAvailable()).toBe(false);

    const { first, second } = await twoProviders();
    expect(aiAvailable()).toBe(true);
    stubProviders({ [FIRST_URL]: [failure(500, 'boom')], [SECOND_URL]: [new Response('nope', { status: 502 })] });
    await expect(askAi('search', prompt, keep)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(aiAvailable()).toBe(false);

    await updateAiProvider(first.id, { status: 'ok', enabled: false });
    await updateAiProvider(second.id, { status: 'ok', enabled: false });
    expect(aiAvailable()).toBe(false);
  });

  it('BE-AI-010: GET /app-config says whether AI is available', async () => {
    const app = createApp();
    expect((await request(app).get('/api/v1/app-config')).body.ai).toBe(false);
    await twoProviders();
    expect((await request(app).get('/api/v1/app-config')).body.ai).toBe(true);
  });

  it('BE-AI-011: every call is counted per day, provider and feature, with its tokens', async () => {
    const { first, second } = await twoProviders();
    stubProviders({
      [FIRST_URL]: [failure(429, 'slow down')],
      [SECOND_URL]: [reply('a', { prompt_tokens: 100, completion_tokens: 40 })],
    });
    await askAi('playlist', prompt, keep);
    await askAi('playlist', prompt, keep);
    const rows = await db.select().from(aiUsageDaily);
    const byProvider = Object.fromEntries(rows.map((r) => [r.providerId, r]));
    expect(byProvider[first.id]).toMatchObject({
      providerName: 'First',
      feature: 'playlist',
      calls: 1,
      failures: 1,
      promptTokens: 0,
    });
    expect(byProvider[second.id]).toMatchObject({
      feature: 'playlist',
      calls: 2,
      failures: 0,
      promptTokens: 200,
      completionTokens: 80,
      day: new Date().toISOString().slice(0, 10),
    });
  });
});

describe('AI health checks', () => {
  beforeEach(resetAi);
  afterAll(resetAi);

  it('BE-AI-012: isCheckDue: unknown, down past its retry, and ok-but-stale are due; disabled never', async () => {
    const p = await createAiProvider({ name: 'P', baseUrl: FIRST_URL, apiKey: 'sk-0123456789', model: 'm' });
    const now = Date.now();
    expect(isCheckDue(p, now)).toBe(true);
    expect(isCheckDue({ ...p, status: 'down', retryAt: new Date(now + 60_000) }, now)).toBe(false);
    expect(isCheckDue({ ...p, status: 'down', retryAt: new Date(now - 1) }, now)).toBe(true);
    expect(isCheckDue({ ...p, status: 'ok', lastCheckedAt: new Date(now - 60_000) }, now)).toBe(false);
    expect(isCheckDue({ ...p, status: 'ok', lastCheckedAt: new Date(now - OK_RECHECK_MS - 1) }, now)).toBe(true);
    expect(isCheckDue({ ...p, enabled: false }, now)).toBe(false);
    expect(isCheckDue({ ...p, apiKey: '' }, now)).toBe(false);
  });

  it('BE-AI-013: runDueAiChecks checks only the due ones and counts them as health usage', async () => {
    const { first, second } = await twoProviders();
    await updateAiProvider(first.id, { status: 'unknown' });
    await updateAiProvider(second.id, { status: 'ok', lastCheckedAt: new Date() });
    const calls = stubProviders({ [FIRST_URL]: [reply('')], [SECOND_URL]: [reply('OK')] });
    await runDueAiChecks();
    expect(calls.map((c) => c.url)).toEqual([FIRST_URL]);
    expect(calls[0].body.max_tokens).toBe(16);
    // An empty answer still means it's up.
    expect(getAiProvider(first.id)!.status).toBe('ok');
    const [usage] = await db.select().from(aiUsageDaily);
    expect(usage).toMatchObject({ feature: 'health', calls: 1, failures: 0 });
  });

  it('BE-AI-014: a check refused with 400 (a wrong model, say) marks the provider down for an hour', async () => {
    const p = await createAiProvider({ name: 'P', baseUrl: FIRST_URL, apiKey: 'sk-0123456789', model: 'nope' });
    stubProviders({ [FIRST_URL]: [failure(400, 'model nope is not a valid model ID')] });
    const result = await checkAiProvider(p.id);
    expect(result).toMatchObject({ ok: false, error: '400 model nope is not a valid model ID' });
    const after = getAiProvider(p.id)!;
    expect(after.status).toBe('down');
    expect(after.retryAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(await checkAiProvider('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
