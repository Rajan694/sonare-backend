import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { aiProviders, appSettings } from '../../db/schema.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

// The LLM providers the admin set up (the admin page's AI section). All of them are kept in
// memory, in the order they're tried; every change is written through to ai_providers.

export type AiProvider = typeof aiProviders.$inferSelect;
export type AiProviderStatus = 'ok' | 'down' | 'unknown';

let providers: AiProvider[] = [];

const byPosition = (a: AiProvider, b: AiProvider) =>
  a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime();

export const loadAiProviders = async (): Promise<void> => {
  providers = await db.select().from(aiProviders).orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
};

/** In failover order. */
export const listAiProviders = (): readonly AiProvider[] => providers;

export const getAiProvider = (id: string): AiProvider | undefined => providers.find((p) => p.id === id);

const usable = (p: AiProvider): boolean => p.enabled && p.apiKey.length > 0;

/** Some enabled provider with a key isn't known to be down: the apps show their AI features. */
export const aiAvailable = (): boolean => providers.some((p) => usable(p) && p.status !== 'down');

/** The providers a call may try, in order: down ones only once their retry time has come. */
export const callableAiProviders = (now = Date.now()): AiProvider[] =>
  providers.filter((p) => usable(p) && (p.status !== 'down' || (p.retryAt?.getTime() ?? 0) <= now));

/** Changes a provider in memory and in the database. A failed write is logged, not thrown. */
export const updateAiProvider = async (
  id: string,
  patch: Partial<Omit<AiProvider, 'id' | 'createdAt'>>,
): Promise<AiProvider | null> => {
  const index = providers.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const next = { ...providers[index], ...patch, updatedAt: new Date() };
  providers = providers.map((p) => (p.id === id ? next : p)).sort(byPosition);
  try {
    await db
      .update(aiProviders)
      .set({ ...patch, updatedAt: next.updatedAt })
      .where(eq(aiProviders.id, id));
  } catch (err) {
    logger.warn({ err, provider: next.name }, 'AI: could not save a provider change');
  }
  return next;
};

export interface NewAiProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled?: boolean;
}

/** Added last in the failover order. */
export const createAiProvider = async (input: NewAiProvider): Promise<AiProvider> => {
  const position = providers.reduce((max, p) => Math.max(max, p.position + 1), 0);
  const [row] = await db
    .insert(aiProviders)
    .values({ ...input, enabled: input.enabled ?? true, position })
    .returning();
  providers = [...providers, row].sort(byPosition);
  return row;
};

export const deleteAiProvider = async (id: string): Promise<boolean> => {
  const rows = await db.delete(aiProviders).where(eq(aiProviders.id, id)).returning({ id: aiProviders.id });
  providers = providers.filter((p) => p.id !== id);
  return rows.length > 0;
};

/** `ids` is every provider id in the new order. */
export const reorderAiProviders = async (ids: string[]): Promise<void> => {
  await db.transaction(async (tx) => {
    for (const [position, id] of ids.entries()) {
      await tx.update(aiProviders).set({ position, updatedAt: new Date() }).where(eq(aiProviders.id, id));
    }
  });
  await loadAiProviders();
};

interface EnvProvider {
  slug: string;
  name: string;
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
}

const envProviders = (): EnvProvider[] => [
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    apiKey: config.OPENROUTER_API_KEY,
    baseUrl: config.OPENROUTER_BASE_URL,
    model: config.OPENROUTER_MODEL,
  },
  {
    slug: 'gemini',
    name: 'Google AI Studio',
    apiKey: config.GEMINI_API_KEY,
    baseUrl: config.GEMINI_BASE_URL,
    model: config.GEMINI_MODEL,
  },
];

/**
 * Adds the providers whose keys are in the environment, once each: an app_settings marker
 * remembers it, so one the admin deleted isn't brought back by the next start.
 */
export const seedAiProvidersFromEnv = async (env: EnvProvider[] = envProviders()): Promise<void> => {
  for (const e of env) {
    if (!e.apiKey) continue;
    const marker = `ai_env_seeded_${e.slug}`;
    const [seen] = await db.select().from(appSettings).where(eq(appSettings.key, marker)).limit(1);
    if (seen) continue;
    await createAiProvider({ name: e.name, baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model });
    await db.insert(appSettings).values({ key: marker, value: new Date().toISOString() }).onConflictDoNothing();
    logger.info({ provider: e.name, model: e.model }, 'AI: added a provider from the environment');
  }
};

/** What the admin page sees: never the key, only its last four characters. */
export const aiProviderView = (p: AiProvider) => ({
  id: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  model: p.model,
  keyHint: p.apiKey.length > 8 ? `…${p.apiKey.slice(-4)}` : p.apiKey ? '…' : '',
  enabled: p.enabled,
  position: p.position,
  status: p.status as AiProviderStatus,
  lastCheckedAt: p.lastCheckedAt?.getTime() ?? null,
  lastOkAt: p.lastOkAt?.getTime() ?? null,
  lastError: p.lastError,
  retryAt: p.retryAt?.getTime() ?? null,
  latencyMs: p.latencyMs,
});

export type AiProviderView = ReturnType<typeof aiProviderView>;
