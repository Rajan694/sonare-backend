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
