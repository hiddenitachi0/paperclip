#!/usr/bin/env bash
# Migration rehearsal: run the pending migrations against a throwaway copy of a
# real database BEFORE they are ever run against the real one.
#
# WHY THIS EXISTS
# ---------------
# On 2026-09-09 a migration was written against the schema in this repo and
# deployed straight to production. Production's database also holds a client's
# Django tables, whose `company_id` is a bigint rather than a uuid. The
# migration walked every table with a `company_id` column, compared it to a
# uuid, and Postgres refused ("operator does not exist: bigint = uuid"). The
# migration aborted, the server could not boot, and it crash-looped until the
# deploy was rolled back.
#
# Nothing in the repo could have caught that, because the repo does not contain
# the client's tables -- only a copy of the real database does. This script is
# that missing step: restore a dump into a scratch database, run the pending
# migrations against it, and say plainly whether they worked.
#
# USAGE
#   ./scripts/rehearse-migrations.sh --dump /path/to/backup.dump
#   pnpm db:rehearse --dump /path/to/backup.dump
#
#   --dump <file>       Required. A pg_dump file. Custom/directory/tar format
#                       is restored with pg_restore; a plain .sql (or .sql.gz)
#                       file is piped through psql.
#   --scratch-db <name> Name of the throwaway database. Default:
#                       rehearsal_<timestamp>. Must start with "rehearsal_".
#   --admin-url <url>   A Postgres URL on the scratch server, pointing at any
#                       database the script may connect to in order to create
#                       and drop the scratch one. Default:
#                       $PAPERCLIP_REHEARSAL_ADMIN_URL, else
#                       postgres://postgres@127.0.0.1:5432/postgres
#   --keep              Leave the scratch database behind for inspection.
#   --help              Print this usage.
#
# SAFETY
# ------
# This script is only ever pointed at a scratch server. It refuses to run if:
#   * the scratch database name does not start with "rehearsal_";
#   * the scratch URL is the same as $DATABASE_URL;
#   * the admin URL host is not local, unless
#     PAPERCLIP_REHEARSAL_ALLOW_REMOTE=1 is set deliberately.
# It never reads $DATABASE_URL for anything but that comparison, and it never
# connects to the production box.
#
# WHAT IT REPORTS
#   Success: which migrations were applied, and that the database is up to
#            date.
#   Failure: the exact migration file that failed and the exact Postgres error,
#            plus the path to the full log.
#
# The functions below are exercised directly by
# scripts/__tests__/rehearse-migrations.test.mjs, which fakes psql/pg_restore/
# pnpm on PATH; the bottom of the file is guarded so sourcing it runs nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/packages/db/src/migrations"
JOURNAL_PATH="$MIGRATIONS_DIR/meta/_journal.json"

DEFAULT_ADMIN_URL="${PAPERCLIP_REHEARSAL_ADMIN_URL:-postgres://postgres@127.0.0.1:5432/postgres}"

DUMP_PATH=""
SCRATCH_DB=""
ADMIN_URL="$DEFAULT_ADMIN_URL"
KEEP_SCRATCH=0
LOG_PATH=""

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Rehearse the pending database migrations against a throwaway copy of a real
database, so a migration that would break on the real data is caught here
instead of in production.

  ./scripts/rehearse-migrations.sh --dump /path/to/backup.dump
  pnpm db:rehearse --dump /path/to/backup.dump

  --dump <file>       Required. A pg_dump file. Custom/directory/tar format is
                      restored with pg_restore; a plain .sql (or .sql.gz) file
                      is piped through psql.
  --scratch-db <name> Name of the throwaway database. Default
                      rehearsal_<timestamp>. Must start with "rehearsal_".
  --admin-url <url>   Postgres URL on the scratch server, pointing at any
                      database this script may connect to in order to create
                      and drop the scratch one. Default
                      $PAPERCLIP_REHEARSAL_ADMIN_URL, else
                      postgres://postgres@127.0.0.1:5432/postgres
  --keep              Leave the scratch database behind for inspection.
  --help              Print this message.

This never touches production: it refuses a scratch name that does not start
with "rehearsal_", refuses a scratch URL equal to $DATABASE_URL, and refuses a
non-local host unless PAPERCLIP_REHEARSAL_ALLOW_REMOTE=1 is set deliberately.
USAGE
}

# --- URL helpers -------------------------------------------------------------

# Host portion of a postgres:// URL, lowercased. Empty when there is no host
# (a local socket URL such as postgres:///paperclip).
url_host() {
  local url="$1" rest
  rest="${url#*://}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  rest="${rest##*@}"
  rest="${rest%%:*}"
  rest="${rest#[}"
  rest="${rest%]}"
  printf '%s' "$rest" | tr '[:upper:]' '[:lower:]'
}

# Same URL with the database name replaced. Query parameters (sslmode=...) are
# preserved.
url_with_database() {
  local url="$1" database="$2" prefix query rest
  query=""
  case "$url" in
    *\?*) query="?${url#*\?}"; url="${url%%\?*}" ;;
  esac
  prefix="${url%%://*}://"
  rest="${url#*://}"
  rest="${rest%%/*}"
  printf '%s%s/%s%s' "$prefix" "$rest" "$database" "$query"
}

is_local_host() {
  case "$1" in
    ""|localhost|127.0.0.1|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Safety ------------------------------------------------------------------

assert_safe_target() {
  local admin_url="$1" scratch_db="$2" scratch_url host
  scratch_url="$(url_with_database "$admin_url" "$scratch_db")"
  host="$(url_host "$admin_url")"

  case "$scratch_db" in
    rehearsal_*) ;;
    *) fail "Refusing to run: the scratch database name must start with \"rehearsal_\" so it can never be mistaken for a real one. Got: $scratch_db" ;;
  esac

  if [ -n "${DATABASE_URL:-}" ] && [ "$scratch_url" = "$DATABASE_URL" ]; then
    fail "Refusing to run: the scratch database is the same as DATABASE_URL. Point --admin-url at a scratch server instead."
  fi

  if ! is_local_host "$host" && [ "${PAPERCLIP_REHEARSAL_ALLOW_REMOTE:-0}" != "1" ]; then
    fail "Refusing to run against the remote host \"$host\". Restore the dump on your own machine, or set PAPERCLIP_REHEARSAL_ALLOW_REMOTE=1 if you are certain this is a scratch server."
  fi
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1. Install the PostgreSQL client tools and try again."
}

# --- Migration bookkeeping ---------------------------------------------------

# Migration file names in the order the journal applies them.
migration_files_in_order() {
  node -e '
    const fs = require("node:fs");
    const journal = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entries = [...(journal.entries ?? [])].sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
    for (const entry of entries) process.stdout.write(`${entry.tag}.sql\n`);
  ' "$JOURNAL_PATH"
}

# The sha256 of a migration file is exactly what packages/db/src/client.ts
# records in drizzle.__drizzle_migrations, so the two can be compared directly.
migration_hash() {
  sha256sum "$MIGRATIONS_DIR/$1" | cut -d' ' -f1
}

applied_hashes() {
  local url="$1"
  psql "$url" -At -c "select hash from drizzle.__drizzle_migrations" 2>/dev/null || true
}

# Migration files not yet recorded as applied in the given database, in order.
pending_migrations() {
  local url="$1" applied file
  applied="$(applied_hashes "$url")"
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if ! printf '%s\n' "$applied" | grep -qxF "$(migration_hash "$file")"; then
      printf '%s\n' "$file"
    fi
  done < <(migration_files_in_order)
}

# --- Steps -------------------------------------------------------------------

create_scratch_database() {
  local admin_url="$1" scratch_db="$2"
  psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$scratch_db\"" >/dev/null
  psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$scratch_db\"" >/dev/null
}

drop_scratch_database() {
  local admin_url="$1" scratch_db="$2"
  psql "$admin_url" -q -c "DROP DATABASE IF EXISTS \"$scratch_db\"" >/dev/null 2>&1 || true
}

restore_dump() {
  local dump="$1" scratch_url="$2" log="$3"
  case "$dump" in
    *.sql)
      psql "$scratch_url" -v ON_ERROR_STOP=1 -q -f "$dump" >>"$log" 2>&1
      ;;
    *.sql.gz|*.gz)
      gunzip -c "$dump" | psql "$scratch_url" -v ON_ERROR_STOP=1 -q >>"$log" 2>&1
      ;;
    *)
      require_tool pg_restore
      # --no-owner/--no-privileges: the dump's owning roles do not exist on a
      # scratch server, and the rehearsal is about the migrations, not about
      # reproducing ownership.
      pg_restore --no-owner --no-privileges --dbname "$scratch_url" "$dump" >>"$log" 2>&1
      ;;
  esac
}

run_migrations() {
  local scratch_url="$1" log="$2"
  ( cd "$REPO_ROOT" && DATABASE_URL="$scratch_url" pnpm --filter @paperclipai/db migrate ) >>"$log" 2>&1
}

# The lines worth showing an operator out of a long migration log.
extract_failure() {
  local log="$1"
  grep -iE 'error|refus|exception|NOTICE: *Skipping' "$log" | tail -n 20
}

# --- Main --------------------------------------------------------------------

parse_args() {
  DUMP_PATH=""
  SCRATCH_DB=""
  ADMIN_URL="$DEFAULT_ADMIN_URL"
  KEEP_SCRATCH=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dump) DUMP_PATH="${2:-}"; shift 2 ;;
      --scratch-db) SCRATCH_DB="${2:-}"; shift 2 ;;
      --admin-url) ADMIN_URL="${2:-}"; shift 2 ;;
      --keep) KEEP_SCRATCH=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) fail "Unknown option: $1 (run with --help)" ;;
    esac
  done

  [ -n "$DUMP_PATH" ] || fail "Missing --dump <file>. Take a dump of the database you are about to migrate, and point this at it."
  [ -f "$DUMP_PATH" ] || [ -d "$DUMP_PATH" ] || fail "Dump not found: $DUMP_PATH"
  [ -n "$SCRATCH_DB" ] || SCRATCH_DB="rehearsal_$(date +%Y%m%d%H%M%S)"
}

main() {
  parse_args "$@"

  require_tool psql
  require_tool node
  assert_safe_target "$ADMIN_URL" "$SCRATCH_DB"

  local scratch_url
  scratch_url="$(url_with_database "$ADMIN_URL" "$SCRATCH_DB")"
  LOG_PATH="${TMPDIR:-/tmp}/paperclip-migration-rehearsal-$SCRATCH_DB.log"
  : >"$LOG_PATH"

  say "Rehearsing migrations on a throwaway copy of your database."
  say "  dump:     $DUMP_PATH"
  say "  scratch:  $SCRATCH_DB"
  say "  full log: $LOG_PATH"
  say ""

  say "1/3 Creating the scratch database..."
  create_scratch_database "$ADMIN_URL" "$SCRATCH_DB"

  say "2/3 Restoring the dump into it (this can take a while)..."
  if ! restore_dump "$DUMP_PATH" "$scratch_url" "$LOG_PATH"; then
    say ""
    say "The dump could not be restored, so the migrations were not rehearsed."
    extract_failure "$LOG_PATH"
    say "Full log: $LOG_PATH"
    [ "$KEEP_SCRATCH" -eq 1 ] || drop_scratch_database "$ADMIN_URL" "$SCRATCH_DB"
    return 2
  fi

  local pending
  pending="$(pending_migrations "$scratch_url")"
  if [ -z "${pending//[[:space:]]/}" ]; then
    say ""
    say "Nothing to rehearse: this copy already has every migration in the repo."
    [ "$KEEP_SCRATCH" -eq 1 ] || drop_scratch_database "$ADMIN_URL" "$SCRATCH_DB"
    return 0
  fi

  say "3/3 Running the migrations that have not been applied yet:"
  printf '      %s\n' $pending

  if run_migrations "$scratch_url" "$LOG_PATH"; then
    say ""
    say "PASSED. Every pending migration ran cleanly against a copy of this database."
    say "It is safe to deploy them, as far as the database is concerned."
    [ "$KEEP_SCRATCH" -eq 1 ] || drop_scratch_database "$ADMIN_URL" "$SCRATCH_DB"
    return 0
  fi

  local still_pending failing
  still_pending="$(pending_migrations "$scratch_url")"
  failing="$(printf '%s\n' "$still_pending" | head -n 1)"

  say ""
  say "FAILED. Do not deploy this."
  say "The migration that failed: ${failing:-unknown}"
  say "What Postgres said:"
  extract_failure "$LOG_PATH" | sed 's/^/  /'
  say ""
  say "Full log: $LOG_PATH"
  if [ "$KEEP_SCRATCH" -eq 1 ]; then
    say "The scratch database $SCRATCH_DB was left in place so you can look at it."
  else
    drop_scratch_database "$ADMIN_URL" "$SCRATCH_DB"
  fi
  return 1
}

# Guarded so the tests can source this file and call its functions directly
# without creating databases or restoring anything.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
