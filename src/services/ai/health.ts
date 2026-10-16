import { logger } from '../../logger.js';
import { getAiProvider, listAiProviders, type AiProvider } from './providers.js';
import { requestCompletion, settleCall } from './llm.js';

// Background checks that bring a down provider back (and notice a dead one) without waiting for
// a user. Free tiers have small daily quotas (OpenRouter's free models about 50 calls a day), so
// a provider that answers is checked only every few hours; real calls count as checks too.

/** A provider that answered is checked again after this long without any call. */
export const OK_RECHECK_MS = 3 * 3600_000;
const TICK_MS = 60_000;

export const isCheckDue = (p: AiProvider, now = Date.now()): boolean => {
  if (!p.enabled || !p.apiKey) return false;
  if (p.status === 'down') return (p.retryAt?.getTime() ?? 0) <= now;
  if (p.status === 'ok') return now - (p.lastCheckedAt?.getTime() ?? 0) > OK_RECHECK_MS;
  return true;
};

export interface CheckResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** One tiny call. Any answer counts as healthy, even an empty one (the provider is up). */
export const checkAiProvider = async (id: string): Promise<CheckResult | null> => {
  const p = getAiProvider(id);
  if (!p) return null;
  const outcome = await requestCompletion(p, {
    system: 'Reply with OK.',
    user: 'OK?',
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 15_000,
  });
  // An empty answer is fine for a check, but askAi skips it for real work. A request this small
  // being refused (400) means the setup is wrong, a model name say: down, or it'd be checked
  // again every minute.
  const settled =
    outcome.ok || outcome.down ? outcome : { ...outcome, down: true, retryAt: new Date(Date.now() + 3600_000) };
  await settleCall(p.id, settled, 'health');
  return outcome.ok ? { ok: true, ms: outcome.ms } : { ok: false, ms: outcome.ms, error: outcome.reason };
};

let running = false;

/** Checks every provider that is due, one at a time. Overlapping calls do nothing. */
export const runDueAiChecks = async (now = Date.now()): Promise<void> => {
  if (running) return;
  running = true;
  try {
    for (const p of listAiProviders()) {
      if (isCheckDue(p, now)) await checkAiProvider(p.id);
    }
  } catch (err) {
    logger.warn({ err }, 'AI: health checks failed');
  } finally {
    running = false;
  }
};

let started = false;

export const startAiHealthChecks = (): void => {
  if (started) return;
  started = true;
  void runDueAiChecks();
  setInterval(() => void runDueAiChecks(), TICK_MS).unref();
};
