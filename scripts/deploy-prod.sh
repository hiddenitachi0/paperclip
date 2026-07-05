#!/usr/bin/env bash
# Deploy the paperclip-fork `custom` branch to the production VPS.
#
# This is the fork's gated deploy path: run it (manually, or from a trigger) to
# release whatever is on origin/custom. It pulls, rebuilds the image while the
# current one keeps serving, swaps the container, and health-checks — logging
# every step to deploy.log. Safe to run repeatedly; a no-op if custom hasn't moved.
#
# Usage (on the VPS, from the repo root):
#   ./scripts/deploy-prod.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG="$REPO_DIR/deploy.log"
COMPOSE=(docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml)
HEALTH_URL="http://127.0.0.1:3100/api/health"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

log "deploy: fetching origin/custom"
git fetch --quiet origin custom
BEFORE="$(git rev-parse --short HEAD)"
git checkout --quiet custom
git reset --hard --quiet origin/custom
AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  log "deploy: already at $AFTER — rebuilding anyway to pick up any local image drift"
else
  log "deploy: $BEFORE -> $AFTER"
fi

log "deploy: building image (current container keeps serving)"
if ! "${COMPOSE[@]}" build server >>"$LOG" 2>&1; then
  log "deploy: BUILD FAILED — leaving the running container untouched. See $LOG"
  exit 1
fi

log "deploy: swapping container to the new image"
"${COMPOSE[@]}" up -d --no-build >>"$LOG" 2>&1

log "deploy: health check"
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
  if [ "$code" = "200" ]; then
    log "deploy: OK — $AFTER is live and healthy"
    exit 0
  fi
  sleep 3
done

log "deploy: WARNING — health check did not pass after swap (last code=$code). Investigate:"
log "        ${COMPOSE[*]} logs --tail=50 server"
exit 1
