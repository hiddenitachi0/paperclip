#!/bin/sh
# DUR-3994 Stage 1: run by docker-entrypoint.sh as ROOT, just before it drops
# to the `node` user and starts the server.
#
# Installed root-owned at /usr/local/lib/paperclip/server-secrets-handoff.sh.
# Everything this runs is a root-owned system tool (sh builtins, awk, sort,
# base64); it never runs Node, tsx or anything under /app, because every
# agent runs as `node` and can write there.
#
# Usage: server-secrets-handoff.sh <secrets-file> <names-file>
#
#   <names-file>   the list of the server's key names, written at image build
#                  time by server/src/server-secret-names.ts
#                  ("name <NAME>" / "prefix <PREFIX>" lines).
#   <secrets-file> the root-only secrets file (Compose secret
#                  `paperclip_server`); may be missing. Format: one
#                  NAME=value per line; blank lines and lines starting with #
#                  are skipped; an optional leading `export ` is allowed; one
#                  pair of matching surrounding quotes is removed. Multi-line
#                  values are not supported.
#
# Prints, on stdout, for the entrypoint only:
#
#   UNSET <every server-key name present in the environment>
#   <NAME>=<base64(value)>            (one line per key with a value)
#
# A value comes from the secrets file when it has a non-blank one for that
# name, otherwise from the environment. When there is nothing to hand over it
# prints nothing. It never prints a value except base64-encoded into this
# output; errors name the problem only and exit non-zero, so the entrypoint
# falls back to the old start.
set -eu

secrets_file="${1:-/run/secrets/paperclip_server}"
names_file="${2:-/usr/local/share/paperclip/server-secret-names}"

say() { printf 'server-secrets-handoff: %s\n' "$*" >&2; }

is_shell_name() {
  case "$1" in
    ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;;
  esac
  return 0
}

if [ ! -f "$names_file" ] || [ ! -r "$names_file" ]; then
  say "the list of server key names is missing ($names_file)"
  exit 1
fi

exact=" "
prefixes=""
while IFS=' ' read -r kind entry rest || [ -n "${kind:-}" ]; do
  case "$kind" in
    ''|'#'*) continue ;;
  esac
  if [ -n "${rest:-}" ] || ! is_shell_name "${entry:-}"; then
    say "the list of server key names is malformed"
    exit 1
  fi
  case "$kind" in
    name) exact="$exact$entry " ;;
    prefix) prefixes="$prefixes $entry" ;;
    *) say "the list of server key names is malformed"; exit 1 ;;
  esac
done <"$names_file"
if [ "$exact" = " " ]; then
  say "the list of server key names is empty"
  exit 1
fi

is_secret_name() {
  case "$exact" in
    *" $1 "*) return 0 ;;
  esac
  for p in $prefixes; do
    case "$1" in
      "$p"*) return 0 ;;
    esac
  done
  return 1
}

nonblank() {
  case "$1" in
    *[![:space:]]*) return 0 ;;
  esac
  return 1
}

trim() { # prints $1 without leading/trailing whitespace
  t="$1"
  t="${t#"${t%%[![:space:]]*}"}"
  t="${t%"${t##*[![:space:]]}"}"
  printf '%s' "$t"
}

# --- 1. keys in the secrets file --------------------------------------------
file_names=" "
ignored=""
if [ -e "$secrets_file" ]; then
  if [ ! -r "$secrets_file" ]; then
    say "cannot read the secrets file"
    exit 1
  fi
  cr="$(printf '\r')"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%"$cr"}"
    line="$(trim "$line")"
    case "$line" in
      ''|'#'*) continue ;;
      'export '*) line="$(trim "${line#export }")" ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    name="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    case "$value" in
      \"*\") [ "${#value}" -ge 2 ] && { value="${value#\"}"; value="${value%\"}"; } ;;
      \'*\') [ "${#value}" -ge 2 ] && { value="${value#\'}"; value="${value%\'}"; } ;;
    esac
    if ! is_shell_name "$name" || ! is_secret_name "$name"; then
      ignored="$ignored $name"
      continue
    fi
    nonblank "$value" || continue
    # $name is a checked plain variable name; the value is assigned by
    # reference, never expanded as code.
    eval "__pc_file_$name=\$value"
    case "$file_names" in
      *" $name "*) ;;
      *) file_names="$file_names$name " ;;
    esac
  done <"$secrets_file"
fi
if [ -n "$ignored" ]; then
  say "ignored$(printf '%s' "$ignored" | sed 's/ /, /g; s/^,//') in the secrets file (not server keys)"
fi

# --- 2. keys in the environment ---------------------------------------------
env_names=""
for name in $(awk 'BEGIN { for (k in ENVIRON) print k }' | LC_ALL=C sort -u); do
  is_shell_name "$name" || continue
  is_secret_name "$name" || continue
  env_names="$env_names $name"
done

# --- 3. what to hand over ----------------------------------------------------
lines=""
for name in $(printf '%s\n' $file_names $env_names | LC_ALL=C sort -u); do
  value=""
  case "$file_names" in
    *" $name "*) eval "value=\$__pc_file_$name" ;;
    *) eval "value=\${$name:-}" ;;
  esac
  nonblank "$value" || continue
  # printf is a shell builtin: the value is never on any command line.
  encoded="$(printf '%s' "$value" | base64 | tr -d '\n')"
  lines="$lines$name=$encoded
"
done

[ -n "$lines" ] || exit 0
printf 'UNSET%s\n' "$env_names"
printf '%s' "$lines"
