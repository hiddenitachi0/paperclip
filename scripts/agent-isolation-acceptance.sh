#!/usr/bin/env bash
# DUR-3994: live acceptance test -- can an agent read the server's keys, or
# anything else it should not?
#
# Modelled on scripts/deploy-runner-recreate-acceptance.sh. It:
#
#   1. Writes random decoy values ("canaries", all containing the marker
#      DUR3994CANARY) for every server key into docker/.env -- the file
#      production keeps its keys in, and which sits inside the image build
#      context -- plus one decoy line that exists ONLY in that file.
#   2. Builds and boots the real stack (docker-compose.yml + prod overlay +
#      docker/docker-compose.ci-isolation-test.yml).
#   3. Creates company A with a `process`-adapter agent that runs
#      scripts/isolation-probe.sh through the real heartbeat -> runChildProcess
#      path, and company B with a canary file in its project folder.
#   4. Reads the probe's report. The probe prints only PASS / LEAK /
#      KNOWN_GAP plus a path or variable NAME, never a value.
#
# Pass rule: no LEAK for the stages listed in ISOLATION_ENFORCED_STAGES
# (default "0"). Checks for later stages are printed as KNOWN_GAP and do not
# fail the run; each later stage adds its number here when it ships.
#
# Negative controls (the harness must be able to see a leak, or a green run
# means nothing):
#   a. The same probe run with the container's full environment (`docker exec
#      -u node`, i.e. exactly what every agent inherited before Stage 0) must
#      report LEAK for BETTER_AUTH_SECRET.
#   b. A second agent whose own settings deliberately carry a canary under a
#      harmless name must report LEAK for it -- through the same real
#      runChildProcess path as the main agent.
#   c. A tiny build of a throwaway context WITHOUT .dockerignore must contain
#      docker/.env, and the same build WITH the repo's .dockerignore must not.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dur3994-isolation-acceptance}"
DOCKER_ENV_FILE="$REPO_ROOT/docker/.env"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$DOCKER_ENV_FILE" \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.ci-isolation-test.yml)

ENFORCED_STAGES="${ISOLATION_ENFORCED_STAGES:-0}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-isolation-acceptance.XXXXXX")"
PAYLOAD_FILE="$WORK_DIR/payload.json"
LOG_DIR="${ISOLATION_LOG_DIR:-$REPO_ROOT/.dur3994-isolation-acceptance-logs}"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

CLI_CMD='cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts'
API_BASE='http://127.0.0.1:3100'
PROBE_PATH='/app/scripts/isolation-probe.sh'
FAIL=0

# Keep a developer's real docker/.env safe: move it aside, restore on exit.
DOCKER_ENV_BACKUP=""
if [ -f "$DOCKER_ENV_FILE" ]; then
  DOCKER_ENV_BACKUP="$WORK_DIR/docker-dot-env.orig"
  cp -p "$DOCKER_ENV_FILE" "$DOCKER_ENV_BACKUP"
fi

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { log "FAIL: $*"; FAIL=1; }

cleanup() {
  if [ "$FAIL" -ne 0 ]; then
    "${COMPOSE[@]}" logs --no-color --tail 300 server >"$LOG_DIR/server.log" 2>&1 || true
  fi
  log "cleanup: tearing down compose stack"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$DOCKER_ENV_BACKUP" ] && [ -f "$DOCKER_ENV_BACKUP" ]; then
    cp -p "$DOCKER_ENV_BACKUP" "$DOCKER_ENV_FILE"
  else
    rm -f "$DOCKER_ENV_FILE"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

canary() { # [hex-bytes] -> a fresh decoy value carrying the marker
  printf 'DUR3994CANARY%s' "$(openssl rand -hex "${1:-16}")"
}

server_container() { "${COMPOSE[@]}" ps -q server; }

api_call() { # method, path, [json] -> response body
  local method="$1" path="$2" payload="${3:-}" container
  container="$(server_container)"
  if [ -n "$payload" ]; then
    printf '%s' "$payload" >"$PAYLOAD_FILE"
    docker cp "$PAYLOAD_FILE" "$container:/tmp/dur3994-payload.json" >/dev/null
    docker exec "$container" curl -fsS -X "$method" "$API_BASE$path" \
      -H 'Content-Type: application/json' --data @/tmp/dur3994-payload.json
  else
    docker exec "$container" curl -fsS -X "$method" "$API_BASE$path"
  fi
}

json_field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

wait_for_health() {
  local i container
  for i in $(seq 1 90); do
    container="$(server_container)"
    if [ -n "$container" ] && docker exec "$container" curl -fsS "$API_BASE/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

create_company() { # name -> id
  api_call POST /api/companies "$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1]}))' "$1")" | json_field id
}

create_probe_agent() { # company_id, name, report_path, other_company_dir, [extra_env_json] -> agent id
  local extra="${5:-}"
  [ -n "$extra" ] || extra='{}'
  api_call POST /api/companies/"$1"/agents "$(
    python3 -c 'import json,sys
name, report, other, probe, stages, extra = sys.argv[1:7]
env = {"PROBE_REPORT": report, "PROBE_OTHER_COMPANY_DIR": other, "PROBE_ENFORCED_STAGES": stages}
env.update(json.loads(extra))
print(json.dumps({
    "name": name,
    "role": "general",
    "adapterType": "process",
    "adapterConfig": {"command": "sh", "args": [probe], "cwd": "/tmp", "env": env, "timeoutSec": 120},
}))' "$2" "$3" "$4" "$PROBE_PATH" "$ENFORCED_STAGES" "$extra"
  )" | json_field id
}

run_heartbeat() { # agent_id, log_file
  local container
  container="$(server_container)"
  docker exec "$container" sh -lc \
    "$CLI_CMD heartbeat run --agent-id $1 --api-base $API_BASE --source on_demand --trigger manual --timeout-ms 180000" \
    >"$2" 2>&1 || true
}

read_report() { # path-in-container -> report text (names and paths only)
  docker exec "$(server_container)" cat "$1" 2>/dev/null
}

# c. The .dockerignore rule, proven on a throwaway context (no image pull).
check_dockerignore() {
  local ctx="$WORK_DIR/ctx" out_with="$WORK_DIR/out-with" out_without="$WORK_DIR/out-without" df="$WORK_DIR/Ctx.Dockerfile"
  mkdir -p "$ctx/docker" "$ctx/sub"
  printf 'DECOY=%s\n' "$(canary 8)" >"$ctx/docker/.env"
  printf 'DECOY=%s\n' "$(canary 8)" >"$ctx/.env"
  printf 'DECOY=%s\n' "$(canary 8)" >"$ctx/sub/.env.local"
  printf 'EXAMPLE=\n' >"$ctx/docker/.env.example"
  printf 'FROM scratch\nCOPY . /ctx/\n' >"$df"

  if ! docker build -q -f "$df" --output "type=local,dest=$out_without" "$ctx" >/dev/null 2>"$LOG_DIR/dockerignore-control.log"; then
    fail "negative control (c): throwaway build without .dockerignore did not run"
    return
  fi
  if [ -e "$out_without/ctx/docker/.env" ]; then
    log "PASS negative control (c): without .dockerignore the build context carries docker/.env"
  else
    fail "negative control (c): without .dockerignore docker/.env was still absent -- the check cannot see a leak"
  fi

  cp "$REPO_ROOT/.dockerignore" "$ctx/.dockerignore"
  if ! docker build -q -f "$df" --output "type=local,dest=$out_with" "$ctx" >/dev/null 2>"$LOG_DIR/dockerignore-with.log"; then
    fail "throwaway build with the repo .dockerignore did not run"
    return
  fi
  local p
  for p in docker/.env .env sub/.env.local; do
    if [ -e "$out_with/ctx/$p" ]; then fail "LEAK 0 build-context $p (the repo .dockerignore lets it into an image)"; fi
  done
  if [ ! -e "$out_with/ctx/docker/.env.example" ]; then
    fail "the repo .dockerignore also dropped docker/.env.example (example files must stay)"
  fi
  [ "$FAIL" -eq 0 ] && log "PASS 0 build-context: .env files stay out of the image, examples stay in"
}

count_lines() { # prefix, text -> count
  printf '%s\n' "$2" | grep -c "^$1 " || true
}

main() {
  command -v openssl >/dev/null || { log "openssl is required"; exit 2; }

  log "negative control (c) + .dockerignore check"
  check_dockerignore

  log "writing canary keys to docker/.env (the file production keeps its keys in)"
  local master_key
  master_key="DUR3994CANARY$(openssl rand -hex 10 | cut -c1-19)" # exactly 32 characters
  {
    echo "# DUR-3994 acceptance run: random decoy values only. Removed on exit."
    echo "BETTER_AUTH_SECRET=$(canary)"
    echo "PAPERCLIP_PUBLIC_URL=$API_BASE"
    echo "ISOLATION_CANARY_DB_PASSWORD=$(canary)"
    echo "PAPERCLIP_AGENT_JWT_SECRET=$(canary)"
    echo "PAPERCLIP_SECRETS_MASTER_KEY=$master_key"
    echo "PAPERCLIP_SERVER_ANTHROPIC_API_KEY=$(canary)"
    echo "DUR3994_ONLY_IN_ENV_FILE=$(canary)"
  } >"$DOCKER_ENV_FILE"
  chmod 600 "$DOCKER_ENV_FILE"

  log "building and booting the stack (project=$COMPOSE_PROJECT_NAME)"
  if ! "${COMPOSE[@]}" up -d --build >"$LOG_DIR/compose-up.log" 2>&1; then
    tail -50 "$LOG_DIR/compose-up.log" >&2
    fail "compose up failed"
    return 1
  fi
  if ! wait_for_health; then
    fail "server never became healthy"
    return 1
  fi

  local container
  container="$(server_container)"

  log "company B: a project folder with a canary file in it"
  local company_b other_dir
  company_b="$(create_company "DUR-3994 isolation B")"
  other_dir="/paperclip/instances/default/projects/$company_b"
  docker exec -u node -e "B_CANARY=$(canary)" -e "B_DIR=$other_dir" "$container" \
    sh -c 'mkdir -p "$B_DIR" && printf "%s\n" "$B_CANARY" >"$B_DIR/notes.txt"'

  log "company A: probe agent + control agent"
  local company_a probe_agent control_agent
  company_a="$(create_company "DUR-3994 isolation A")"
  probe_agent="$(create_probe_agent "$company_a" "isolation-probe" /tmp/dur3994-probe-report.txt "$other_dir")"
  control_agent="$(create_probe_agent "$company_a" "isolation-control" /tmp/dur3994-control-report.txt "$other_dir" \
    "$(python3 -c 'import json,sys;print(json.dumps({"CONTROL_PLANTED": sys.argv[1]}))' "$(canary)")")"
  if [ -z "$probe_agent" ] || [ -z "$control_agent" ]; then
    fail "could not create the probe agents"
    return 1
  fi

  log "running the probe as an agent (real heartbeat -> runChildProcess)"
  run_heartbeat "$probe_agent" "$LOG_DIR/probe-heartbeat.log"
  local report
  report="$(read_report /tmp/dur3994-probe-report.txt)"
  if [ -z "$report" ]; then
    fail "the probe agent produced no report (see probe-heartbeat.log)"
  else
    printf '%s\n' "$report" >"$LOG_DIR/probe-report.txt"
    log "probe report (names and paths only):"
    printf '    %s\n' "$report" >&2
    if [ "$(count_lines LEAK "$report")" -ne 0 ]; then
      fail "the agent can reach something a switched-on stage should have closed (LEAK lines above)"
    fi
    if [ "$(count_lines PASS "$report")" -eq 0 ] || ! printf '%s\n' "$report" | grep -q '^SUMMARY '; then
      fail "the probe report is incomplete"
    fi
    for check in env-names env-marker image-env-file; do
      if ! printf '%s\n' "$report" | grep -q "^PASS 0 $check "; then
        fail "stage 0 check '$check' did not pass"
      fi
    done
  fi

  log "negative control (b): an agent whose settings carry a canary must be caught"
  run_heartbeat "$control_agent" "$LOG_DIR/control-heartbeat.log"
  local control_report
  control_report="$(read_report /tmp/dur3994-control-report.txt)"
  printf '%s\n' "$control_report" >"$LOG_DIR/control-report.txt"
  if printf '%s\n' "$control_report" | grep -q '^LEAK 0 env-marker CONTROL_PLANTED$'; then
    log "PASS negative control (b): the probe caught the planted canary"
  else
    fail "negative control (b): the probe did not catch a canary planted in the agent's own env"
  fi

  log "negative control (a): the container's full env (what agents inherited before Stage 0) must show LEAK"
  local unfixed_report
  unfixed_report="$(docker exec -u node -e PROBE_ENFORCED_STAGES=0 "$container" sh "$PROBE_PATH" 2>/dev/null || true)"
  printf '%s\n' "$unfixed_report" >"$LOG_DIR/unfixed-env-report.txt"
  if printf '%s\n' "$unfixed_report" | grep -q '^LEAK 0 env-names BETTER_AUTH_SECRET$' \
    && printf '%s\n' "$unfixed_report" | grep -q '^LEAK 0 env-marker DATABASE_URL$'; then
    log "PASS negative control (a): the unfixed environment shows LEAK"
  else
    fail "negative control (a): the probe did not flag the unfixed environment"
  fi

  if [ "$FAIL" -eq 0 ]; then
    log "PASS: no stage-$ENFORCED_STAGES leak; later stages reported as KNOWN_GAP ($(count_lines KNOWN_GAP "$report") line(s))"
  fi
  return "$FAIL"
}

main
exit $?
