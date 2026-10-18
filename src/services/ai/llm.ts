import type { z } from 'zod';
import { config } from '../../config.js';
import { AiUnavailableError, describeError } from '../../errors.js';
import { logger } from '../../logger.js';
import { callableAiProviders, getAiProvider, updateAiProvider, type AiProvider } from './providers.js';
import { recordAiUsage, type AiFeature } from './usage.js';

// One OpenAI-compatible chat-completions client for every provider, with failover: providers are
// tried in the admin's order, and one that fails for a reason of its own (rate limit, used-up
// quota, bad key, outage) is marked down and skipped until its retry time.

export interface AiPrompt {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export type CallOutcome =
  | { ok: true; text: string; ms: number; promptTokens: number; completionTokens: number }
  /** `down`: the provider itself failed. Otherwise the request or the answer was unusable. */
  | { ok: false; down: boolean; reason: string; ms: number; retryAt?: Date };

/** Minutes to wait after 1, 2, 3 ... failures in a row. */
const BACKOFF_MIN = [2, 5, 15, 30, 60];
const HOUR_MS = 3600_000;
const MAX_WAIT_MS = 24 * HOUR_MS;

export const backoffMs = (failures: number): number =>
  BACKOFF_MIN[Math.min(Math.max(failures, 1), BACKOFF_MIN.length) - 1] * 60_000;

/**
 * How long a 429 asks us to wait: Retry-After (seconds or a date), OpenRouter's
 * X-RateLimit-Reset (ms since the epoch), or Google's RetryInfo `retryDelay: "34s"` in the body.
 */
export const requestedWaitMs = (headers: Headers, body: string, now = Date.now()): number | null => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) return sec * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return at - now;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset > 1e11 ? reset - now : reset * 1000 - now;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (delay) return Number(delay[1]) * 1000;
  return null;
};

/** The provider's own error text, from `{ error: { message } }` or Google's `[{ error: ... }]`. */
export const errorMessage = (body: string): string => {
  try {
    const json = JSON.parse(body) as unknown;
    const obj = (Array.isArray(json) ? json[0] : json) as { error?: { message?: unknown } | string } | null;
    const err = obj?.error;
    if (typeof err === 'string') return err;
    if (typeof err?.message === 'string') return err.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.replace(/\s+/g, ' ').trim();
};

const short = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** Message content as text: a string, or the text parts some providers send as an array. */
const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
};

/** One request to one provider. Never throws. */
export const requestCompletion = async (p: AiProvider, prompt: AiPrompt): Promise<CallOutcome> => {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${p.apiKey}`,
    'Content-Type': 'application/json',
  };
  try {
    // OpenRouter lists apps by these; other providers ignore them.
    if (new URL(p.baseUrl).hostname.endsWith('openrouter.ai')) {
      headers['HTTP-Referer'] = config.APP_URL;
      headers['X-Title'] = 'Sonare';
    }
  } catch {
    return {
      ok: false,
      down: true,
      reason: 'The provider URL is not valid',
      ms: 0,
      retryAt: new Date(Date.now() + HOUR_MS),
    };
  }

  let res: Response;
  try {
    res = await fetch(p.baseUrl, {
      method: 'POST',
      headers,
      // No response_format: not every free model supports it; the prompts ask for JSON instead.
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: prompt.temperature ?? 0.7,
        max_tokens: prompt.maxTokens,
      }),
      signal: AbortSignal.timeout(prompt.timeoutMs ?? 25_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    const reason = timedOut ? `No answer in ${Math.round((prompt.timeoutMs ?? 25_000) / 1000)} s` : describeError(err);
    return { ok: false, down: true, reason: short(reason), ms: elapsed() };
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    const reason = short(`${res.status} ${errorMessage(body) || res.statusText}`);
    const now = Date.now();
    if (res.status === 429) {
      const wait = requestedWaitMs(res.headers, body, now);
      return {
        ok: false,
        down: true,
        reason,
        ms: elapsed(),
        retryAt: wait && wait > 0 ? new Date(now + wait) : undefined,
      };
    }
    if ([401, 402, 403, 404].includes(res.status)) {
      return { ok: false, down: true, reason, ms: elapsed(), retryAt: new Date(now + HOUR_MS) };
    }
    if (res.status >= 500) return { ok: false, down: true, reason, ms: elapsed() };
    // 400 and the like: this request was refused, not the provider broken.
    return { ok: false, down: false, reason, ms: elapsed() };
  }

  try {
    const json = JSON.parse(body) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      ok: true,
      text: contentText(json.choices?.[0]?.message?.content).trim(),
      ms: elapsed(),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  } catch {
    return { ok: false, down: false, reason: 'The answer was not JSON', ms: elapsed() };
  }
};

/** Records what a call found: the provider's state, and a usage row. */
export const settleCall = async (id: string, outcome: CallOutcome, feature: AiFeature): Promise<void> => {
  const p = getAiProvider(id);
  if (!p) return;
  const now = new Date();
  await recordAiUsage({
    providerId: p.id,
    providerName: p.name,
    feature,
    ok: outcome.ok,
    promptTokens: outcome.ok ? outcome.promptTokens : 0,
    completionTokens: outcome.ok ? outcome.completionTokens : 0,
  });

  if (outcome.ok) {
    if (p.status !== 'ok') logger.info({ provider: p.name }, 'AI: provider is answering');
    await updateAiProvider(p.id, {
      status: 'ok',
      failures: 0,
      lastError: null,
      retryAt: null,
      lastCheckedAt: now,
      lastOkAt: now,
      latencyMs: outcome.ms,
    });
    return;
  }
  if (!outcome.down) {
    await updateAiProvider(p.id, { lastError: outcome.reason, lastCheckedAt: now });
    return;
  }
  const failures = p.failures + 1;
  // Its own wait when it said one (capped at a day), never shorter than the backoff.
  const wait = Math.min(MAX_WAIT_MS, Math.max(backoffMs(failures), (outcome.retryAt?.getTime() ?? 0) - now.getTime()));
  const retryAt = new Date(now.getTime() + wait);
  if (p.status !== 'down') logger.warn({ provider: p.name, reason: outcome.reason, retryAt }, 'AI: provider is down');
  await updateAiProvider(p.id, { status: 'down', failures, lastError: outcome.reason, retryAt, lastCheckedAt: now });
};

/**
 * Asks the providers in turn until one gives an answer `accept` takes (it returns null for an
 * answer it can't use, and the next provider is asked). None did: AiUnavailableError.
 */
export const askAi = async <T>(
  feature: AiFeature,
  prompt: AiPrompt,
  accept: (text: string) => T | null,
): Promise<T> => {
  for (const p of callableAiProviders()) {
    const outcome = await requestCompletion(p, prompt);
    await settleCall(p.id, outcome, feature);
    if (!outcome.ok || !outcome.text) continue;
    const value = accept(outcome.text);
    if (value !== null) return value;
    logger.warn({ provider: p.name, feature }, "AI: the answer wasn't in the shape asked for");
  }
  throw new AiUnavailableError();
};

/** The JSON object in an answer (fences and chatter around it are dropped), or null. */
export const parseJsonObject = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** askAi for a JSON answer checked by `schema`, then `refine`d (null = unusable). */
export const askAiJson = <S extends z.ZodTypeAny, T = z.infer<S>>(
  feature: AiFeature,
  prompt: AiPrompt,
  schema: S,
  refine: (value: z.infer<S>) => T | null = (v) => v as T,
): Promise<T> =>
  askAi(feature, prompt, (text) => {
    const parsed = schema.safeParse(parseJsonObject(text));
    return parsed.success ? refine(parsed.data) : null;
  });
