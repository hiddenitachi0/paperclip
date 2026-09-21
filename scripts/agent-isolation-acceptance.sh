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
# (default "0 1"). Checks for later stages are printed as KNOWN_GAP and do not
# fail the run; each later stage adds its number here when it ships.
#
# Stage 1 (the server keeps its keys out of reach) adds:
#   - the probe's server checks: /proc/1/environ, every other readable
#     /proc/*/environ and /proc/*/cmdline, /proc/1/fd must be closed to
#     agents (the server runs non-dumpable from an unreadable copy of Node;
#     reading its pipes through /proc/1/fd once froze it), /proc/1/mem, yama
#     ptrace_scope, and `kill -USR1 1` must not open a debugger on
#     127.0.0.1:9229; the script then checks the server still answers
#     /api/health after the probe and after its own `kill -USR1 1` as node;
#   - a real backup through the server while a spy in front of pg_dump
#     records whether its command line or environment carries a canary; the
#     backup must still be a pg_dump backup with today's file name, in
#     today's folder, and restore with psql into a fresh database;
#   - every file the entrypoint runs as root (and each folder above it) is
#     root-owned and not writable by `node`, so an agent cannot plant code
#     that root runs at the next container start;
#   - ISOLATION_SECRETS_MODE=env (keys in the container settings, as
#     production today) or file (keys only in a root-only secrets file,
#     docker/docker-compose.secrets.yml, as after Stage 3).
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
SECRETS_MODE="${ISOLATION_SECRETS_MODE:-env}"
case "$SECRETS_MODE" in env|file) ;; *) echo "ISOLATION_SECRETS_MODE must be env or file" >&2; exit 2 ;; esac
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$DOCKER_ENV_FILE" \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.ci-isolation-test.yml)
if [ "$SECRETS_MODE" = file ]; then
  COMPOSE+=(-f docker/docker-compose.secrets.yml)
fi

ENFORCED_STAGES="${ISOLATION_ENFORCED_STAGES:-0 1}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-isolation-acceptance.XXXXXX")"
SERVER_SECRETS_FILE="$WORK_DIR/server-secrets.env"
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

# Nothing in this script may hang silently (a stuck `docker exec curl` once
# ran into the job's 45-minute limit with no clue why). Every docker call goes
# through tdocker with a time limit, every curl has --max-time, and a stuck
# step turns into a FAIL with diagnostics.
tdocker() { # seconds, docker args...
  local secs="$1"
  shift
  timeout -k 10 "$secs" docker "$@"
}
tcompose() { # seconds, compose args...
  local secs="$1"
  shift
  timeout -k 10 "$secs" "${COMPOSE[@]}" "$@"
}

# Every canary carries the marker, so this hides any value that a log line
# might carry (the marker is split so this line itself never contains it).
REDACT_MARK="DUR3994""CANARY"
redact() { sed -E "s/${REDACT_MARK}[A-Za-z0-9._~+\/=-]*/<canary-redacted>/g"; }

cleanup() {
  if [ "$FAIL" -ne 0 ]; then
    tcompose 60 logs --no-color --tail 300 server 2>&1 | redact >"$LOG_DIR/server.log" || true
  fi
  log "cleanup: tearing down compose stack"
  tcompose 180 down -v --remove-orphans >/dev/null 2>&1 || true
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

server_container() { tcompose 30 ps -q server; }

API_TIMEOUT=120 # seconds for one API call

api_call() { # method, path, [json] -> response body
  local method="$1" path="$2" payload="${3:-}" container rc
  container="$(server_container)"
  if [ -n "$payload" ]; then
    printf '%s' "$payload" >"$PAYLOAD_FILE"
    tdocker 30 cp "$PAYLOAD_FILE" "$container:/tmp/dur3994-payload.json" >/dev/null
    tdocker $((API_TIMEOUT + 30)) exec "$container" curl -fsS --max-time "$API_TIMEOUT" -X "$method" "$API_BASE$path" \
      -H 'Content-Type: application/json' --data @/tmp/dur3994-payload.json
    rc=$?
  else
    tdocker $((API_TIMEOUT + 30)) exec "$container" curl -fsS --max-time "$API_TIMEOUT" -X "$method" "$API_BASE$path"
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    log "API call $method $path failed or timed out (exit $rc)"
  fi
  return "$rc"
}

# Bounded facts about the server, for the job log. Never prints a value:
# process status fields, container state, whether the port accepts a
# connection, and the last server log lines with every canary redacted.
server_diagnostics() { # reason
  local container
  log "diagnostics ($1):"
  container="$(server_container 2>/dev/null)"
  if [ -z "$container" ]; then
    log "  no server container found"
    return 0
  fi
  log "  container: $(tdocker 15 inspect --format '{{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' "$container" 2>&1 | head -1)"
  tdocker 15 exec -u 0 "$container" sh -c '
    grep -E "^(Name|State|Uid|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):" /proc/1/status
    printf "wchan:\t%s\n" "$(cat /proc/1/wchan 2>/dev/null)"
    printf "exe:\t%s\n" "$(readlink /proc/1/exe 2>/dev/null)"
    printf "threads:\t"; for t in /proc/1/task/*; do printf "%s " "$(cat "$t/wchan" 2>/dev/null)"; done; echo
  ' 2>&1 | head -20 | redact | sed 's/^/    pid1 /' >&2 || log "  (could not read /proc/1/status within 15s)"
  if tdocker 15 exec "$container" timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/3100' >/dev/null 2>&1; then
    log "  port 3100 accepts connections"
  else
    log "  port 3100 does NOT accept connections (or the check timed out)"
  fi
  log "  processes (pid name state):"
  tdocker 15 exec -u 0 "$container" sh -c '
    for d in /proc/[0-9]*; do
      printf "%s %s %s\n" "${d#/proc/}" "$(cat "$d/comm" 2>/dev/null)" "$(sed -n "s/^State:[[:space:]]*//p" "$d/status" 2>/dev/null)"
    done' 2>&1 | head -40 | redact | sed 's/^/    /' >&2 || true
  log "  last 80 server log lines (canaries redacted):"
  tcompose 30 logs --no-color --tail 80 server 2>&1 | redact | sed 's/^/    /' >&2 || true
}

server_health() { # -> 0 if /api/health answers within 10s
  local container
  container="$(server_container)"
  [ -n "$container" ] && tdocker 25 exec "$container" curl -fsS --max-time 10 "$API_BASE/api/health" >/dev/null 2>&1
}

require_health() { # context -> 0 if healthy; else FAIL with diagnostics
  if server_health; then
    log "PASS the server answers /api/health ($1)"
    return 0
  fi
  server_diagnostics "no /api/health answer $1"
  fail "the server did not answer /api/health within 10s ($1)"
  return 1
}

json_field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

wait_for_health() { # up to 5 minutes in total
  local container deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    container="$(server_container)"
    if [ -n "$container" ] && tdocker 25 exec "$container" curl -fsS --max-time 10 "$API_BASE/api/health" >/dev/null 2>&1; then
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
  local container rc started
  container="$(server_container)"
  started=$SECONDS
  # The CLI's own limit is 180 s; 240 s here catches a CLI that is stuck.
  tdocker 240 exec "$container" sh -lc \
    "$CLI_CMD heartbeat run --agent-id $1 --api-base $API_BASE --source on_demand --trigger manual --timeout-ms 180000" \
    >"$2" 2>&1
  rc=$?
  log "heartbeat finished in $((SECONDS - started)) s (exit $rc)"
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    server_diagnostics "heartbeat run did not finish within 240 s"
    fail "the heartbeat run for agent $1 did not finish within 240 s"
  fi
  return 0
}

read_report() { # path-in-container -> report text (names and paths only)
  tdocker 30 exec "$(server_container)" cat "$1" 2>/dev/null
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

  if ! tdocker 300 build -q -f "$df" --output "type=local,dest=$out_without" "$ctx" >/dev/null 2>"$LOG_DIR/dockerignore-control.log"; then
    fail "negative control (c): throwaway build without .dockerignore did not run"
    return
  fi
  if [ -e "$out_without/ctx/docker/.env" ]; then
    log "PASS negative control (c): without .dockerignore the build context carries docker/.env"
  else
    fail "negative control (c): without .dockerignore docker/.env was still absent -- the check cannot see a leak"
  fi

  cp "$REPO_ROOT/.dockerignore" "$ctx/.dockerignore"
  if ! tdocker 300 build -q -f "$df" --output "type=local,dest=$out_with" "$ctx" >/dev/null 2>"$LOG_DIR/dockerignore-with.log"; then
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

stage_enforced() { # stage -> 0 if enforced
  case " $(printf '%s' "$ENFORCED_STAGES" | tr ',' ' ') " in *" $1 "*) return 0 ;; esac
  return 1
}

# Stage 1: nothing the entrypoint runs as ROOT may be writable by `node`
# (every agent runs as node). Otherwise an agent could plant code there, make
# the container restart (`kill -TERM 1`), and have it run as root. Checked as
# the node user, in the built image: each file and every folder above it must
# be owned by root and not writable.
check_root_run_files() {
  local container="$1" out
  out="$(tdocker 60 exec -u node "$container" sh -c '
    bad=0
    for f in /usr/local/bin/docker-entrypoint.sh /usr/local/lib/paperclip/server-secrets-handoff.sh \
             /usr/local/share/paperclip/server-secret-names /usr/local/lib/paperclip/node /bin/sh /usr/sbin/gosu; do
      real="$(readlink -f "$f" 2>/dev/null || echo "$f")"
      if [ ! -e "$real" ]; then echo "MISSING $f"; bad=1; continue; fi
      p="$real"
      while :; do
        if [ -w "$p" ] || [ "$(stat -c %u "$p")" != 0 ]; then echo "WRITABLE $p"; bad=1; fi
        [ "$p" = / ] && break
        p="$(dirname "$p")"
      done
    done
    if grep -v "^[[:space:]]*#" /usr/local/bin/docker-entrypoint.sh | grep -q "/app/server/dist/server-secrets\|node --import"; then
      echo "ENTRYPOINT-RUNS-APP-CODE"; bad=1
    fi
    [ "$bad" = 0 ] && echo OK
  ' 2>&1)"
  printf '%s\n' "$out" >"$LOG_DIR/root-run-files.txt"
  if [ "$out" = OK ]; then
    log "PASS 1 root-run-files: everything the entrypoint runs as root is root-owned and not writable by agents"
  else
    fail "LEAK 1 root-run-files: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}

# Stage 1: a real backup through the server, with a spy in front of pg_dump
# that records (PASS/LEAK only) whether pg_dump's command line or environment
# carried a canary. Then the backup must be today's kind of backup and
# restore into a fresh database with psql.
stage1_server_checks() {
  local container="$1" spy_report backup_json engine backup_file exe
  # The server must run from the unreadable copy of Node, so it is not
  # dumpable and agents cannot open its /proc/1/fd (see Dockerfile). Docker
  # gives the container's root no CAP_SYS_PTRACE, so even root cannot follow
  # /proc/1/exe of a non-dumpable process: read argv[0] from /proc/1/cmdline
  # (world-readable) and the owner of /proc/1/environ instead -- the kernel
  # shows root as the owner of a non-dumpable process's private /proc files.
  exe="$(tdocker 15 exec "$container" sh -c 'tr "\0" "\n" </proc/1/cmdline | head -1' 2>/dev/null)"
  if [ "$exe" = /usr/local/lib/paperclip/node ]; then
    log "PASS 1 server-binary: the server runs from /usr/local/lib/paperclip/node"
  else
    fail "the server runs from ${exe:-an unknown program}, not /usr/local/lib/paperclip/node"
  fi
  local proc_owner server_uid
  proc_owner="$(tdocker 15 exec "$container" stat -c %u /proc/1/environ 2>/dev/null)"
  server_uid="$(tdocker 15 exec "$container" sh -c 'sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" /proc/1/status' 2>/dev/null)"
  if [ "$proc_owner" = 0 ] && [ -n "$server_uid" ] && [ "$server_uid" != 0 ]; then
    log "PASS 1 server-nondumpable: the server runs as uid $server_uid but its private /proc files are root-only"
  else
    fail "the server is dumpable (/proc/1/environ owner ${proc_owner:-?}, server uid ${server_uid:-?})"
  fi

  # kill -USR1 from an agent (the node user) must neither open the debugger
  # nor stop or freeze the server. The probe already sent one; send another
  # directly and check the server still answers.
  log "stage 1: kill -USR1 1 as the node user, then the server must still answer"
  if ! tdocker 15 exec -u node "$container" sh -c 'kill -USR1 1' >/dev/null 2>&1; then
    fail "could not send kill -USR1 to the server as the node user (the check below would prove nothing)"
  fi
  sleep 2
  if tdocker 15 exec "$container" curl -s --max-time 2 -o /dev/null http://127.0.0.1:9229/json/version >/dev/null 2>&1; then
    fail "LEAK 1 debug-port: kill -USR1 opened Node's debugger on 127.0.0.1:9229"
  else
    log "PASS 1 debug-port (harness): no debugger after kill -USR1"
  fi
  log "  server signal state after kill -USR1: $(tdocker 15 exec -u 0 "$container" sh -c 'grep -E "^(State|ShdPnd|SigBlk):" /proc/1/status' 2>/dev/null | tr '\n\t' '  ')"
  if require_health "after kill -USR1 from the node user"; then
    log "PASS 1 sigusr1-survives: the server still answers after kill -USR1 from an agent"
  else
    fail "the server did not survive kill -USR1 from an agent"
    return
  fi

  log "stage 1: backup through the server with a pg_dump spy"
  tdocker 30 exec -u 0 -i "$container" sh -c 'cat >/usr/local/bin/dur3994-pg-dump-spy && chmod 755 /usr/local/bin/dur3994-pg-dump-spy' <<'SPY'
#!/bin/sh
pattern="$(mktemp)"
printf '%s%s\n' DUR3994 CANARY >"$pattern"
for leaf in cmdline environ; do
  if grep -qaF -f "$pattern" "/proc/$$/$leaf"; then
    echo "LEAK 1 pg-dump-$leaf" >>/tmp/dur3994-pg-dump-spy.txt
  else
    echo "PASS 1 pg-dump-$leaf" >>/tmp/dur3994-pg-dump-spy.txt
  fi
done
rm -f "$pattern"
exec pg_dump "$@"
SPY
  backup_json="$(api_call POST /api/instance/database-backups '{}')" || true
  printf '%s\n' "$backup_json" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(json.dumps({k:d.get(k) for k in ("backupFile","engine","sizeBytes","pgDumpFailureReason")}))' >"$LOG_DIR/backup-result.json" 2>/dev/null || true
  engine="$(printf '%s' "$backup_json" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("engine",""))' 2>/dev/null || true)"
  backup_file="$(printf '%s' "$backup_json" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("backupFile",""))' 2>/dev/null || true)"

  spy_report="$(tdocker 30 exec "$container" cat /tmp/dur3994-pg-dump-spy.txt 2>/dev/null || true)"
  printf '%s\n' "$spy_report" >"$LOG_DIR/pg-dump-spy.txt"
  log "pg_dump spy report: $(printf '%s' "$spy_report" | tr '\n' ' ')"
  if [ -z "$spy_report" ]; then
    fail "pg_dump never ran (the spy recorded nothing)"
  elif printf '%s\n' "$spy_report" | grep -q '^LEAK '; then
    fail "the backup's pg_dump carried a canary on its command line or in its environment"
  fi

  if [ "$engine" != "pg_dump" ]; then
    fail "the backup did not use pg_dump (engine: ${engine:-none})"
  fi
  case "$backup_file" in
    /paperclip/instances/default/data/backups/paperclip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].sql.gz)
      log "PASS 1 backup-name: $backup_file" ;;
    *) fail "the backup file name or folder changed: ${backup_file:-none}" ; return ;;
  esac

  log "stage 1: restoring that backup with psql into a fresh database"
  local db_container local_copy
  db_container="$(tcompose 30 ps -q db)"
  local_copy="$WORK_DIR/restore-check.sql.gz"
  if ! tdocker 120 cp "$container:$backup_file" "$local_copy" >/dev/null 2>&1; then
    fail "could not copy the backup out of the container"
    return
  fi
  tdocker 60 exec "$db_container" createdb -U paperclip dur3994_restore_check >/dev/null 2>&1 || true
  if ! gunzip -c "$local_copy" | tdocker 300 exec -i "$db_container" psql -U paperclip -d dur3994_restore_check \
    -v ON_ERROR_STOP=1 -q >"$LOG_DIR/restore.log" 2>&1; then
    fail "the backup did not restore with psql (see restore.log)"
    return
  fi
  local source_count restored_count
  source_count="$(tdocker 60 exec "$db_container" psql -U paperclip -d paperclip -tAc 'SELECT count(*) FROM companies' 2>/dev/null | tr -d '[:space:]')"
  restored_count="$(tdocker 60 exec "$db_container" psql -U paperclip -d dur3994_restore_check -tAc 'SELECT count(*) FROM companies' 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$source_count" ] && [ "$source_count" = "$restored_count" ]; then
    log "PASS 1 backup-restore: $restored_count companies restored"
  else
    fail "the restored database does not match (companies: source=${source_count:-?} restored=${restored_count:-?})"
  fi
}

count_lines() { # prefix, text -> count
  printf '%s\n' "$2" | grep -c "^$1 " || true
}

main() {
  command -v openssl >/dev/null || { log "openssl is required"; exit 2; }

  log "negative control (c) + .dockerignore check"
  check_dockerignore

  log "writing canary keys to docker/.env (the file production keeps its keys in; secrets mode: $SECRETS_MODE)"
  local master_key db_password auth_secret jwt_secret anthropic_key
  master_key="DUR3994CANARY$(openssl rand -hex 10 | cut -c1-19)" # exactly 32 characters
  db_password="$(canary)"
  auth_secret="$(canary)"
  jwt_secret="$(canary)"
  anthropic_key="$(canary)"
  {
    echo "# DUR-3994 acceptance run: random decoy values only. Removed on exit."
    echo "BETTER_AUTH_SECRET=$auth_secret"
    echo "PAPERCLIP_PUBLIC_URL=$API_BASE"
    echo "ISOLATION_CANARY_DB_PASSWORD=$db_password"
    echo "PAPERCLIP_AGENT_JWT_SECRET=$jwt_secret"
    echo "PAPERCLIP_SECRETS_MASTER_KEY=$master_key"
    echo "PAPERCLIP_SERVER_ANTHROPIC_API_KEY=$anthropic_key"
    echo "DUR3994_ONLY_IN_ENV_FILE=$(canary)"
    if [ "$SECRETS_MODE" = file ]; then
      echo "PAPERCLIP_SERVER_SECRETS_FILE=$SERVER_SECRETS_FILE"
    fi
  } >"$DOCKER_ENV_FILE"
  chmod 600 "$DOCKER_ENV_FILE"
  if [ "$SECRETS_MODE" = file ]; then
    # Same keys, but in the root-only secrets file; the overlay blanks them
    # in the container settings.
    local db_url="postgres://paperclip:$db_password@db:5432/paperclip"
    {
      echo "BETTER_AUTH_SECRET=$auth_secret"
      echo "DATABASE_URL=$db_url"
      echo "DATABASE_BYPASS_URL=$db_url"
      echo "DATABASE_MIGRATION_URL=$db_url"
      echo "PAPERCLIP_AGENT_JWT_SECRET=$jwt_secret"
      echo "PAPERCLIP_SECRETS_MASTER_KEY=$master_key"
      echo "PAPERCLIP_SERVER_ANTHROPIC_API_KEY=$anthropic_key"
    } >"$SERVER_SECRETS_FILE"
    chmod 400 "$SERVER_SECRETS_FILE"
  fi

  log "building and booting the stack (project=$COMPOSE_PROJECT_NAME)"
  if ! tcompose 1500 up -d --build >"$LOG_DIR/compose-up.log" 2>&1; then
    tail -50 "$LOG_DIR/compose-up.log" >&2
    fail "compose up failed"
    return 1
  fi
  if ! wait_for_health; then
    server_diagnostics "server never became healthy"
    fail "server never became healthy"
    return 1
  fi

  local container
  container="$(server_container)"

  log "company B: a project folder with a canary file in it"
  local company_b other_dir
  company_b="$(create_company "DUR-3994 isolation B")"
  other_dir="/paperclip/instances/default/projects/$company_b"
  tdocker 30 exec -u node -e "B_CANARY=$(canary)" -e "B_DIR=$other_dir" "$container" \
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
    if stage_enforced 1; then
      for check in proc-environ proc-other server-fd server-mem ptrace-scope debug-port; do
        if ! printf '%s\n' "$report" | grep -q "^PASS 1 $check "; then
          fail "stage 1 check '$check' did not pass"
        fi
      done
      if [ "$SECRETS_MODE" = file ] && ! printf '%s\n' "$report" | grep -q '^PASS 1 secrets-file '; then
        fail "stage 1 check 'secrets-file' did not pass"
      fi
    fi
  fi

  # Running the probe (which also sends kill -USR1) must not stop or freeze
  # the server. Everything after this needs a working server.
  if ! require_health "after the probe agent ran"; then
    return 1
  fi

  if stage_enforced 1; then
    check_root_run_files "$container"
    stage1_server_checks "$container"
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

  if [ "$SECRETS_MODE" = env ]; then
    log "negative control (a): the container's full env (what agents inherited before Stage 0) must show LEAK"
    local unfixed_report
    # A second process started with the container's full environment -- the
    # same record /proc/1/environ held before Stage 1 -- so the probe's
    # /proc scan has something it must find.
    tdocker 30 exec -u node -d "$container" sleep 120 >/dev/null 2>&1 || true
    sleep 1
    unfixed_report="$(tdocker 120 exec -u node -e PROBE_ENFORCED_STAGES=0 -e PROBE_SKIP_SIGUSR1=1 "$container" sh "$PROBE_PATH" 2>/dev/null || true)"
    printf '%s\n' "$unfixed_report" >"$LOG_DIR/unfixed-env-report.txt"
    if printf '%s\n' "$unfixed_report" | grep -q '^LEAK 0 env-names BETTER_AUTH_SECRET$' \
      && printf '%s\n' "$unfixed_report" | grep -q '^LEAK 0 env-marker DATABASE_URL$'; then
      log "PASS negative control (a): the unfixed environment shows LEAK"
    else
      fail "negative control (a): the probe did not flag the unfixed environment"
    fi
    if printf '%s\n' "$unfixed_report" | grep -q '^KNOWN_GAP 1 proc-environ /proc/[0-9]*/environ$'; then
      log "PASS negative control (a, stage 1): the probe sees keys in a process environment record"
    else
      fail "negative control (a, stage 1): the probe's /proc scan did not see a process started with the keys"
    fi
  else
    # File mode: the container settings must not carry any key at all, and
    # the secrets file must hold them (so the checks above were looking at a
    # server that really had canary keys).
    if tdocker 30 inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | grep -qF "DUR3994CANARY"; then
      fail "LEAK 1 container-settings (docker inspect shows a key in file mode)"
    else
      log "PASS 1 container-settings: no key in the container settings (file mode)"
    fi
    if tdocker 30 exec "$container" sh -c 'grep -qF DUR3994CANARY /run/secrets/paperclip_server'; then
      log "PASS negative control (a, file mode): the server's secrets file carries the canary keys"
    else
      fail "negative control (a, file mode): the secrets file was not mounted with the canary keys"
    fi
  fi

  if [ "$FAIL" -eq 0 ]; then
    log "PASS: no stage-$ENFORCED_STAGES leak; later stages reported as KNOWN_GAP ($(count_lines KNOWN_GAP "$report") line(s))"
  fi
  return "$FAIL"
}

main
exit $?
