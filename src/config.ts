import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const DEV_JWT_SECRET = '__sonare_dev_secret__';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3010),
  PIPED_API_URL: z.string().url().default('http://localhost:8090'),
  PIPED_PROXY_URL: z.string().url().default('http://localhost:8091'),
  GENIUS_CLIENT_ACCESS_TOKEN: z.string().optional(),
  LRCLIB_BASE: z.string().url().default('https://lrclib.net'),
  LRCLIB_USER_AGENT: z.string().default('Sonare/1.0'),
  JWT_SECRET: z.string().default(DEV_JWT_SECRET),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379/1'),
  CORS_ORIGINS: z.string().default(''),
});

export const config = envSchema.parse(process.env);

if (config.NODE_ENV === 'production' && (config.JWT_SECRET === DEV_JWT_SECRET || config.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production');
}

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface DbConnectionOptions {
  host: string;
  port?: number;
  database: string;
  user?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export function parseDatabaseUrl(urlStr: string): DbConnectionOptions {
  const parsed = new URL(urlStr);
  const socketHost = parsed.searchParams.get('host');
  const database = parsed.pathname.replace(/^\//, '');
  const user = parsed.username || undefined;
  const password = parsed.password || undefined;
  const port = parsed.port ? parseInt(parsed.port, 10) : undefined;

  if (socketHost && socketHost.startsWith('/')) {
    return {
      host: socketHost,
      port: port || 5432,
      database,
      user,
      username: user,
    };
  }

  return {
    host: parsed.hostname || 'localhost',
    port: port || 5432,
    database,
    user,
    username: user,
    password,
    ssl: parsed.searchParams.get('sslmode') === 'require' ? true : undefined,
  };
}

export const dbConfig = parseDatabaseUrl(config.DATABASE_URL);
