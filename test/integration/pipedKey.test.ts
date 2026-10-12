import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { Piped, pipedAuthHeaders } from '../../src/upstream/piped.js';
import { signStreamToken } from '../../src/services/token.js';

// A Piped published with Tailscale Funnel sits behind a gate that wants X-Sonare-Key
// (../sonare-piped-backend/funnel.sh). The backend sends it to Piped's host only.

describe('PIPED_KEY', () => {
  const app = createApp();
  let agent: MockAgent;
  let original: Dispatcher;
  const saved = config.PIPED_KEY;

  beforeEach(() => {
    config.PIPED_KEY = 'gate-key';
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/127\.0\.0\.1/);
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    config.PIPED_KEY = saved;
    await agent.close();
    setGlobalDispatcher(original);
  });

  it("BE-PKEY-001: only Piped's host gets the key, on any port; nothing without a key", () => {
    // pipedApiUrl() is http://localhost:8090 in tests; the proxy is localhost:8091.
    expect(pipedAuthHeaders('http://localhost:8090/streams/abc')).toEqual({ 'X-Sonare-Key': 'gate-key' });
    expect(pipedAuthHeaders('http://localhost:8091/videoplayback?id=1')).toEqual({ 'X-Sonare-Key': 'gate-key' });
    expect(pipedAuthHeaders('https://rr1---sn-abc.googlevideo.com/videoplayback')).toEqual({});
    expect(pipedAuthHeaders('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toEqual({});
    expect(pipedAuthHeaders('not a url')).toEqual({});
    // The admin page's "test this URL" checks a candidate Piped: it is the base there.
    expect(pipedAuthHeaders('https://pc.tail1.ts.net/healthcheck', 'https://pc.tail1.ts.net')).toEqual({
      'X-Sonare-Key': 'gate-key',
    });
    config.PIPED_KEY = undefined;
    expect(pipedAuthHeaders('http://localhost:8090/streams/abc')).toEqual({});
  });

  it('BE-PKEY-002: API calls to Piped carry the key', async () => {
    let key: unknown;
    agent
      .get('http://localhost:8090')
      .intercept({ path: '/suggestions?query=tum', method: 'GET' })
      .reply(200, (opts) => {
        key = (opts.headers as Record<string, string>)['X-Sonare-Key'];
        return ['tum hi ho'];
      });
    expect(await Piped.suggestions('tum')).toEqual(['tum hi ho']);
    expect(key).toBe('gate-key');
  });

  it('BE-PKEY-003: the stream relay sends the key to the Piped proxy and not to googlevideo', async () => {
    const seen: Record<string, unknown> = {};
    agent
      .get('http://localhost:8091')
      .intercept({ path: '/videoplayback?id=1', method: 'GET' })
      .reply(
        206,
        (opts) => {
          seen.proxy = (opts.headers as Record<string, string>)['X-Sonare-Key'];
          return 'abcd';
        },
        { headers: { 'content-range': 'bytes 0-3/4', 'content-type': 'audio/webm' } },
      );
    agent
      .get('https://rr1---sn-abc.googlevideo.com')
      .intercept({ path: '/videoplayback?id=2', method: 'GET' })
      .reply(
        206,
        (opts) => {
          seen.google = (opts.headers as Record<string, string>)['X-Sonare-Key'];
          return 'efgh';
        },
        { headers: { 'content-range': 'bytes 0-3/4', 'content-type': 'audio/webm' } },
      );

    const viaProxy = await request(app)
      .get(`/api/v1/stream/${signStreamToken('http://localhost:8091/videoplayback?id=1')}`)
      .set('Range', 'bytes=0-3');
    expect(viaProxy.status).toBe(206);
    expect(seen.proxy).toBe('gate-key');

    const direct = await request(app)
      .get(`/api/v1/stream/${signStreamToken('https://rr1---sn-abc.googlevideo.com/videoplayback?id=2')}`)
      .set('Range', 'bytes=0-3');
    expect(direct.status).toBe(206);
    expect(seen.google).toBeUndefined();
  });
});
