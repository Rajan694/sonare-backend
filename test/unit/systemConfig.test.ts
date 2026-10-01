import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SETTINGS,
  checkSetting,
  describeSettings,
  latestExtractorCommit,
  parseSetting,
  saveSetting,
} from '../../src/systemConfig.js';
import { db } from '../../src/db/index.js';
import { systemConfiguration } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

describe('systemConfig.ts', () => {
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-SYS-001: parseSetting normalizes and validates url values', () => {
    expect(parseSetting('piped.apiUrl', 'http://127.0.0.1:8090/')).toBe('http://127.0.0.1:8090');
    expect(parseSetting('piped.apiUrl', null)).toBeNull();
    expect(() => parseSetting('piped.apiUrl', 'not-a-url')).toThrow();
  });

  it('BE-SYS-002: parseSetting validates 40-character commit hashes', () => {
    const validCommit = 'a'.repeat(40);
    expect(parseSetting('piped.extractorCommit', validCommit)).toBe(validCommit);
    expect(() => parseSetting('piped.extractorCommit', 'shortcommit')).toThrow();
  });

  it('BE-SYS-003: describeSettings returns list of settings with current and fallback values', async () => {
    const list = await describeSettings();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(Object.keys(SETTINGS).length);
    expect(list[0]).toHaveProperty('key');
    expect(list[0]).toHaveProperty('label');
  });

  it('BE-SYS-004: saveSetting persists configuration to database', async () => {
    await saveSetting('piped.apiUrl', 'http://localhost:8091');
    const [row] = await db.select().from(systemConfiguration).where(eq(systemConfiguration.key, 'piped.apiUrl'));
    expect(row.value).toBe('http://localhost:8091');
  });

  it('BE-SYS-005: checkSetting tests piped apiUrl endpoint health', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/healthcheck', method: 'GET' }).reply(200, { ok: true });

    const warn = await checkSetting('piped.apiUrl', 'http://localhost:8090');
    expect(warn).toBeUndefined();
  });

  it('BE-SYS-006: checkSetting returns error message if piped endpoint is down', async () => {
    const client = mockAgent!.get('http://localhost:8090');
    client.intercept({ path: '/healthcheck', method: 'GET' }).reply(500, { ok: false });

    const warn = await checkSetting('piped.apiUrl', 'http://localhost:8090');
    expect(warn).toContain('500');
  });

  it('BE-SYS-007: latestExtractorCommit fetches latest commit hash from GitHub API', async () => {
    const ghClient = mockAgent!.get('https://api.github.com');
    ghClient
      .intercept({
        path: '/repos/TeamNewPipe/NewPipeExtractor/commits/dev',
        method: 'GET',
      })
      .reply(200, {
        sha: 'b'.repeat(40),
        commit: {
          message: 'Update extractor logic',
          committer: { date: '2026-09-30T12:00:00Z' },
        },
      });

    const commit = await latestExtractorCommit();
    expect(commit.sha).toBe('b'.repeat(40));
    expect(commit.message).toBe('Update extractor logic');
  });
});

describe('systemConfig.ts: deployed & extractor checks', () => {
  let mockAgent: MockAgent | null = null;
  let originalDispatcher: any;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-SYS-COV-001: checkSetting validates extractor commit existence against GitHub API', async () => {
    const sha = 'e'.repeat(40);
    const ghClient = mockAgent!.get('https://api.github.com');
    ghClient
      .intercept({ path: `/repos/TeamNewPipe/NewPipeExtractor/commits/${sha}`, method: 'GET' })
      .reply(200, { sha });

    const warn = await checkSetting('piped.extractorCommit', sha);
    expect(warn).toBeUndefined();
  });

  it('BE-SYS-COV-002: checkSetting reports 404 commit not found in repository', async () => {
    const sha = 'f'.repeat(40);
    const ghClient = mockAgent!.get('https://api.github.com');
    ghClient.intercept({ path: `/repos/TeamNewPipe/NewPipeExtractor/commits/${sha}`, method: 'GET' }).reply(404, {});

    const warn = await checkSetting('piped.extractorCommit', sha);
    expect(warn).toContain('not a commit in TeamNewPipe/NewPipeExtractor');
  });
});
