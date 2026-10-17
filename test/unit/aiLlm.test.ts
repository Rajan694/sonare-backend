import { describe, expect, it } from 'vitest';
import { backoffMs, errorMessage, parseJsonObject, requestedWaitMs } from '../../src/services/ai/llm.js';

describe('AI client helpers', () => {
  it('BE-AI-001: backoff grows 2, 5, 15, 30, 60 min and stays at 60', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000)).toEqual([2, 5, 15, 30, 60, 60]);
    expect(backoffMs(0)).toBe(2 * 60_000);
  });

  it('BE-AI-002: requestedWaitMs reads Retry-After, X-RateLimit-Reset and Google retryDelay', () => {
    const now = 1_800_000_000_000;
    expect(requestedWaitMs(new Headers({ 'Retry-After': '120' }), '', now)).toBe(120_000);
    expect(requestedWaitMs(new Headers({ 'Retry-After': new Date(now + 30_000).toUTCString() }), '', now)).toBe(30_000);
    expect(requestedWaitMs(new Headers({ 'X-RateLimit-Reset': String(now + 90_000) }), '', now)).toBe(90_000);
    const google =
      '[{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"34s"}]}}]';
    expect(requestedWaitMs(new Headers(), google, now)).toBe(34_000);
    expect(requestedWaitMs(new Headers(), '{}', now)).toBeNull();
  });

  it("BE-AI-003: errorMessage finds the provider's message in its usual shapes", () => {
    expect(errorMessage('{"error":{"message":"Rate limit exceeded"}}')).toBe('Rate limit exceeded');
    expect(errorMessage('[{"error":{"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}]')).toBe(
      'Quota exceeded',
    );
    expect(errorMessage('{"error":"No auth credentials"}')).toBe('No auth credentials');
    expect(errorMessage('Bad   Gateway\n')).toBe('Bad Gateway');
  });

  it('BE-AI-004: parseJsonObject takes the object out of fences and chatter, else null', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure! Here you go: {"picks":[{"title":"x"}]} Enjoy.')).toEqual({ picks: [{ title: 'x' }] });
    expect(parseJsonObject('no json here')).toBeNull();
    expect(parseJsonObject('{"broken": ')).toBeNull();
  });
});
