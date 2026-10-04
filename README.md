# Sonare backend

The Sonare API: Express 5 + TypeScript in front of a private [Piped](../sonare-piped-backend)
instance. It turns Piped's YouTube data into Sonare's catalog (tracks, albums, artists,
playlists), relays audio streams, resolves lyrics (LRCLIB), and stores accounts,
libraries, playlists, settings and play history in Postgres. Redis caches upstream answers
and backs the rate limiters. The desktop, web and mobile apps (`sonare-frontend`) all talk
to it under `/api/v1`; the full contract is [`../docs/api-contract.md`](../docs/api-contract.md).

## Requirements

- Node 22 (`nvm use 22`)
- Postgres 17 (16 works for development)
- Redis 7 — optional at runtime: without it caching passes through and rate limits fail open
- ffmpeg on the PATH — optional: without it waveforms are placeholders (warned at startup,
  shown on `/healthz` and the admin overview). The production image installs it.
- Piped running locally (`../sonare-piped-backend/runPiped.sh up`) — API on :8090, proxy on :8091
- Docker, for Mailpit in development and for the production stack

## Setup

```bash
./installBE.sh
```

It runs `npm install`, creates `.env` from `.env.example` (set `DATABASE_URL` and
`JWT_SECRET`), checks Postgres and Redis, creates the database (`npm run db:create`), applies
the migrations (`npm run db:migrate`) and builds. By hand:

```bash
npm install
cp .env.example .env      # then edit it
npm run db:create
npm run db:migrate
```

## Running

```bash
./runBE.sh          # tsx watch, reloads on change (default)
./runBE.sh start    # the compiled build in dist/
```

`runBE.sh` starts Mailpit (`docker-compose.dev.yml`) so verification and password-reset
emails can be read at **http://localhost:8025**, and says whether Piped is up. The API
listens on `PORT` (3010).

## Scripts

| Script                    | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run dev`             | Start with `tsx watch`                                               |
| `npm run build`           | Compile to `dist/`                                                   |
| `npm start`               | Run `dist/server.js`                                                 |
| `npm test`                | Check the test plan, then run all tests (vitest)                     |
| `npm run test:watch`      | vitest in watch mode                                                 |
| `npm run test:coverage`   | Tests with coverage (90 % lines, 70 % branches)                      |
| `npm run typecheck`       | `tsc` over `src/`, then over `src/` + `test/` (`tsconfig.test.json`) |
| `npm run lint`            | ESLint                                                               |
| `npm run format`          | Prettier, writing                                                    |
| `npm run format:check`    | Prettier, checking only                                              |
| `npm run db:create`       | Create the `sonare` database                                         |
| `npm run db:generate`     | Generate a migration from `src/db/schema.ts` (drizzle-kit)           |
| `npm run db:migrate`      | Apply migrations (drizzle-kit, development)                          |
| `npm run db:migrate:prod` | Apply migrations from `dist/` without drizzle-kit (production image) |

A pre-commit hook (husky + lint-staged) runs Prettier and ESLint on staged files.

## Environment variables

Development values are in `.env.example`, production ones in `.env.production.example`.

| Name                | Default                        | Required in production | What it does                                                        |
| ------------------- | ------------------------------ | ---------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`          | `development`                  | yes (`production`)     | `development`, `production` or `test`                               |
| `PORT`              | `3010`                         | no                     | Listen port                                                         |
| `DATABASE_URL`      | —                              | yes                    | Postgres connection URL                                             |
| `REDIS_URL`         | `redis://127.0.0.1:6379/1`     | no                     | Redis for the cache and rate limits                                 |
| `PIPED_API_URL`     | `http://localhost:8090`        | yes                    | Piped API (can be overridden live from the admin page)              |
| `PIPED_PROXY_URL`   | `http://localhost:8091`        | no                     | Piped's media proxy (media URLs come from Piped's `PROXY_PART`)     |
| `PIPED_BACKEND_DIR` | `../sonare-piped-backend`      | no                     | Where the admin page reads Piped's build settings                   |
| `JWT_SECRET`        | dev placeholder                | yes (≥ 32 chars)       | Signs access tokens; the server refuses the default in production   |
| `CORS_ORIGINS`      | empty                          | yes                    | Comma-separated allowed origins (localhost is allowed outside prod) |
| `TRUST_PROXY`       | unset                          | behind a proxy         | Express `trust proxy` (hop count, `true`, `loopback`…)              |
| `LOG_LEVEL`         | `info`                         | no                     | pino level; logs are pretty in development, JSON otherwise          |
| `LRCLIB_BASE`       | `https://lrclib.net`           | no                     | LRCLIB API                                                          |
| `LRCLIB_USER_AGENT` | `Sonare/1.0`                   | no                     | User-Agent sent to LRCLIB                                           |
| `SMTP_HOST`         | `127.0.0.1`                    | yes                    | Mailpit in development, `smtp.resend.com` in production             |
| `SMTP_PORT`         | `1025`                         | yes                    | `465` for Resend                                                    |
| `SMTP_SECURE`       | `false`                        | yes                    | `true` for Resend                                                   |
| `SMTP_USER`         | unset                          | yes                    | `resend`                                                            |
| `SMTP_PASS`         | unset                          | yes                    | Resend API key                                                      |
| `MAIL_FROM`         | `Sonare <no-reply@sonare.dev>` | yes                    | Sender of account emails                                            |
| `APP_URL`           | `http://localhost:5183`        | yes (https)            | Base of the links in verification and reset emails                  |

## Folder layout

```
src/
  app.ts            createApp: middleware, router mounting, 404, error handler
  server.ts         starts the HTTP server, graceful shutdown
  config.ts         environment (zod), production safety checks
  logger.ts         the pino logger
  validation.ts     parseBody / parseQuery (zod → 400 BAD_REQUEST)
  errors.ts  ids.ts  types.ts
  middleware/       auth (requireAuth, optionalAuth), adminAuth, rateLimit, errorHandler
  routes/           auth, me, admin, clientErrors, catalog, media, lyrics (*.routes.ts)
  services/         cache, emailTokens, lyrics, mail, peaks, systemConfig, telemetry, token
  db/               index (connection), schema, create, migrate, hydrate, userData
  normalize/        Piped → Sonare shapes
  upstream/         piped (+ piped.types), lrclib
drizzle/            SQL migrations
test/               unit/ and integration/ (vitest)
```

File names are camelCase; routers are `*.routes.ts`.

## Testing

```bash
sed 's#postgres://postgres:yourpassword@#postgres://postgres:postgres@#' .env.test.example > .env.test
npm test
```

Tests need Postgres and Redis on localhost. The setup refuses any database except
`sonare_test` (created and migrated on each run) and uses Redis database 15, so a
development database is never touched. Every test title starts with an id listed in
`TEST-PLAN.md`; `npm test` fails if the two disagree.

## Production with Docker

`Dockerfile` builds a slim Node 22 image that applies pending migrations and then starts
the server; `docker-compose.prod.yml` runs it next to Postgres 17 and Redis 7.

```bash
cp .env.production.example .env.production   # replace every CHANGE_ME, set JWT_SECRET
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
curl http://127.0.0.1:3010/api/v1/healthz
```

- The backend is published on `127.0.0.1:3010` only: put Caddy or nginx in front for
  HTTPS (`api.sonare.dev`) and keep `TRUST_PROXY=1`.
- Postgres and Redis publish no ports; their data lives in the `postgres-data` and
  `redis-data` volumes.
- Piped runs from its own compose file. Its ports are bound to the host's 127.0.0.1,
  which a container cannot reach — see the Piped notes in `.env.production.example`.
- `/api/v1/healthz` answers `{ ok, version, db, redis, piped, ffmpeg }`, with 503 when the
  database is down; the image's `HEALTHCHECK` uses it.

## Admin

The web build has an admin page at `/admin` (not linked from the app). It signs in with
the `admin_users` table, which is separate from app accounts. The migrations create the
`rajanadmin` account; change its initial password from **Account** after the first sign-in.

- **Overview** and **API**: usage and request metrics from `request_logs` (one row per API
  request, kept 30 days). The apps tag their requests with an `X-Sonare-Client` header.
- **Errors**: backend 5xx errors and app crash reports (`POST /api/v1/client-errors`) from
  `error_logs`. Repeats of one error share a row with a count; kept 90 days after last seen.
- **Configuration**: the `system_configuration` table. `piped.apiUrl` applies immediately.
  `piped.extractorCommit` and `piped.proxyUrl` are copied into `../sonare-piped-backend`
  (build.gradle, config.properties) by its `syncAdminConfig.sh`, which `runPiped.sh` and
  `installPiped.sh` run.

## Downloads

The apps download audio through the playback endpoints: `GET /tracks/:id/stream` picks the
stream (`quality` = `low` / `normal` / `high` / `auto`, `format`) and `GET /stream/:token`
relays it in `Range` chunks, so paused downloads resume where they stopped. A range past
the end of the file gets a 416 with the size. Download quality and format are account
settings (`PUT /me/settings` changes only the fields it is sent).

## Licence

MIT — see [LICENSE](LICENSE).
