#!/usr/bin/env bash
# DUR-297 (split out of DUR-259): live acceptance test for
# scripts/deploy-runner.sh's compose_recreate path.
#
# scripts/deploy-runner.test.mjs is unit-level only -- it fakes `docker` on
# PATH and never boots a real stack. This script instead:
#
#   1. Boots the real compose stack the way docker-compose.prod.yml +
#      deploy-runner.sh expect (see docker-compose.ci-recreate-test.yml for
#      what's tuned down purely for CI turnaround, and why).
#   2. Creates a company/project/workspace/agent and dispatches a REAL
#      heartbeat run (adapterType "process" running a plain `sleep`, so the
#      run is genuinely in-flight for a fixed window without needing any
#      LLM credentials).
#   3. While that run is in flight, files + approves a real `kind: "deploy"`
#      board approval and runs scripts/deploy-runner.sh FOR REAL against the
#      live stack -- it resolves the approval, force-recreates the `server`
#      container (docker compose ... up -d --force-recreate), and health-
#      checks it back up, exactly as it would in production.
#   4. Asserts, via the CLI (`run list` / `heartbeat run`), that the run
#      in flight during the recreate never ends up status "failed".
#
# What this proves today: the container-level shutdown drain added in
# DUR-257 (server/src/shutdown-drain.ts, docker-compose.prod.yml's
# stop_grace_period) is enough, on its own, for an in-flight run to survive
# a real `docker compose up -d --force-recreate` of the server container.
# DUR-259's own proactive instance-wide quiet-mode drain (frontrunning the
# recreate, freezing new work across every company) is a stricter version of
# the same guarantee this test already exercises for a single agent -- once
# it lands, this same assertion (no run ends up "failed") should still hold.
#
# Not covered here: the "drain timeout" path (deploy-runner.sh proceeding
# with a recreate anyway after quiet mode times out) -- as of this writing
# deploy-runner.sh doesn't yet call `instance heartbeat-runs:pause-for-
# restart` (added by DUR-296) on that path, so there is nothing to exercise
# end-to-end yet. See DUR-297's issue thread.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dur297-recreate-acceptance}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.ci-recreate-test.yml)

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-runner-acceptance.XXXXXX")"
ENV_FILE="$WORK_DIR/.env"
PAYLOAD_FILE="$WORK_DIR/payload.json"

# Logs live under $REPO_ROOT (not $WORK_DIR, which cleanup() deletes on
# every exit path) so a CI step can upload them as artifacts *after* this
# script has already exited, whether it passed or failed.
LOG_DIR="${DUR297_LOG_DIR:-$REPO_ROOT/.dur297-recreate-acceptance-logs}"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
DEPLOY_RUNNER_LOG="$LOG_DIR/deploy-runner.log"
DEPLOY_RUNNER_PROCESSED="$WORK_DIR/deploy-runner-processed"
DEPLOY_RUNNER_FAILURE_LOG_DIR="$LOG_DIR/deploy-failure-logs"
HEARTBEAT_LOG="$LOG_DIR/heartbeat-run.log"

# How long the fake in-flight "agent turn" runs for -- comfortably inside
# the tuned-down drain/grace windows in docker-compose.ci-recreate-test.yml,
# but long enough that the recreate is guaranteed to land while it's still
# running rather than racing it.
SLEEP_SECONDS="${DUR297_SLEEP_SECONDS:-20}"

CLI_CMD='cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts'
API_BASE='http://127.0.0.1:3100'
ARGS="--api-base $API_BASE --json"

HEARTBEAT_PID=""
FAIL=0
FAKE_GITHUB_PID=""
FAKE_GITHUB_PORT=""

# deploy-runner.sh's compose_recreate reads deployPolicy.envFile relative to
# deployTargetPath (here, $REPO_ROOT itself -- see "wiring deployPolicy"
# below), so this script has to drop its generated secrets at
# $REPO_ROOT/.env for the recreate to pick up. Preserve/restore any real
# .env a developer running this locally might already have, rather than
# clobbering it.
REPO_ENV_BACKUP=""
if [ -f "$REPO_ROOT/.env" ]; then
  REPO_ENV_BACKUP="$WORK_DIR/repo-dot-env.orig"
  mkdir -p "$WORK_DIR"
  cp "$REPO_ROOT/.env" "$REPO_ENV_BACKUP"
fi

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

cleanup() {
  if [ -n "$HEARTBEAT_PID" ] && kill -0 "$HEARTBEAT_PID" 2>/dev/null; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  if [ -n "$FAKE_GITHUB_PID" ] && kill -0 "$FAKE_GITHUB_PID" 2>/dev/null; then
    kill "$FAKE_GITHUB_PID" 2>/dev/null || true
    wait "$FAKE_GITHUB_PID" 2>/dev/null || true
  fi
  log "cleanup: dumping deploy-runner.log"
  cat "$DEPLOY_RUNNER_LOG" 2>/dev/null >&2 || true
  log "cleanup: tearing down compose stack"
  "${COMPOSE[@]}" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$REPO_ENV_BACKUP" ] && [ -f "$REPO_ENV_BACKUP" ]; then
    cp "$REPO_ENV_BACKUP" "$REPO_ROOT/.env"
  else
    rm -f "$REPO_ROOT/.env"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

resolve_container_id() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" ps -q server
}

# All setup calls (company/project/workspace/agent/approval) go straight to
# the API inside the container's own network namespace -- same access path
# deploy-runner.sh itself uses (`docker exec ... curl ...`), and the only
# one that works against a `HOST=127.0.0.1`-bound app with no published
# port. JSON bodies are `docker cp`'d in rather than shell-interpolated to
# avoid any quoting hazard.
api_call() { # method, path, [json_payload] -> stdout: response body
  local method="$1" path="$2" payload="${3:-}" container
  container="$(resolve_container_id)"
  if [ -n "$payload" ]; then
    printf '%s' "$payload" >"$PAYLOAD_FILE"
    docker cp "$PAYLOAD_FILE" "$container:/tmp/dur297-payload.json"
    docker exec "$container" curl -fsS -X "$method" "$API_BASE$path" \
      -H 'Content-Type: application/json' --data @/tmp/dur297-payload.json
  else
    docker exec "$container" curl -fsS -X "$method" "$API_BASE$path"
  fi
}

cli_json() { # subcommand args... -> stdout: JSON
  local container
  container="$(resolve_container_id)"
  docker exec "$container" sh -lc "$CLI_CMD $* $ARGS"
}

wait_for_health() {
  local i container
  for i in $(seq 1 60); do
    container="$(resolve_container_id)"
    if [ -n "$container" ] && docker exec "$container" curl -fsS "$API_BASE/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# DUR-3905 added a GitHub-CI-status precondition to deploy-runner.sh's
# run_deploy(): it now holds any deploy outright if the target commit's
# combined GitHub status + check-runs aren't all green. This job (the one
# running THIS script) is itself one of the required checks for the commit
# under test, which means its status is definitionally still "pending" from
# GitHub's point of view while this script is running -- pointing
# deploy-runner.sh at the real GitHub API here would make it hold every
# single time, self-referentially, and this acceptance test could never pass
# in CI. Stand up a local stand-in instead, the same test seam
# scripts/deploy-runner.test.mjs's own check_ci_status() tests use via
# PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE, that always reports a green build.
start_fake_github_ci_server() {
  local script="$WORK_DIR/fake-github-ci.py" port_file="$WORK_DIR/fake-github-ci.port"
  cat >"$script" <<'PY'
import http.server
import json

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/check-runs"):
            body = json.dumps({"check_runs": []}).encode()
        else:
            body = json.dumps({"state": "success", "total_count": 1}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY
  python3 "$script" >"$port_file" 2>"$LOG_DIR/fake-github-ci.log" &
  FAKE_GITHUB_PID=$!
  local i
  for i in $(seq 1 30); do
    if [ -s "$port_file" ]; then
      FAKE_GITHUB_PORT="$(cat "$port_file")"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_run_running() { # company_id, agent_id
  local company_id="$1" agent_id="$2" i status
  for i in $(seq 1 30); do
    status="$(cli_json run list -C "$company_id" --agent-id "$agent_id" --limit 1 \
      | python3 -c 'import json,sys
rows=json.load(sys.stdin)
print((rows[0] or {}).get("status","") if rows else "")' 2>/dev/null)"
    if [ "$status" = "running" ]; then
      return 0
    fi
    if [ "$status" = "failed" ] || [ "$status" = "succeeded" ]; then
      log "heartbeat run already terminal (status=$status) before the recreate even started"
      return 1
    fi
    sleep 1
  done
  return 1
}

main() {
  log "booting compose stack (project=$COMPOSE_PROJECT_NAME)"
  {
    echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
    echo "PAPERCLIP_PUBLIC_URL=$API_BASE"
  } >"$ENV_FILE"

  "${COMPOSE[@]}" --env-file "$ENV_FILE" up -d --build

  log "waiting for /api/health"
  if ! wait_for_health; then
    log "FAIL: server never became healthy"
    exit 1
  fi

  local before_container_id
  before_container_id="$(resolve_container_id)"
  log "server container: $before_container_id"

  log "starting fake GitHub CI status server (DUR-3905 precondition)"
  if ! start_fake_github_ci_server; then
    log "FAIL: fake GitHub CI status server never came up"
    exit 1
  fi
  log "fake GitHub CI status server listening on 127.0.0.1:$FAKE_GITHUB_PORT"

  log "creating company/agent/project/workspace"
  local company_id project_json project_id workspace_id agent_id
  company_id="$(api_call POST /api/companies "$(python3 -c 'import json;print(json.dumps({"name":"DUR-297 recreate acceptance"}))')" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"

  local repo_url repo_ref commit
  repo_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"
  [ -z "$repo_url" ] && repo_url="https://example.invalid/placeholder.git"
  repo_ref="$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null || echo "")"
  commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [ -z "$repo_ref" ] && repo_ref="$commit"

  project_json="$(api_call POST /api/companies/"$company_id"/projects "$(
    python3 -c 'import json,sys
repo_url, repo_ref, deploy_target = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "name": "deploy target",
    "workspace": {"repoUrl": repo_url, "repoRef": repo_ref, "cwd": deploy_target},
}))' "$repo_url" "$repo_ref" "$REPO_ROOT"
  )")"
  project_id="$(printf '%s' "$project_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  workspace_id="$(printf '%s' "$project_json" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("workspaces") or [{}])[0]["id"])')"

  agent_id="$(api_call POST /api/companies/"$company_id"/agents "$(
    python3 -c 'import json,sys
sleep_seconds = sys.argv[1]
print(json.dumps({
    "name": "ci-recreate-worker",
    "role": "general",
    "adapterType": "process",
    "adapterConfig": {"command": "sleep", "args": [sleep_seconds]},
}))' "$SLEEP_SECONDS"
  )" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"

  log "company=$company_id project=$project_id workspace=$workspace_id agent=$agent_id"

  log "wiring deployPolicy (compose_recreate)"
  api_call PATCH /api/projects/"$project_id" "$(
    python3 -c 'import json,sys
workspace_id, deploy_target, health_url = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"deployPolicy": {
    "enabled": True,
    "requestingAgentId": None,
    "workspaceId": workspace_id,
    "deployTargetPath": deploy_target,
    "deployKind": "compose_recreate",
    "deployServices": ["server"],
    "composeFiles": [
        "docker/docker-compose.yml",
        "docker/docker-compose.prod.yml",
        "docker/docker-compose.ci-recreate-test.yml",
    ],
    "envFile": ".env",
    "healthCheckUrl": health_url,
    "rollback": "none",
}}))' "$workspace_id" "$REPO_ROOT" "$API_BASE/api/health"
  )" >/dev/null

  # deploy-runner.sh's own git_fetch_reset needs to find this file relative
  # to deployTargetPath (docker compose's --env-file argument), so drop the
  # same secrets it needs at the path deployPolicy.envFile points at.
  cp "$ENV_FILE" "$REPO_ROOT/.env"

  log "filing + approving a deploy approval"
  local approval_id
  approval_id="$(api_call POST /api/companies/"$company_id"/approvals "$(
    python3 -c 'import json,sys
project_id, workspace_id, commit = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "type": "request_board_approval",
    "payload": {
        "kind": "deploy",
        "projectId": project_id,
        "workspaceId": workspace_id,
        "commit": commit,
        "title": "DUR-297 acceptance test deploy",
        "note": "Filed by scripts/deploy-runner-recreate-acceptance.sh",
    },
}))' "$project_id" "$workspace_id" "$commit"
  )" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  api_call POST /api/approvals/"$approval_id"/approve "$(python3 -c 'import json;print(json.dumps({}))')" >/dev/null
  log "approval $approval_id approved"

  log "dispatching heartbeat run (sleep ${SLEEP_SECONDS}s) in the background"
  local container
  container="$(resolve_container_id)"
  (
    docker exec "$container" sh -lc \
      "$CLI_CMD heartbeat run --agent-id $agent_id $ARGS --source on_demand --trigger manual --timeout-ms $(( (SLEEP_SECONDS + 90) * 1000 ))"
  ) >"$HEARTBEAT_LOG" 2>&1 &
  HEARTBEAT_PID=$!

  if ! wait_for_run_running "$company_id" "$agent_id"; then
    log "FAIL: heartbeat run never reached status=running before timing out"
    FAIL=1
  else
    log "heartbeat run is in flight -- running deploy-runner.sh's real compose_recreate path now"
    PAPERCLIP_DEPLOY_RUNNER_CONTAINER="$before_container_id" \
      PAPERCLIP_DEPLOY_RUNNER_LOG="$DEPLOY_RUNNER_LOG" \
      PAPERCLIP_DEPLOY_RUNNER_PROCESSED="$DEPLOY_RUNNER_PROCESSED" \
      PAPERCLIP_DEPLOY_RUNNER_FAILURE_LOG_DIR="$DEPLOY_RUNNER_FAILURE_LOG_DIR" \
      PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE="http://127.0.0.1:$FAKE_GITHUB_PORT" \
      bash "$REPO_ROOT/scripts/deploy-runner.sh"

    local after_container_id
    after_container_id="$(resolve_container_id)"
    if [ "$after_container_id" = "$before_container_id" ]; then
      log "FAIL: server container id unchanged ($after_container_id) -- deploy-runner.sh never actually recreated it"
      FAIL=1
    else
      log "server container recreated: $before_container_id -> $after_container_id"
    fi
  fi

  log "waiting for the heartbeat run's own CLI process to reach a terminal status"
  local heartbeat_exit=0
  if [ -n "$HEARTBEAT_PID" ]; then
    wait "$HEARTBEAT_PID"
    heartbeat_exit=$?
    HEARTBEAT_PID=""
  fi
  cat "$HEARTBEAT_LOG" >&2 || true

  local run_status
  run_status="$(cli_json run list -C "$company_id" --agent-id "$agent_id" --limit 1 \
    | python3 -c 'import json,sys
rows=json.load(sys.stdin)
print((rows[0] or {}).get("status","") if rows else "")' 2>/dev/null)"
  log "final heartbeat run status: ${run_status:-<unknown>} (cli heartbeat-run exit=$heartbeat_exit)"

  log "approval outcome:"
  cli_json approval get "$approval_id" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin), indent=2))' >&2 || true

  if [ "$run_status" = "failed" ]; then
    log "FAIL: heartbeat run ended status=failed during the container recreate"
    FAIL=1
  elif [ "$run_status" != "succeeded" ] && [ "$run_status" != "paused_for_restart" ]; then
    log "FAIL: heartbeat run ended in unexpected status '$run_status' (cli exit=$heartbeat_exit)"
    FAIL=1
  fi

  if [ "$FAIL" -eq 0 ]; then
    log "PASS: in-flight heartbeat run survived a real deploy-runner.sh compose_recreate (status=$run_status)"
  fi
  return "$FAIL"
}

main
exit $?
