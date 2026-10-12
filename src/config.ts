import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const DEV_JWT_SECRET = '__sonare_dev_secret__';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3010),
  PIPED_API_URL: z.string().url().default('http://localhost:8090'),
  // Shared secret for a Piped reached over the internet (Tailscale Funnel): sent as
  // X-Sonare-Key to the Piped host, whose gate in sonare-piped-backend rejects requests without it.
  PIPED_KEY: z.string().optional(),
  // Piped on this machine, published through Funnel: its stream urls name the public proxy
  // (PROXY_PART), which this machine may not resolve. The relay fetches them here instead.
  PIPED_LOCAL_PROXY_URL: z.string().url().optional(),
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
  // Resend's HTTP API sends the mail when set; otherwise SMTP (Mailpit in development).
  // Render's free plan blocks outbound SMTP ports, so production uses the API.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Sonare <no-reply@sonare.vip>'),
  APP_URL: z.string().url().default('http://localhost:5183'),
  // App builds are GitHub release assets; /releases serves the latest release of this repo.
  // GITHUB_TOKEN is optional: unauthenticated calls get 60 an hour per IP, shared on hosts like Render.
  RELEASES_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .default('Rajan694/sonare'),
  GITHUB_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Development defaults are unsafe in production; refuse to start with them. */
export const assertProductionConfig = (cfg: Config): void => {
  if (cfg.NODE_ENV !== 'production') return;
  if (cfg.JWT_SECRET === DEV_JWT_SECRET || cfg.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production');
  }
  if (!cfg.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY must be set in production');
  }
  if (!cfg.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL must be an https URL in production');
  }
};

export const config = envSchema.parse(process.env);
assertProductionConfig(config);

/** Express's `trust proxy` setting from TRUST_PROXY, or undefined to leave it off. */
export const parseTrustProxy = (value: string | undefined): boolean | number | string | undefined => {
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
};

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

export const parseDatabaseUrl = (urlStr: string): DbConnectionOptions => {
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
};

export const dbConfig = parseDatabaseUrl(config.DATABASE_URL);
