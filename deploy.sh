#!/usr/bin/env bash
#
# Deploy AI Orchestra on this server. Invoked by .gitlab-ci.yml over SSH
# whenever main moves forward. Idempotent: re-running with no new commits
# restarts containers but pulls no code.
#
set -euo pipefail

cd /opt/ai-orchestra

# Always deploy main; reject runs from a detached / different branch so a
# manual git checkout on the box doesn't get blown away silently.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  git checkout main
fi

git fetch --quiet origin main
BEFORE=$(git rev-parse HEAD)
git reset --hard origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "[deploy] no new commits ($AFTER), restarting containers anyway"
fi

if [ ! -f .env ]; then
  echo "[deploy] .env missing — copy .env.example and fill in secrets first" >&2
  exit 1
fi

# If a previous `compose up` was killed mid-recreate, Docker renames the
# old container to `<12-hex>_<original-name>` and refuses to reuse the
# name on the next run. `--remove-orphans` doesn't catch these because
# they've lost their compose labels. Scrub them before `up`.
STALE=$(docker ps -a --format '{{.Names}}' \
        | grep -E '^[0-9a-f]{12}_ai-orchestra-' || true)
if [ -n "$STALE" ]; then
  echo "[deploy] removing stale renamed containers:"
  echo "$STALE" | sed 's/^/  - /'
  echo "$STALE" | xargs -r docker rm -f >/dev/null
fi

# Up: build images for orchestra-core, pull postgres if missing, recreate
# containers whose underlying image changed. Detached so the SSH session can
# end without killing them.
docker compose up -d --build --remove-orphans

# Prune dangling images so the disk doesn't fill from rebuilds. Keeps named
# images intact.
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] complete: $(git log --oneline -1)"
