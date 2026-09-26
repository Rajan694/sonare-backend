# Sonare Backend

Native API for Sonare. Express + TypeScript over a private Piped upstream.

## Architecture & Infrastructure

- **Piped Upstream**: Dockerised container.
- **Database (PostgreSQL)**: Runs locally (not Docker). Reached cleanly via Unix socket (port 5432) at cluster 16.
- **Cache (Redis)**: Runs locally (not Docker) on port 6379 natively. Uses index `db1`.

## Setup

1. Copy `.env.example` to `.env` and fill the variables.
2. Install dependencies:
   ```bash
   npm install
   ```

### Database Setup

Run the following commands to provision the local PostgreSQL backend:

1. **Create the DB** (connects defaultly to `postgres` and creates `sonare`):
   ```bash
   npm run db:create
   ```
2. **Generate migrations** (generates schemas inside `drizzle` directory):
   ```bash
   npm run db:generate
   ```
3. **Run migrations** (executes schemas to structurally provision the `sonare` database):
   ```bash
   npm run db:migrate
   ```

## Start Services

### Development Mode

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

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
  `installPiped.sh` run. The admin page reads those files from `../sonare-piped-backend`,
  or from `PIPED_BACKEND_DIR`.
