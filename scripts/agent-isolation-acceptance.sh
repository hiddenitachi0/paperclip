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
# (default "0 1 2"). Checks for later stages are printed as KNOWN_GAP and do not
# fail the run; each later stage adds its number here when it ships.
#
# The server is NOT the container's PID 1: docker/docker-compose.yml starts
# the container with `init: true`, so Docker's init is PID 1 (it reaps the
# helper processes agent runs leave behind) and the server is its child. The
# probe and this script both find the server by its command line
# (server_pid below) and fail loudly when they cannot.
#
# Stage 1 (the server keeps its keys out of reach) adds:
#   - the probe's server checks: /proc/<server>/environ, every other readable
#     /proc/*/environ and /proc/*/cmdline, /proc/<server>/fd must be closed
#     to agents (the server runs non-dumpable from an unreadable copy of
#     Node; reading its pipes through its /proc/<server>/fd once froze it),
#     /proc/<server>/mem, yama ptrace_scope, and `kill -USR1 <server>` must
#     not open a debugger on 127.0.0.1:9229; the script then checks the
#     server still answers /api/health after the probe and after its own
#     `kill -USR1 <server>` as node;
#   - no zombie processes after the CLI has run a few times (the heartbeat
#     runs above start the CLI, whose tsx loader left an `esbuild` helper
#     behind each time): with Node as PID 1 those were never reaped and the
#     container ran out of processes after ~16 hours ("Cannot fork");
#   - DUR-3998: the CLI command line every agent runs executes the prebuilt
#     cli/dist/index.js and never starts esbuild: no esbuild process with the
#     CLI as its parent while the heartbeat runs execute it, and `--version`
#     still answers with esbuild made unusable (as the agent user and as the
#     deploy runner's root exec; negative control g: the real tsx then fails);
#     both are also timed, for the record;
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
# Stage 2 (agents can't plant code the server will run) adds:
#   - the probe's checks that, as an agent, it cannot change anything under
#     /app (the server's program; opening a file for append must fail with
#     EACCES, and `find /app -writable` must find nothing);
#   - a real local plugin installed through the API before the probe's
#     heartbeat, so that heartbeat runs with a plugin worker loaded;
#   - the server restarted with the plugin untouched: it must load again
#     (negative control d: the check does not refuse everything);
#   - the plugin's manifest edited as the `node` user (what an agent could
#     do), the server restarted: the plugin must be refused (status error,
#     the plain "changed after it was installed" message), the edited code
#     must never have run, and the refusal must be in the Activity feed.
#
#   - review fixes: a planted $HOME/.node_modules/bufferutil is not loaded by
#     the restarted server; the server neither writes nor reads tsx's /tmp
#     cache; the deploy runner's root exec does not run /paperclip/.profile
#     (negative controls e and f prove each plant works when unguarded).
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

ENFORCED_STAGES="${ISOLATION_ENFORCED_STAGES:-0 1 2}"
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

# The server's pid inside the container (empty when there is not exactly one
# match). Never 1: the container runs under Docker's init (`init: true`), so
# the server is found by its command line -- /proc/<pid>/cmdline is readable
# by everyone, even for a non-dumpable process. The init process carries the
# same command as its own arguments, after the entrypoint's name, so that
# name tells the two apart. Same lookup as find_server_pid in
# scripts/isolation-probe.sh; keep the two in step.
server_pid() { # container -> pid, or "" (with the reason on stderr)
  local pids
  pids="$(tdocker 15 exec "$1" sh -c '
    for f in /proc/[0-9]*/cmdline; do
      pid="${f#/proc/}"; pid="${pid%/cmdline}"
      [ "$pid" = "$$" ] && continue
      args=" $(tr "\0" " " <"$f" 2>/dev/null) "
      case "$args" in
        *" server/dist/index.js "*|*" /app/server/dist/index.js "*) ;;
        *) continue ;;
      esac
      case "$args" in *"docker-entrypoint.sh "*) continue ;; esac
      printf "%s " "$pid"
    done' 2>/dev/null | tr -d '\n' | sed 's/ *$//')"
  case "$pids" in
    "") log "  no process in the container runs server/dist/index.js" ;;
    *" "*) log "  several processes run server/dist/index.js: $pids" ;;
    *) printf '%s' "$pids"; return 0 ;;
  esac
  return 1
}

# The number of zombie processes in the container ("State: Z" in
# /proc/<pid>/status, which everyone can read). Their pids and names go to
# zombies.txt in the log folder.
count_zombies() { # container -> count (empty when the container could not be asked)
  local out
  out="$(tdocker 15 exec "$1" sh -c '
    n=0
    for d in /proc/[0-9]*; do
      case "$(sed -n "s/^State:[[:space:]]*\([A-Za-z]\).*/\1/p" "$d/status" 2>/dev/null)" in
        Z) n=$((n + 1)); printf "zombie %s %s\n" "${d#/proc/}" "$(cat "$d/comm" 2>/dev/null)" ;;
      esac
    done
    echo "$n"' 2>/dev/null)" || return 1
  printf '%s\n' "$out" | grep '^zombie ' >>"$LOG_DIR/zombies.txt" || true
  printf '%s\n' "$out" | tail -1
}

# Stage 1: after the CLI has run a few times (each heartbeat run above starts
# it), the container must hold no zombie processes. tsx, the CLI's TypeScript
# loader, starts an `esbuild` helper and leaves it behind; when the CLI exits
# the helper is handed to PID 1. With Node as PID 1 they were never reaped:
# about 19 a minute, 18,641 after ~16 hours, and then "Cannot fork" -- every
# CLI call aborted and no agent could start. `init: true` in
# docker/docker-compose.yml puts Docker's init (which reaps) at PID 1. A
# helper that has only just exited may not be collected yet, so this waits a
# few seconds for the count to reach 0 before calling it a failure; a zombie
# that PID 1 never collects stays whatever the wait.
check_no_zombies() { # container
  local container="$1" zombies="" i pid1
  pid1="$(tdocker 15 exec "$container" cat /proc/1/comm 2>/dev/null | tr -d '[:space:]')"
  : >"$LOG_DIR/zombies.txt"
  for i in 1 2 3 4 5; do
    zombies="$(count_zombies "$container")"
    [ "$zombies" = 0 ] && break
    sleep 2
  done
  if [ "$zombies" = 0 ]; then
    log "PASS 1 no-zombies: 0 zombie processes after the CLI runs (PID 1 is ${pid1:-unknown})"
  else
    log "  zombies seen (pid name), last count first:"
    tail -20 "$LOG_DIR/zombies.txt" | sed 's/^/    /' >&2
    fail "LEAK 1 no-zombies: ${zombies:-an unknown number of} zombie process(es) left in the container after the CLI runs (PID 1 is ${pid1:-unknown}; a proper init must reap them -- docker-compose.yml init: true)"
  fi
}

# DUR-3998: the CLI is prebuilt into the image (cli/dist/index.js, run by the
# shim installed as cli/node_modules/tsx/dist/cli.mjs). The command line every
# agent runs (CLI_CMD) must run that bundle and never compile the CLI:
#   (a) sampled for real while the heartbeat runs execute the CLI: every
#       `esbuild` process in the container is recorded with its parent's
#       command line, and one whose parent is the CLI means the CLI was
#       compiled (the server's own tsx helper is expected and ignored);
#   (b) proved directly: with ESBUILD_BINARY_PATH pointing at a program that
#       is not esbuild, compiling TypeScript fails outright, so `--version`
#       only answers when the prebuilt program ran -- checked as the agent
#       user and with the deploy runner's root exec settings. Negative control
#       (g): the real tsx (kept beside the shim as tsx-cli.mjs) fails the same
#       way, so (b) proves something.
# Both paths are timed too, for the record (INFO line, never a failure).
ESBUILD_WATCH_FILE=/tmp/dur3998-esbuild-seen.txt
ESBUILD_WATCH_STOP=/tmp/dur3998-esbuild-watch-stop
REAL_TSX_CLI_CMD='cd /app && node cli/node_modules/tsx/dist/tsx-cli.mjs cli/src/index.ts'

start_esbuild_watch() { # container
  tdocker 15 exec -u 0 "$1" sh -c 'rm -f "$1" "$2" && : >"$1"' _ "$ESBUILD_WATCH_FILE" "$ESBUILD_WATCH_STOP" >/dev/null 2>&1 || true
  tdocker 15 exec -d -u 0 "$1" sh -c '
    seen="$1"; stop="$2"; end=$(( $(date +%s) + 900 ))
    while [ ! -e "$stop" ] && [ "$(date +%s)" -lt "$end" ]; do
      for d in /proc/[0-9]*; do
        [ "$(cat "$d/comm" 2>/dev/null)" = esbuild ] || continue
        ppid="$(sed -n "s/^PPid:[[:space:]]*//p" "$d/status" 2>/dev/null)"
        printf "%s %s %s\n" "${d#/proc/}" "${ppid:-?}" "$(tr "\0" " " <"/proc/${ppid:-0}/cmdline" 2>/dev/null)" >>"$seen"
      done
      sleep 0.2
    done' _ "$ESBUILD_WATCH_FILE" "$ESBUILD_WATCH_STOP" >/dev/null 2>&1 || true
}

time_cli_ms() { # container, command -> milliseconds on stdout (nothing when the command failed)
  tdocker 120 exec -u node "$1" sh -c 's=$(date +%s%N); { '"$2"'; } >/dev/null 2>&1 || exit 1; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))' 2>/dev/null
}

check_cli_prebuilt() { # container
  local container="$1" seen cli_started version rc ms_prebuilt ms_tsx
  tdocker 15 exec -u 0 "$container" sh -c 'touch "$1"' _ "$ESBUILD_WATCH_STOP" >/dev/null 2>&1 || true
  seen="$(tdocker 15 exec "$container" sh -c 'sort -u "$1" 2>/dev/null' _ "$ESBUILD_WATCH_FILE" || true)"
  printf '%s\n' "$seen" >"$LOG_DIR/esbuild-processes.txt"
  cli_started="$(printf '%s\n' "$seen" | grep -E 'cli/src/index\.ts|cli/dist/index\.js|tsx/dist/cli\.mjs' || true)"
  if [ -n "$cli_started" ]; then
    log "  esbuild processes started for the CLI (pid ppid parent-command):"
    printf '%s\n' "$cli_started" | sed 's/^/    /' >&2
    fail "LEAK 1 cli-no-esbuild: the CLI started an esbuild helper while the heartbeat runs executed it (it is meant to run the prebuilt cli/dist/index.js)"
  else
    log "PASS 1 cli-no-esbuild: no esbuild process was started for the CLI during the heartbeat runs ($(printf '%s\n' "$seen" | grep -c . || true) esbuild process(es) seen, none with the CLI as parent)"
  fi

  version="$(tdocker 60 exec -u node -e ESBUILD_BINARY_PATH=/bin/false "$container" sh -c "$CLI_CMD --version" 2>"$LOG_DIR/cli-prebuilt-agent.err")"
  rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'; then
    log "PASS 1 cli-prebuilt: as the agent user, the CLI command line answered --version ($version) with esbuild unusable, so it ran the prebuilt program"
  else
    fail "LEAK 1 cli-prebuilt: as the agent user, the CLI command line did not answer --version with esbuild unusable (exit $rc): it still compiles the CLI (see cli-prebuilt-agent.err)"
  fi
  local CLI_EXEC_ENV=()
  eval "$(grep '^CLI_EXEC_ENV=' "$REPO_ROOT/scripts/deploy-runner.sh")"
  version="$(tdocker 60 exec "${CLI_EXEC_ENV[@]}" -e ESBUILD_BINARY_PATH=/bin/false "$container" sh -c "$CLI_CMD --version" 2>"$LOG_DIR/cli-prebuilt-runner.err")"
  rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'; then
    log "PASS 1 cli-prebuilt-runner: the deploy runner's root exec of the CLI answered --version ($version) with esbuild unusable"
  else
    fail "LEAK 1 cli-prebuilt-runner: the deploy runner's root exec of the CLI did not answer --version with esbuild unusable (exit $rc; see cli-prebuilt-runner.err)"
  fi
  if tdocker 120 exec -u node -e ESBUILD_BINARY_PATH=/bin/false "$container" sh -c "$REAL_TSX_CLI_CMD --version" >/dev/null 2>&1; then
    fail "negative control (g): compiling the CLI with the real tsx still worked with esbuild unusable, so the cli-prebuilt checks above prove nothing"
  else
    log "PASS negative control (g): with esbuild unusable, compiling the CLI with the real tsx fails"
  fi

  ms_prebuilt="$(time_cli_ms "$container" "$CLI_CMD --version" || true)"
  ms_tsx="$(time_cli_ms "$container" "$REAL_TSX_CLI_CMD --version" || true)"
  log "INFO 1 cli-timing: paperclipai --version took ${ms_prebuilt:-?} ms prebuilt vs ${ms_tsx:-?} ms compiled by tsx (agent user, compile cache off)"
}

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
  local pid
  log "  PID 1: $(tdocker 15 exec "$container" cat /proc/1/comm 2>/dev/null | tr -d '[:space:]')"
  if pid="$(server_pid "$container")"; then
    tdocker 15 exec -u 0 -e "PID=$pid" "$container" sh -c '
      grep -E "^(Name|State|Uid|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):" "/proc/$PID/status"
      printf "wchan:\t%s\n" "$(cat "/proc/$PID/wchan" 2>/dev/null)"
      printf "exe:\t%s\n" "$(readlink "/proc/$PID/exe" 2>/dev/null)"
      printf "threads:\t"; for t in "/proc/$PID/task"/*; do printf "%s " "$(cat "$t/wchan" 2>/dev/null)"; done; echo
    ' 2>&1 | head -20 | redact | sed "s/^/    server(pid $pid) /" >&2 || log "  (could not read /proc/$pid/status within 15s)"
  else
    log "  no server process found (see above)"
  fi
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
             /usr/local/share/paperclip/server-secret-names /usr/local/lib/paperclip/node-module-guard.cjs \
             /usr/local/lib/paperclip/node /bin/sh /usr/sbin/gosu; do
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
  local container="$1" spy_report backup_json engine backup_file exe pid
  # The server is not PID 1 (Docker's init is; see server_pid). Without
  # exactly one server process none of the checks on it can run.
  if ! pid="$(server_pid "$container")"; then
    fail "server-pid: could not find the one server process by its command line (the server checks below cannot run)"
    return
  fi
  log "PASS 1 server-pid: the server is pid $pid (PID 1 is $(tdocker 15 exec "$container" cat /proc/1/comm 2>/dev/null | tr -d '[:space:]'))"
  # The server must run from the unreadable copy of Node, so it is not
  # dumpable and agents cannot open its /proc/<pid>/fd (see Dockerfile).
  # Docker gives the container's root no CAP_SYS_PTRACE, so even root cannot
  # follow /proc/<pid>/exe of a non-dumpable process: read argv[0] from
  # /proc/<pid>/cmdline (world-readable) and the owner of /proc/<pid>/environ
  # instead -- the kernel shows root as the owner of a non-dumpable process's
  # private /proc files.
  exe="$(tdocker 15 exec "$container" sh -c "tr '\\0' '\\n' </proc/$pid/cmdline | head -1" 2>/dev/null)"
  if [ "$exe" = /usr/local/lib/paperclip/node ]; then
    log "PASS 1 server-binary: the server runs from /usr/local/lib/paperclip/node"
  else
    fail "the server runs from ${exe:-an unknown program}, not /usr/local/lib/paperclip/node"
  fi
  local proc_owner server_uid
  proc_owner="$(tdocker 15 exec "$container" stat -c %u "/proc/$pid/environ" 2>/dev/null)"
  server_uid="$(tdocker 15 exec "$container" sh -c "sed -n 's/^Uid:[[:space:]]*\\([0-9]*\\).*/\\1/p' /proc/$pid/status" 2>/dev/null)"
  if [ "$proc_owner" = 0 ] && [ -n "$server_uid" ] && [ "$server_uid" != 0 ]; then
    log "PASS 1 server-nondumpable: the server runs as uid $server_uid but its private /proc files are root-only"
  else
    fail "the server is dumpable (/proc/$pid/environ owner ${proc_owner:-?}, server uid ${server_uid:-?})"
  fi

  # kill -USR1 from an agent (the node user) must neither open the debugger
  # nor stop or freeze the server. The probe already sent one; send another
  # directly and check the server still answers.
  log "stage 1: kill -USR1 $pid (the server) as the node user, then the server must still answer"
  if ! tdocker 15 exec -u node "$container" sh -c "kill -USR1 $pid" >/dev/null 2>&1; then
    fail "could not send kill -USR1 to the server as the node user (the check below would prove nothing)"
  fi
  sleep 2
  if tdocker 15 exec "$container" curl -s --max-time 2 -o /dev/null http://127.0.0.1:9229/json/version >/dev/null 2>&1; then
    fail "LEAK 1 debug-port: kill -USR1 opened Node's debugger on 127.0.0.1:9229"
  else
    log "PASS 1 debug-port (harness): no debugger after kill -USR1"
  fi
  log "  server signal state after kill -USR1: $(tdocker 15 exec -u 0 "$container" sh -c "grep -E '^(State|ShdPnd|SigBlk):' /proc/$pid/status" 2>/dev/null | tr '\n\t' '  ')"
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

db_query() { # sql -> single value (trimmed)
  docker exec "$("${COMPOSE[@]}" ps -q db)" psql -U paperclip -d paperclip -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

TEST_PLUGIN_DIR=/paperclip/dur3994-test-plugin
TEST_PLUGIN_KEY=dur3994.test-plugin
TEST_PLUGIN_MARKER=/tmp/dur3994-tampered-plugin-code-ran

# Stage 2: a minimal real plugin (manifest + JSON-RPC worker), written by the
# node user into /paperclip -- the kind of folder add-ons are installed from
# -- and installed through the API like an admin would.
stage2_install_test_plugin() {
  local container="$1" install_json
  docker exec -u node -i -e "PLUGIN_DIR=$TEST_PLUGIN_DIR" "$container" sh -c '
    set -e
    mkdir -p "$PLUGIN_DIR"
    cat >"$PLUGIN_DIR/package.json" <<JSON
{"name":"dur3994-test-plugin","version":"0.0.1","type":"module","paperclipPlugin":{"manifest":"./manifest.js"}}
JSON
    cat >"$PLUGIN_DIR/manifest.js" <<JS
export default {
  id: "dur3994.test-plugin",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "DUR-3994 test plugin",
  description: "Acceptance-test plugin: proves edited add-on code is refused.",
  author: "Paperclip CI",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "./worker.cjs" },
};
JS
    cat >"$PLUGIN_DIR/worker.cjs" <<JS
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null || !msg.method) return;
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, supportedMethods: [] } });
  if (msg.method === "shutdown") { send({ jsonrpc: "2.0", id: msg.id, result: null }); setTimeout(() => process.exit(0), 50); return; }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
});
JS
  '
  install_json="$(api_call POST /api/plugins/install \
    "$(python3 -c 'import json,sys;print(json.dumps({"packageName":sys.argv[1],"isLocalPath":True}))' "$TEST_PLUGIN_DIR")")" || true
  printf '%s\n' "$install_json" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(json.dumps({k:d.get(k) for k in ("pluginKey","status","lastError")}))' >"$LOG_DIR/test-plugin-install.json" 2>/dev/null || true
  local status
  status="$(db_query "SELECT status FROM plugins WHERE plugin_key='$TEST_PLUGIN_KEY'")"
  if [ "$status" = ready ] && wait_for_test_plugin_worker; then
    log "PASS 2 plugin-install: the test plugin installed and its worker started"
  else
    fail "the test plugin did not install and start (status: ${status:-none}; see test-plugin-install.json and server.log)"
  fi
}

restart_server() {
  "${COMPOSE[@]}" restart -t 60 server >>"$LOG_DIR/compose-restart.log" 2>&1 || return 1
  wait_for_health
}

# Is the test plugin's worker process running in the container right now?
# (The pattern is assembled at run time so this check's own command line
# never matches it.)
test_plugin_worker_running() {
  docker exec "$(server_container)" sh -c '
    a=dur3994-test-plugin; b=worker.cjs
    for f in /proc/[0-9]*/cmdline; do
      [ "${f#/proc/}" = "$$/cmdline" ] && continue
      tr "\0" " " <"$f" 2>/dev/null | grep -q "$a/$b" && exit 0
    done
    exit 1
  ' >/dev/null 2>&1
}

wait_for_test_plugin_worker() { # -> 0 when the worker runs within ~60s
  local i
  for i in $(seq 1 30); do
    test_plugin_worker_running && return 0
    sleep 2
  done
  return 1
}

wait_for_plugin_status() { # expected -> 0 when reached within ~60s
  local i status
  for i in $(seq 1 30); do
    status="$(db_query "SELECT status FROM plugins WHERE plugin_key='$TEST_PLUGIN_KEY'")"
    [ "$status" = "$1" ] && return 0
    sleep 2
  done
  return 1
}

stage2_plugin_tamper_checks() {
  log "stage 2: restart with the plugin untouched -- it must load again (negative control d)"
  if ! restart_server; then
    fail "the server did not come back after a restart"
    return
  fi
  # The row says "ready" from before the restart, so the proof that it was
  # loaded again is its worker process running in the restarted container.
  if wait_for_test_plugin_worker && wait_for_plugin_status ready; then
    log "PASS negative control (d): an unchanged plugin still loads after a restart"
  else
    fail "negative control (d): the unchanged test plugin did not load after a restart (status: $(db_query "SELECT status FROM plugins WHERE plugin_key='$TEST_PLUGIN_KEY'"))"
    return
  fi

  log "stage 2: edit the plugin's manifest as the node user (what an agent can do), then restart"
  docker exec -u node -e "PLUGIN_DIR=$TEST_PLUGIN_DIR" -e "MARKER=$TEST_PLUGIN_MARKER" "$(server_container)" sh -c '
    printf "\nimport { writeFileSync } from \"node:fs\";\ntry { writeFileSync(\"%s\", \"ran\"); } catch {}\n" "$MARKER" >>"$PLUGIN_DIR/manifest.js"
  '
  if ! restart_server; then
    fail "the server did not come back after a restart with an edited plugin"
    return
  fi
  local container status last_error alerts
  container="$(server_container)"
  if wait_for_plugin_status error; then
    last_error="$(docker exec "$("${COMPOSE[@]}" ps -q db)" psql -U paperclip -d paperclip -tAc \
      "SELECT last_error FROM plugins WHERE plugin_key='$TEST_PLUGIN_KEY'" 2>/dev/null)"
    printf '%s\n' "$last_error" >"$LOG_DIR/test-plugin-last-error.txt"
    if printf '%s' "$last_error" | grep -q "changed after it was installed"; then
      log "PASS 2 plugin-tamper: the edited plugin was refused with the plain message"
    else
      fail "the edited plugin was stopped, but not by the trusted-code check (see test-plugin-last-error.txt)"
    fi
  else
    status="$(db_query "SELECT status FROM plugins WHERE plugin_key='$TEST_PLUGIN_KEY'")"
    fail "LEAK 2 plugin-tamper: the server loaded a plugin whose manifest an agent edited (status: ${status:-none})"
  fi
  if docker exec "$container" test -e "$TEST_PLUGIN_MARKER"; then
    fail "LEAK 2 plugin-tamper-ran: the edited plugin code ran inside the server"
  elif test_plugin_worker_running; then
    fail "LEAK 2 plugin-tamper-ran: the edited plugin's worker is running"
  else
    log "PASS 2 plugin-tamper-ran: the edited code never ran and its worker was not started"
  fi
  alerts="$(db_query "SELECT count(*) FROM activity_log WHERE action='instance.untrusted_code_refused'")"
  if [ "${alerts:-0}" -ge 1 ] 2>/dev/null; then
    log "PASS 2 plugin-tamper-alert: the refusal is in the Activity feed ($alerts row(s))"
  else
    fail "the refusal was not written to the Activity feed"
  fi
}

# Stage 2 (review fixes): three more ways an agent could get code run by the
# server or by root, each planted exactly as an agent would (`-u node`), with
# a negative control proving the plant itself works.
#   - Node's global module folders: $HOME/.node_modules/bufferutil, which the
#     `ws` package the server loads tries to require at start-up.
#   - tsx's compile cache in /tmp/tsx-<uid>: the server must neither write
#     nor read it (TSX_DISABLE_CACHE), so nothing new appears there across a
#     restart; and its start-up line must report the module guard active.
#   - $HOME/.profile (HOME=/paperclip in the image): the deploy runner's
#     root `docker exec` must not run it.
STAGE2_PLANT_MARKER=/tmp/dur3994-planted-module-ran
stage2_code_planting_checks() {
  local container control
  container="$(server_container)"
  docker exec -u 0 "$container" rm -f "$STAGE2_PLANT_MARKER" /tmp/dur3994-profile-ran >/dev/null 2>&1 || true

  log "stage 2: plant \$HOME/.node_modules/bufferutil as the node user (the server's and /paperclip's HOME)"
  docker exec -u node -e "MARKER=$STAGE2_PLANT_MARKER" "$container" sh -c '
    for h in /paperclip "$(getent passwd node | cut -d: -f6)"; do
      [ -n "$h" ] && [ -w "$h" ] || continue
      mkdir -p "$h/.node_modules/bufferutil"
      printf "require(\"node:fs\").writeFileSync(%s, \"ran\"); module.exports = {};\n" "\"$MARKER\"" \
        >"$h/.node_modules/bufferutil/index.js"
    done
  '
  # Negative control: an unguarded node, with the same HOME, does load it.
  docker exec -u node -w /app/server "$container" sh -c 'HOME=/paperclip node -e "try { require(\"bufferutil\") } catch {}"' >/dev/null 2>&1 || true
  if docker exec "$container" test -e "$STAGE2_PLANT_MARKER"; then
    log "PASS negative control (e): an unguarded node loads the planted ~/.node_modules/bufferutil"
  else
    fail "negative control (e): the planted ~/.node_modules/bufferutil was not loadable at all, so the check below proves nothing"
  fi
  docker exec -u 0 "$container" rm -f "$STAGE2_PLANT_MARKER"

  docker exec -u node "$container" sh -c 'mkdir -p "/tmp/tsx-$(id -u)" && touch /tmp/dur3994-before-restart' >/dev/null 2>&1 || true
  sleep 1
  if ! restart_server; then
    fail "the server did not come back after a restart with planted modules"
    return
  fi
  container="$(server_container)"
  sleep 5
  if docker exec "$container" test -e "$STAGE2_PLANT_MARKER"; then
    fail "LEAK 2 home-node-modules: the server loaded a planted \$HOME/.node_modules module"
  else
    log "PASS 2 home-node-modules: the restarted server did not load the planted module"
  fi
  local new_cache_entries
  new_cache_entries="$(docker exec -u node "$container" sh -c 'find /tmp/tsx-* -type f -newer /tmp/dur3994-before-restart 2>/dev/null | wc -l' | tr -d '[:space:]')"
  if [ "${new_cache_entries:-1}" = 0 ]; then
    log "PASS 2 tsx-cache: the server wrote nothing to tsx's /tmp cache (it does not use it)"
  else
    fail "LEAK 2 tsx-cache: the server wrote $new_cache_entries entries to tsx's /tmp cache, which agents can edit"
  fi
  if docker logs "$container" 2>&1 | grep "add-on code fingerprint check set up" | tail -1 \
      | grep -q '"resolveCheck":true' \
    && docker logs "$container" 2>&1 | grep "add-on code fingerprint check set up" | tail -1 \
      | grep -q '"tsxCacheDisabled":true'; then
    log "PASS 2 module-guard: the server reports the module guard and tsx cache-off active"
  else
    fail "the server did not report the module guard (resolve check) and TSX_DISABLE_CACHE active"
  fi

  log "stage 2: plant /paperclip/.profile as the node user; the deploy runner's root exec must not run it"
  docker exec -u node "$container" sh -c 'printf "touch /tmp/dur3994-profile-ran\n" >/paperclip/.profile'
  control="$(docker exec "$container" sh -lc 'test -e /tmp/dur3994-profile-ran && echo ran' 2>/dev/null || true)"
  docker exec -u 0 "$container" rm -f /tmp/dur3994-profile-ran
  if [ "$control" = ran ]; then
    log "PASS negative control (f): a root login shell with the image's HOME runs the planted .profile"
  else
    fail "negative control (f): the planted .profile was not run even by a login shell, so the check below proves nothing"
  fi
  local CLI_EXEC_ENV=()
  eval "$(grep '^CLI_EXEC_ENV=' "$REPO_ROOT/scripts/deploy-runner.sh")"
  docker exec "${CLI_EXEC_ENV[@]}" "$container" sh -c 'true' >/dev/null 2>&1 || true
  if docker exec "$container" test -e /tmp/dur3994-profile-ran; then
    fail "LEAK 2 runner-profile: the deploy runner's root exec ran an agent's /paperclip/.profile"
  else
    log "PASS 2 runner-profile: the deploy runner's root exec did not run the planted .profile"
  fi
  docker exec -u node "$container" rm -f /paperclip/.profile >/dev/null 2>&1 || true
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

  if stage_enforced 2; then
    log "stage 2: installing a real local plugin, so the probe's heartbeat runs with a plugin loaded"
    stage2_install_test_plugin "$container"
  fi

  # DUR-3998: record every esbuild process (and its parent) while the CLI
  # runs below; check_cli_prebuilt reads the record after the heartbeat runs.
  if stage_enforced 1; then
    start_esbuild_watch "$container"
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
    if [ "$(count_lines FAIL "$report")" -ne 0 ]; then
      fail "the probe could not do one of its checks (FAIL lines above, e.g. it did not find the server process)"
    fi
    if [ "$(count_lines PASS "$report")" -eq 0 ] || ! printf '%s\n' "$report" | grep -q '^SUMMARY '; then
      fail "the probe report is incomplete"
    fi
    for check in env-names env-marker image-env-file; do
      if ! printf '%s\n' "$report" | grep -q "^PASS 0 $check "; then
        fail "stage 0 check '$check' did not pass"
      fi
    done
    if stage_enforced 2; then
      for check in app-writable app-tree-writable; do
        if ! printf '%s\n' "$report" | grep -q "^PASS 2 $check "; then
          fail "stage 2 check '$check' did not pass"
        fi
      done
    fi
    if stage_enforced 1; then
      for check in server-pid proc-environ proc-other server-fd server-mem ptrace-scope debug-port; do
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

  # By now the CLI has run at least twice (the two heartbeat runs); before
  # DUR-3998 each run left an `esbuild` helper for PID 1 to reap. Before
  # stage 2's restarts, which would clear the evidence: nothing may be left
  # as a zombie, and (DUR-3998) the CLI must have run prebuilt, never
  # starting esbuild at all.
  if stage_enforced 1; then
    check_no_zombies "$container"
    check_cli_prebuilt "$container"
  fi

  if stage_enforced 2; then
    stage2_plugin_tamper_checks
    stage2_code_planting_checks
  fi

  if [ "$FAIL" -eq 0 ]; then
    log "PASS: no stage-$ENFORCED_STAGES leak; later stages reported as KNOWN_GAP ($(count_lines KNOWN_GAP "$report") line(s))"
  fi
  return "$FAIL"
}

main
exit $?
