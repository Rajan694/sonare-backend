#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
    echo "Usage: ./runBE.sh [dev|start]"
    echo ""
    echo "  dev     Run with tsx watch and reload on change (default)"
    echo "  start   Run the compiled build from dist/"
    echo ""
    echo "Environment:"
    echo "  PORT    Override the listen port (default from .env, 3010)"
    exit 1
}

MODE="${1:-dev}"
case "$MODE" in
    dev|start) ;;
    *) usage ;;
esac

load_nvm() {
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
}
load_nvm

if [ ! -d node_modules ]; then
    echo "node_modules missing - run ./installBE.sh first."
    exit 1
fi

if [ ! -f .env ]; then
    echo ".env missing - run ./installBE.sh first."
    exit 1
fi

# The Piped upstream is private (contract D2) but the catalog is useless without
# it, so say plainly whether it is up rather than failing later per-request.
PIPED_URL="$(grep -E '^PIPED_API_URL=' .env | cut -d= -f2- || echo http://localhost:8090)"
if curl -sf --max-time 3 "$PIPED_URL/healthcheck" >/dev/null 2>&1; then
    echo "Piped upstream: up ($PIPED_URL)"
else
    echo "Piped upstream: DOWN ($PIPED_URL) - catalog and streaming will fail."
    echo "  Start it with ../sonare-piped-backend/runPiped.sh"
fi

if [ "$MODE" = "start" ]; then
    if [ ! -d dist ]; then
        echo "dist/ missing - building first."
        npm run build
    fi
    exec npm run start
fi

exec npm run dev
