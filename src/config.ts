import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  PIPED_API_URL: z.string().url().default('http://localhost:8080'),
  PIPED_PROXY_URL: z.string().url().default('http://localhost:8081'),
  GENIUS_CLIENT_ACCESS_TOKEN: z.string().optional(),
  LRCLIB_BASE: z.string().url().default('https://lrclib.net'),
  LRCLIB_USER_AGENT: z.string().default('Sonare/1.0'),
  JWT_SECRET: z.string().default('__sonare_dev_secret__'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379/1'),
});

export const config = envSchema.parse(process.env);

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
