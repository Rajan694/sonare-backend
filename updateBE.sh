#!/bin/bash
set -e

# Brings this checkout up to date and runs it: pull, install what changed, build, migrate, run.
# One command for a machine that serves the backend (or to pick up someone else's changes).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
    echo "Usage: ./updateBE.sh [dev|prod] [--no-run]"
    echo ""
    echo "  dev       Pull, install, migrate, then ./runBE.sh dev (tsx watch) - the default"
    echo "  prod      Pull, install, build, migrate, then ./runBE.sh start (the compiled build)"
    echo "  --no-run  Stop after updating (../update.sh starts things itself)"
    echo ""
    echo "Refuses to pull over uncommitted changes. npm packages are reinstalled only when"
    echo "package.json or package-lock.json changed (or node_modules is missing)."
    exit 1
}

MODE="dev"
RUN=1
for arg in "$@"; do
    case "$arg" in
        dev|prod) MODE="$arg" ;;
        --no-run) RUN=0 ;;
        *) usage ;;
    esac
done

load_nvm() {
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
}
load_nvm

if [ ! -f .env ]; then
    echo ".env missing - run ./installBE.sh first."
    exit 1
fi

# ---- pull -------------------------------------------------------------------------------

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Uncommitted changes here - commit or stash them before updating:"
    git status --short --untracked-files=no
    exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || { echo "Detached HEAD - check out a branch first."; exit 1; }
BEFORE="$(git rev-parse HEAD)"
echo "=== Pulling $BRANCH ==="
git pull --ff-only
AFTER="$(git rev-parse HEAD)"
changed() { [ "$BEFORE" != "$AFTER" ] && [ -n "$(git diff --name-only "$BEFORE" "$AFTER" -- "$@")" ]; }

# ---- install, build, migrate --------------------------------------------------------------

if [ ! -d node_modules ] || changed package.json package-lock.json; then
    echo ""
    echo "=== Installing packages (npm ci) ==="
    npm ci
fi

if [ "$MODE" = "prod" ]; then
    echo ""
    echo "=== Building ==="
    npm run build
    echo ""
    echo "=== Migrating the database ==="
    npm run db:migrate:prod
else
    echo ""
    echo "=== Migrating the database ==="
    npm run db:migrate
fi

[ "$RUN" = "1" ] || { echo ""; echo "Backend updated ($(git log -1 --format='%h %s'))."; exit 0; }

echo ""
if [ "$MODE" = "prod" ]; then
    exec ./runBE.sh start
fi
exec ./runBE.sh dev
