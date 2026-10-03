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
  // Set when running behind a reverse proxy so req.ip is the client, not the proxy:
  // a hop count ("1"), "true", or Express's named values ("loopback").
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Sonare <no-reply@sonare.dev>'),
  APP_URL: z.string().url().default('http://localhost:5183'),
});

export type Config = z.infer<typeof envSchema>;

/** Development defaults are unsafe in production; refuse to start with them. */
export function assertProductionConfig(cfg: Config): void {
  if (cfg.NODE_ENV !== 'production') return;
  if (cfg.JWT_SECRET === DEV_JWT_SECRET || cfg.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production');
  }
  if (!cfg.SMTP_USER || !cfg.SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS must be set in production');
  }
  if (!cfg.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL must be an https URL in production');
  }
}

export const config = envSchema.parse(process.env);
assertProductionConfig(config);

/** Express's `trust proxy` setting from TRUST_PROXY, or undefined to leave it off. */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
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
