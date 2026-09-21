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
#   SUMMARY   leaks=<n> known_gaps=<n> passes=<n>
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
if [ -r /proc/1/environ ] && file_has_marker /proc/1/environ; then
  found 1 proc-environ /proc/1/environ
else
  pass 1 proc-environ /proc/1/environ
fi
proc_clean=1
for dir in /proc/[0-9]*; do
  pid="${dir#/proc/}"
  [ "$pid" = 1 ] && continue
  [ "$pid" = "$$" ] && continue
  for leaf in environ cmdline; do
    if [ -r "$dir/$leaf" ] && file_has_marker "$dir/$leaf"; then
      found 1 "proc-$leaf" "$dir/$leaf"
      proc_clean=0
    fi
  done
done
[ "$proc_clean" = 1 ] && pass 1 proc-other "no-canary-in-other-processes"

# --- Stage 2: the server's own program files --------------------------------
if [ -e /app/server/dist/index.js ]; then
  # Only asks the kernel whether a write WOULD be allowed; never writes.
  if [ -w /app/server/dist/index.js ]; then
    found 2 app-writable /app/server/dist/index.js
  else
    pass 2 app-writable /app/server/dist/index.js
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
