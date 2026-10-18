import { vi } from 'vitest';
import { db } from '../src/db/index.js';
import { aiProviders, aiUsageDaily } from '../src/db/schema.js';
import { createAiProvider, loadAiProviders, updateAiProvider } from '../src/services/ai/providers.js';

// Fake LLM providers for the AI tests: fetch is stubbed per provider URL, nothing leaves the machine.

export interface FakeCall {
  url: string;
  body: { model: string; messages: { role: string; content: string }[]; max_tokens: number };
  headers: Record<string, string>;
}

export type FakeReply = Response | (() => Response) | ((call: FakeCall) => Response);

/** A chat-completions answer. */
export const reply = (content: string, usage = { prompt_tokens: 12, completion_tokens: 7 }): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

export const replyJson = (value: unknown) => reply(JSON.stringify(value));

export const failure = (status: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });

/**
 * Stubs fetch: each provider URL answers from its queue (the last entry repeats). Returns the
 * calls made, in order.
 */
export const stubProviders = (replies: Record<string, FakeReply[]>) => {
  const calls: FakeCall[] = [];
  const queues = new Map(Object.entries(replies).map(([url, list]) => [url, [...list]]));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const queue = queues.get(url);
    if (!queue) throw new Error(`unexpected fetch ${url}`);
    const call: FakeCall = {
      url,
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return typeof next === 'function' ? next(call) : next.clone();
  });
  return calls;
};

export const FIRST_URL = 'https://first.example/v1/chat/completions';
export const SECOND_URL = 'https://second.example/v1/chat/completions';

/** Empties the AI tables and the in-memory provider list. */
export const resetAi = async () => {
  vi.restoreAllMocks();
  await db.delete(aiProviders);
  await db.delete(aiUsageDaily);
  await loadAiProviders();
};

/** Two answering providers, in this order. */
export const twoProviders = async () => {
  const first = await createAiProvider({ name: 'First', baseUrl: FIRST_URL, apiKey: 'sk-first-0000aaaa', model: 'm1' });
  const second = await createAiProvider({
    name: 'Second',
    baseUrl: SECOND_URL,
    apiKey: 'sk-second-1111bbbb',
    model: 'm2',
  });
  await updateAiProvider(first.id, { status: 'ok' });
  await updateAiProvider(second.id, { status: 'ok' });
  return { first, second };
};
