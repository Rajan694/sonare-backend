# Production image for the Sonare backend.
#   docker build -t sonare-backend .
# Usually run through docker-compose.prod.yml, which adds Postgres and Redis.

# ---- build: compile TypeScript and native modules (bcrypt), then drop devDependencies ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg decodes audio for the waveforms; without it they are placeholders.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3010
# Slim images have no curl; Node 22 has fetch. /healthz answers 503 when the database is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3010) + '/api/v1/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Apply pending migrations, then serve.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
