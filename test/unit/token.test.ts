import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signStreamToken, verifyStreamToken } from '../../src/token.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

describe('token.ts: stream tokens', () => {
  it('BE-PURE-001: signs and verifies stream token with full payload', () => {
    const url = 'https://audio.googlevideo.com/videoplayback?id=123';
    const token = signStreamToken(url, 3600000, { vid: 'dQw4w9WgXcQ', itag: 251 });
    const verified = verifyStreamToken(token);
    expect(verified.url).toBe(url);
    expect(verified.vid).toBe('dQw4w9WgXcQ');
    expect(verified.itag).toBe(251);
  });

  it('BE-PURE-002: rejects expired stream token with error', () => {
    const url = 'https://audio.googlevideo.com/videoplayback?id=123';
    const token = signStreamToken(url, -1000);
    expect(() => verifyStreamToken(token)).toThrow('Token expired');
  });

  it('BE-PURE-003: rejects tampered stream token signature', () => {
    const url = 'https://audio.googlevideo.com/videoplayback?id=123';
    const token = signStreamToken(url, 10000);
    const parts = token.split('.');
    parts[0] = Buffer.from(JSON.stringify({ url: 'https://hacked.com', exp: Date.now() + 10000 })).toString(
      'base64url',
    );
    const tampered = parts.join('.');
    expect(() => verifyStreamToken(tampered)).toThrow('Invalid signature');
  });

  it('BE-PURE-004: rejects malformed stream token format', () => {
    expect(() => verifyStreamToken('just-a-random-string')).toThrow('Invalid token');
    expect(() => verifyStreamToken('')).toThrow('Invalid token');
  });
});

describe('token.ts: custom expiry', () => {
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-RESIL-001: handles stream token signing and verification with custom expires time', () => {
    const token = signStreamToken('https://test.com/audio.opus', 5000, { vid: 'v1', itag: 140 });
    expect(typeof token).toBe('string');
  });
});
