#!/bin/sh
# DUR-3994: agent isolation probe.
#
# Runs AS AN AGENT (started by the Paperclip server through the real
# runChildProcess path) and reports what that agent can reach that it should
# not. It is driven by scripts/agent-isolation-acceptance.sh, which gives the
# server random decoy values ("canaries") that all contain the marker
# DUR3994CANARY, so this probe can recognise a leaked key without ever being
# told the key itself.
#
# It NEVER prints a value -- only PASS / LEAK / KNOWN_GAP, the stage, the check
# name and a path or variable name. Output lines:
#
#   PASS      <stage> <check> <detail>
#   LEAK      <stage> <check> <path-or-name>   (a stage that is switched on)
#   KNOWN_GAP <stage> <check> <path-or-name>   (a later stage, not built yet)
#   FAIL      <stage> <check> <detail>         (the probe could not do a check,
#                                              e.g. it cannot find the server;
#                                              counts as a leak whatever the
#                                              stage -- never a silent pass)
#   SUMMARY   leaks=<n> known_gaps=<n> passes=<n>
#
# The server is NOT the container's PID 1 (docker/docker-compose.yml starts
# the container with `init: true`, so Docker's init is PID 1 and the server
# is its child). The server's checks find it by its command line, see
# find_server_pid below.
#
# Environment (all optional):
#   PROBE_ENFORCED_STAGES   space/comma list of stages whose checks must pass
#                           (default "0"). Findings for other stages are
#                           reported as KNOWN_GAP and do not fail the probe.
#   PROBE_REPORT            also write the report to this file.
#   PROBE_OTHER_COMPANY_DIR a folder that belongs to ANOTHER company (stage 5).
#   PAPERCLIP_HOME          defaults to /paperclip.
#
# Exit status: 1 if any LEAK, else 0.
set -u

# Build the marker from two halves so this file's own text, and the command
# line of anything it runs, never contains the contiguous marker.
MARK_A="DUR3994"
MARK_B="CANARY"
PATTERN_FILE="$(mktemp "${TMPDIR:-/tmp}/isolation-probe-pattern.XXXXXX")" || exit 2
printf '%s%s\n' "$MARK_A" "$MARK_B" >"$PATTERN_FILE"
REPORT_TMP="$(mktemp "${TMPDIR:-/tmp}/isolation-probe-report.XXXXXX")" || exit 2
trap 'rm -f "$PATTERN_FILE" "$REPORT_TMP"' EXIT

ENFORCED=" $(printf '%s' "${PROBE_ENFORCED_STAGES:-0}" | tr ',' ' ') "
PC_HOME="${PAPERCLIP_HOME:-/paperclip}"
LEAKS=0
GAPS=0
PASSES=0

emit() { printf '%s\n' "$*" >>"$REPORT_TMP"; printf '%s\n' "$*"; }

pass() { # stage check detail
  PASSES=$((PASSES + 1))
  emit "PASS $1 $2 $3"
}

found() { # stage check path-or-name
  case "$ENFORCED" in
    *" $1 "*) LEAKS=$((LEAKS + 1)); emit "LEAK $1 $2 $3" ;;
    *) GAPS=$((GAPS + 1)); emit "KNOWN_GAP $1 $2 $3" ;;
  esac
}

broken() { # stage check detail -- the probe cannot do this check; always fails
  LEAKS=$((LEAKS + 1))
  emit "FAIL $1 $2 $3"
}

# The server's process id. It is not 1: the container runs under Docker's
# init (`init: true` in docker/docker-compose.yml), which is PID 1 and reaps
# the helper processes agent runs leave behind, and the server is its child.
# So the server is found by its command line -- /proc/<pid>/cmdline is
# readable by everyone, even for a non-dumpable process -- and never assumed
# to be 1. The init process carries the same command as its own arguments,
# after the entrypoint's name, so that name tells the two apart. Prints the
# matching pids, space separated; the caller requires exactly one.
# (scripts/agent-isolation-acceptance.sh has the same lookup for its own
# checks; keep the two in step.)
find_server_pid() {
  candidates=""
  for f in /proc/[0-9]*/cmdline; do
    pid="${f#/proc/}"
    pid="${pid%/cmdline}"
    [ "$pid" = "$$" ] && continue
    args=" $(tr '\0' ' ' <"$f" 2>/dev/null) "
    case "$args" in
      *" server/dist/index.js "*|*" /app/server/dist/index.js "*) ;;
      *) continue ;;
    esac
    case "$args" in *"docker-entrypoint.sh "*) continue ;; esac
    candidates="$candidates $pid"
  done
  printf '%s' "${candidates# }"
}

# Does the file contain the marker? Never prints the match.
file_has_marker() { grep -qaF -f "$PATTERN_FILE" "$1" 2>/dev/null; }

# --- Stage 0: the agent's own environment -----------------------------------
SERVER_KEY_NAMES="BETTER_AUTH_SECRET PAPERCLIP_AGENT_JWT_SECRET PAPERCLIP_SECRETS_MASTER_KEY PAPERCLIP_TELEMETRY_BACKEND_TOKEN PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN PAPERCLIP_DEV_SERVER_STATUS_TOKEN"
env_names_clean=1
for name in $SERVER_KEY_NAMES; do
  if env | grep -q "^${name}="; then
    found 0 env-names "$name"
    env_names_clean=0
  fi
done
for name in $(env | sed -n 's/^\(PAPERCLIP_SERVER_[A-Za-z0-9_]*\)=.*/\1/p'); do
  found 0 env-names "$name"
  env_names_clean=0
done
[ "$env_names_clean" = 1 ] && pass 0 env-names "no-server-key-names"

# Any variable whose value carries a canary, whatever it is called (catches the
# server's database address, and a key handed over under another name).
env_marker_clean=1
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u); do
  value="$(printenv "$name" 2>/dev/null || true)"
  if printf '%s' "$value" | grep -qaF -f "$PATTERN_FILE"; then
    found 0 env-marker "$name"
    env_marker_clean=0
  fi
done
[ "$env_marker_clean" = 1 ] && pass 0 env-marker "no-canary-in-env"

# --- Stage 0: environment files baked into the app image --------------------
image_env_clean=1
if [ -e /app/docker/.env ]; then
  found 0 image-env-file /app/docker/.env
  image_env_clean=0
fi
if [ -d /app ]; then
  for path in $(find /app -path '*/node_modules' -prune -o \( -name '.env' -o -name '.env.*' \) -type f ! -name '*.example' -print 2>/dev/null); do
    [ "$path" = /app/docker/.env ] && continue
    found 0 image-env-file "$path"
    image_env_clean=0
  done
fi
[ "$image_env_clean" = 1 ] && pass 0 image-env-file "no-env-file-in-app"

# --- Stage 1: the server's environment and command lines --------------------
# First find the server (see find_server_pid). Without exactly one match the
# server checks below cannot run and are not reported as PASS, and the FAIL
# line fails the probe on its own.
SERVER_PID="$(find_server_pid)"
case "$SERVER_PID" in
  "") broken 1 server-pid "no-process-runs-server/dist/index.js" ;;
  *" "*) broken 1 server-pid "several-processes-run-server/dist/index.js:$(printf '%s' "$SERVER_PID" | tr ' ' ',')"; SERVER_PID="" ;;
  *) pass 1 server-pid "/proc/$SERVER_PID" ;;
esac

if [ -n "$SERVER_PID" ]; then
  if [ -r "/proc/$SERVER_PID/environ" ] && file_has_marker "/proc/$SERVER_PID/environ"; then
    found 1 proc-environ "/proc/$SERVER_PID/environ"
  else
    pass 1 proc-environ "/proc/$SERVER_PID/environ"
  fi
fi
proc_clean=1
for dir in /proc/[0-9]*; do
  pid="${dir#/proc/}"
  [ "$pid" = "$SERVER_PID" ] && continue
  [ "$pid" = "$$" ] && continue
  for leaf in environ cmdline; do
    if [ -r "$dir/$leaf" ] && file_has_marker "$dir/$leaf"; then
      found 1 "proc-$leaf" "$dir/$leaf"
      proc_clean=0
    fi
  done
done
[ "$proc_clean" = 1 ] && pass 1 proc-other "no-canary-in-other-processes"

# The root-only secrets file (docker-compose.secrets.yml) must stay root-only.
if [ -e /run/secrets/paperclip_server ]; then
  if [ -r /run/secrets/paperclip_server ]; then
    found 1 secrets-file /run/secrets/paperclip_server
  else
    pass 1 secrets-file /run/secrets/paperclip_server
  fi
fi

# The server's open descriptors must be closed to agents. If an agent can
# list /proc/<server pid>/fd it can reopen them: read the key hand-over pipe
# if it were still open, or read from the server's internal pipes -- which
# STEALS their contents; draining libuv's signal-lock pipe that way froze the
# whole server (DUR-3994 acceptance run). The server therefore runs
# non-dumpable (see Dockerfile), which makes /proc/<server pid>/fd root-only.
#
# This probe NEVER reads from a pipe: reading one is destructive. Only plain
# files the server holds open are checked for the marker, and only when the
# descriptor list is visible at all.
if [ -n "$SERVER_PID" ]; then
  if ls "/proc/$SERVER_PID/fd" >/dev/null 2>&1; then
    found 1 server-fd "/proc/$SERVER_PID/fd"
    for fdpath in "/proc/$SERVER_PID/fd"/*; do
      [ -e "$fdpath" ] || continue
      target="$(readlink "$fdpath" 2>/dev/null || true)"
      case "$target" in /*) ;; *) continue ;; esac
      case "$target" in /dev/*|/proc/*) continue ;; esac
      if [ -f "$target" ] && [ -r "$fdpath" ] && file_has_marker "$fdpath"; then
        found 1 server-fd-file "$fdpath"
      fi
    done
  else
    pass 1 server-fd "server-descriptors-closed-to-agents"
  fi

  # The server's memory must not be readable (ptrace protection).
  if ( exec 9<"/proc/$SERVER_PID/mem" ) 2>/dev/null; then
    found 1 server-mem "/proc/$SERVER_PID/mem"
  else
    pass 1 server-mem "/proc/$SERVER_PID/mem"
  fi
fi
scope="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo missing)"
case "$scope" in
  1|2|3) pass 1 ptrace-scope "yama-$scope" ;;
  *) found 1 ptrace-scope "yama-$scope" ;;
esac

# `kill -USR1` must not open Node's debugger on the server. (With
# --disable-sigusr1 Node keeps SIGUSR1 blocked, so it is never delivered; the
# acceptance script checks separately that the server still answers.)
if [ "${PROBE_SKIP_SIGUSR1:-0}" != 1 ] && [ -n "$SERVER_PID" ]; then
  kill -USR1 "$SERVER_PID" 2>/dev/null || true
  sleep 2
  if curl -s --max-time 2 -o /dev/null http://127.0.0.1:9229/json/version 2>/dev/null; then
    found 1 debug-port 127.0.0.1:9229
  else
    pass 1 debug-port 127.0.0.1:9229
  fi
fi

# --- Stage 2: the server's own program files --------------------------------
# An agent that can change these gets its code run by the server at the next
# restart (it can crash the server itself: same user), and by the deploy
# runner, which runs the CLI from /app as root.
#
# The kernel is asked for real: each file is opened for appending, which
# fails with EACCES when it is read-only. Nothing is ever written -- opening
# for append and closing again changes neither the content nor the
# modification time -- so this is safe to run against a live server.
for target in /app/server/dist/index.js /app/cli/src/index.ts; do
  [ -e "$target" ] || continue
  if ( : >>"$target" ) 2>/dev/null; then
    found 2 app-writable "$target"
  else
    pass 2 app-writable "$target"
  fi
done
# Anything at all under /app that this agent could change (files and
# folders; a writable folder lets it add or replace files).
if [ -d /app ]; then
  writable="$(find /app ! -type l -writable -print -quit 2>/dev/null)"
  if [ -n "$writable" ]; then
    found 2 app-tree-writable "$writable"
  else
    pass 2 app-tree-writable /app
  fi
fi

# --- Stage 3: the key that decrypts every stored company secret -------------
master_seen=0
for key in "$PC_HOME"/instances/*/secrets/master.key; do
  [ -e "$key" ] || continue
  master_seen=1
  if [ -r "$key" ]; then found 3 master-key-readable "$key"; else pass 3 master-key-readable "$key"; fi
done
[ "$master_seen" = 0 ] && pass 3 master-key-readable "no-master-key-file"

# --- Stage 5: another company's files --------------------------------------
if [ -n "${PROBE_OTHER_COMPANY_DIR:-}" ]; then
  if [ -d "$PROBE_OTHER_COMPANY_DIR" ] && grep -rlaF -f "$PATTERN_FILE" "$PROBE_OTHER_COMPANY_DIR" >/dev/null 2>&1; then
    found 5 other-company-files "$PROBE_OTHER_COMPANY_DIR"
  else
    pass 5 other-company-files "$PROBE_OTHER_COMPANY_DIR"
  fi
fi

# --- Stage 6: server-only folders -------------------------------------------
for path in "$PC_HOME"/instances/*/.env "$PC_HOME"/instances/*/config.json "$PC_HOME"/instances/*/data/backups; do
  [ -e "$path" ] || continue
  if [ -r "$path" ]; then found 6 server-only-path "$path"; else pass 6 server-only-path "$path"; fi
done

emit "SUMMARY leaks=$LEAKS known_gaps=$GAPS passes=$PASSES"
if [ -n "${PROBE_REPORT:-}" ]; then
  cp "$REPORT_TMP" "$PROBE_REPORT" 2>/dev/null || true
fi
[ "$LEAKS" -eq 0 ]
