import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db/index.js';
import { systemConfiguration } from './db/schema.js';

/**
 * System-wide settings from the `system_configuration` table, edited on the admin page.
 *
 * Two kinds: `live` settings are read by the backend on every use, so a save takes effect
 * straight away. `deploy` settings belong to the Piped stack; `sonare-piped-backend/syncAdminConfig.sh`
 * copies them into build.gradle / config.properties on the next `./runPiped.sh up`.
 */

const PIPED_DIR = process.env.PIPED_BACKEND_DIR || fileURLToPath(new URL('../../sonare-piped-backend/', import.meta.url));
const EXTRACTOR_REPO = 'TeamNewPipe/NewPipeExtractor';

const httpUrl = z.string().trim().url().refine(u => /^https?:\/\//.test(u), 'Must be an http(s) URL')
  .transform(u => u.replace(/\/+$/, ''));

interface SettingDef {
  label: string;
  applies: 'live' | 'deploy';
  schema: z.ZodType<string>;
  /** What is used when the stored value is null. */
  fallback: () => string | undefined;
  fallbackSource: string;
  /** For deploy settings: what the Piped files hold right now. */
  deployed?: () => Promise<string | undefined>;
  /** Checks a new value against the outside world; returns why it looks wrong, if it does. */
  check?: (value: string) => Promise<string | undefined>;
}

async function readPipedFile(name: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(PIPED_DIR, name), 'utf8');
  } catch {
    return undefined;
  }
}

export const SETTINGS: Record<string, SettingDef> = {
  'piped.apiUrl': {
    label: 'Piped API URL',
    applies: 'live',
    schema: httpUrl,
    fallback: () => config.PIPED_API_URL,
    fallbackSource: 'PIPED_API_URL in .env',
    check: pipedAnswers,
  },
  'piped.proxyUrl': {
    label: 'Piped proxy URL',
    applies: 'deploy',
    schema: httpUrl,
    fallback: () => undefined,
    fallbackSource: 'PROXY_PART in config.properties',
    deployed: async () => (await readPipedFile('config.properties'))?.match(/^PROXY_PART:\s*(\S+)/m)?.[1],
  },
  'piped.extractorCommit': {
    label: 'NewPipeExtractor commit',
    applies: 'deploy',
    schema: z.string().trim().toLowerCase().regex(/^[0-9a-f]{40}$/, 'Must be a full 40-character commit hash'),
    fallback: () => undefined,
    fallbackSource: 'build.gradle',
    deployed: async () => (await readPipedFile('build.gradle'))?.match(/NewPipeExtractor:([0-9a-f]{7,40})/)?.[1],
    check: extractorCommitExists,
  },
};

async function pipedAnswers(baseUrl: string): Promise<string | undefined> {
  try {
    const { statusCode, body } = await request(new URL('/healthcheck', baseUrl), {
      headers: { 'User-Agent': 'Sonare/1.0' },
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    await body.dump();
    if (statusCode < 200 || statusCode >= 300) return `Piped at ${baseUrl} answered /healthcheck with HTTP ${statusCode}`;
  } catch (e: any) {
    return `Nothing answered at ${baseUrl} (${e.code || e.message})`;
  }
}

// JitPack builds NewPipeExtractor from GitHub by commit, so a hash GitHub doesn't know would
// only fail later, in the middle of the Piped image build.
async function extractorCommitExists(sha: string): Promise<string | undefined> {
  try {
    const { statusCode, body } = await request(`https://api.github.com/repos/${EXTRACTOR_REPO}/commits/${sha}`, {
      headers: { 'User-Agent': 'Sonare/1.0', Accept: 'application/vnd.github+json' },
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    await body.dump();
    if (statusCode === 404 || statusCode === 422) return `${sha} is not a commit in ${EXTRACTOR_REPO}`;
    if (statusCode !== 200) return `Could not check the commit on GitHub (HTTP ${statusCode})`;
  } catch (e: any) {
    return `Could not reach GitHub to check the commit (${e.code || e.message})`;
  }
}

/** Runs the setting's check, if it has one. Returns why the value looks wrong, if it does. */
export async function checkSetting(key: string, value: string): Promise<string | undefined> {
  return SETTINGS[key]?.check?.(value);
}

const values = new Map<string, unknown>();

/** Loads every setting into memory. Called at startup and after each save. */
export async function loadSystemConfig() {
  const rows = await db.select().from(systemConfiguration);
  values.clear();
  for (const row of rows) values.set(row.key, row.value);
}

function stored(key: string): string | undefined {
  const v = values.get(key);
  return typeof v === 'string' && v ? v : undefined;
}

export function pipedApiUrl(): string {
  return stored('piped.apiUrl') ?? config.PIPED_API_URL;
}

export class ConfigValidationError extends Error {
  status = 400;
}

export function parseSetting(key: string, value: unknown): string | null {
  const def = SETTINGS[key];
  if (!def) throw new ConfigValidationError(`Unknown setting: ${key}`);
  if (value === null || value === '') return null;
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new ConfigValidationError(parsed.error.issues[0]?.message ?? 'Invalid value');
  return parsed.data;
}

export async function saveSetting(key: string, value: string | null, updatedBy: string) {
  await db.insert(systemConfiguration)
    .values({ key, value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemConfiguration.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
  await loadSystemConfig();
}

/** Everything the admin page shows for each setting. */
export async function describeSettings() {
  const rows = await db.select().from(systemConfiguration);
  const byKey = new Map(rows.map(r => [r.key, r]));
  return Promise.all(Object.entries(SETTINGS).map(async ([key, def]) => {
    const row = byKey.get(key);
    const value = typeof row?.value === 'string' && row.value ? row.value : null;
    const deployed = def.deployed ? await def.deployed() : undefined;
    return {
      key,
      label: def.label,
      description: row?.description ?? null,
      applies: def.applies,
      value,
      fallback: def.fallback() ?? deployed ?? null,
      fallbackSource: def.fallbackSource,
      /** What is in effect right now. */
      effective: def.applies === 'live' ? (value ?? def.fallback() ?? null) : (deployed ?? null),
      /** A deploy setting whose saved value is not in the Piped files yet. */
      pending: def.applies === 'deploy' && value !== null && value !== deployed,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }));
}
