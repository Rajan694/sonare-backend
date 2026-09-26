#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

load_nvm() {
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
}
load_nvm

echo "=== Installing backend packages ==="
npm install

if [ ! -f .env ]; then
    echo ""
    echo "=== Creating .env from .env.example ==="
    cp .env.example .env
    echo "Wrote .env - set DATABASE_URL and JWT_SECRET before running."
fi

# Postgres and Redis are local, not dockerised. Fail early with something
# actionable rather than letting the server die on its first query.
DB_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- || true)"
DB_NAME="$(echo "$DB_URL" | sed -E 's|.*/([^/?]+).*|\1|')"

echo ""
echo "=== Checking local services ==="
if command -v pg_isready >/dev/null 2>&1 && pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "  postgres  : up on 5432"
else
    echo "  postgres  : NOT reachable on 127.0.0.1:5432 - start it before running."
fi
if command -v redis-cli >/dev/null 2>&1 && [ "$(redis-cli -p 6379 PING 2>/dev/null)" = "PONG" ]; then
    echo "  redis     : up on 6379"
else
    echo "  redis     : NOT reachable on 127.0.0.1:6379 - the API still runs, cache degrades to passthrough."
fi

echo ""
echo "=== Database setup ($DB_NAME) ==="
npm run db:create
npm run db:generate
npm run db:migrate

echo ""
echo "=== Building ==="
npm run build

echo ""
echo "Backend ready. Start it with ./runBE.sh"
