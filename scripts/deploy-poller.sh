#!/usr/bin/env bash
# Deploy-on-approval poller (runs on the prod VPS, on a systemd timer).
#
# A "deploy request" is a board approval whose payload has `kind: "deploy"`. It
# shows up in the operator's Needs-you lane / Inbox with an Approve button. When
# the operator (or the CEO agent) approves it, this poller notices and runs the
# deploy, then comments the result back on the approval. One click for the human;
# the agent asks, the human approves, the deploy handles itself.
#
# Auth: uses the CLI's stored admin credential inside the server container.
# Company is the Durkan Agency company by default (override with env).
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
COMPANY_ID="${PAPERCLIP_DEPLOY_COMPANY_ID:-7600f03c-c836-4326-8d48-c801813c3a87}"
PROCESSED="$REPO_DIR/.deployed-approvals"
LOG="$REPO_DIR/deploy-poller.log"
CLI='cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts'
ARGS='--api-base http://127.0.0.1:3100 --data-dir /paperclip/cli-state --json'

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Only one poll at a time (a deploy takes minutes; the timer fires every minute).
exec 9>"/tmp/paperclip-deploy-poller.lock"
flock -n 9 || exit 0

touch "$PROCESSED"

comment() { # approval_id, body
  docker exec -e BODY="$2" docker-server-1 sh -lc "$CLI approval comment $1 --body \"\$BODY\" $ARGS" >/dev/null 2>&1 || true
}

LIST="$(docker exec docker-server-1 sh -lc "$CLI approval list -C $COMPANY_ID $ARGS" 2>/dev/null)" || {
  log "poller: approval list failed (auth expired? re-run 'auth login')"; exit 0;
}

IDS="$(printf '%s' "$LIST" | PROC="$(tr '\n' ' ' < "$PROCESSED")" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = d if isinstance(d, list) else d.get("approvals", [])
proc = set(os.environ.get("PROC", "").split())
for a in items:
    payload = a.get("payload") or {}
    if (a.get("type") == "request_board_approval"
            and str(payload.get("kind")) == "deploy"
            and a.get("status") == "approved"
            and a.get("id") not in proc):
        print(a["id"])
')"

[ -z "${IDS//[[:space:]]/}" ] && exit 0

for AID in $IDS; do
  log "poller: approved deploy request $AID -> deploying"
  echo "$AID" >> "$PROCESSED"   # record before deploying so a failure never loops
  if "$REPO_DIR/scripts/deploy-prod.sh" >> "$LOG" 2>&1; then
    COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
    comment "$AID" "Deployed to production — commit $COMMIT is live and healthy."
    log "poller: $AID deployed ($COMMIT)"
  else
    comment "$AID" "Deploy failed — check deploy.log on the server. The running version is unchanged."
    log "poller: $AID deploy FAILED"
  fi
done
