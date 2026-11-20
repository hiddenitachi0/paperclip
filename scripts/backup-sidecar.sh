#!/bin/sh
# Hourly database dumps for the backup sidecar (DUR-5176, plan: DUR-5063 option A).
#
# Runs in the `backup` service of docker/docker-compose.backup.yml, a container
# that has NO /paperclip mount, so the server and the agents (same Linux user)
# can neither read nor delete the dumps. It writes the same files the server's
# own backup job used to write, so a restore with `psql` and the host's offsite
# job work as before; only the folder moved.
#
#   file name   paperclip-YYYYMMDD-HHMMSS.sql.gz   (UTC)
#   format      pg_dump --format=plain --clean --if-exists --no-owner
#               --no-privileges | gzip              (packages/db/src/backup-lib.ts)
#   retention   last 48h: all; then newest per day / ISO week / month, with
#               the same cut-offs as `selectBackupsToDelete` in backup-lib.ts
#   writes      to a hidden temp file, then renames it, so a half-written dump
#               is never listed, kept or copied offsite
#   failure     any failed dump deletes its temp file and exits non-zero
#
# Usage:  backup-sidecar.sh [run|once|healthcheck|select-expired]
#   run             dump now, then every BACKUP_INTERVAL_MINUTES (default)
#   once            one dump and prune, then exit (CI, manual use)
#   healthcheck     exit 0 when the last successful dump is recent enough
#   select-expired  read "<mtime-epoch> <name>" lines on stdin, print the names
#                   retention would delete (BACKUP_NOW overrides the clock).
#                   Used by the tests to prove parity with backup-lib.ts.
#
# Settings (environment; none is a secret):
#   BACKUP_DIR               output folder inside the container (default /backups)
#   BACKUP_INTERVAL_MINUTES  default 60
#   BACKUP_DAILY_DAYS        default 7     (the server's default retention)
#   BACKUP_WEEKLY_WEEKS      default 4
#   BACKUP_MONTHLY_MONTHS    default 1
#   BACKUP_RETENTION_FROM_DB default 1: before each prune, read the retention
#                            chosen in Instance Settings (general.backupRetention
#                            in instance_settings), as the server's own job
#                            did; the three values above are the fallback when
#                            that cannot be read. 0 = use the three values only.
#   BACKUP_FILENAME_PREFIX   default paperclip
#   PGHOST / PGPORT / PGDATABASE   default db / 5432 / paperclip
#   BACKUP_SECRETS_FILE      default /run/secrets/paperclip_backup
#
# The database login comes ONLY from BACKUP_SECRETS_FILE (a root-only file on
# the host, mounted as a Docker secret): NAME=value lines, of which only
# PGUSER and PGPASSWORD are read. The file is parsed, never sourced. The
# password goes to pg_dump's environment alone and is never printed.

set -eu

# Dump names and retention buckets are UTC, whatever the host sets.
TZ=UTC
export TZ

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES:-60}"
BACKUP_DAILY_DAYS="${BACKUP_DAILY_DAYS:-7}"
BACKUP_WEEKLY_WEEKS="${BACKUP_WEEKLY_WEEKS:-4}"
BACKUP_MONTHLY_MONTHS="${BACKUP_MONTHLY_MONTHS:-1}"
BACKUP_FILENAME_PREFIX="${BACKUP_FILENAME_PREFIX:-paperclip}"
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-/run/secrets/paperclip_backup}"
BACKUP_HEALTH_MARKER="${BACKUP_HEALTH_MARKER:-/tmp/backup-last-ok}"
PGHOST="${PGHOST:-db}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-paperclip}"

log() { printf '%s backup-sidecar: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_int() { # name value min max
  case "$2" in ''|*[!0-9]*) die "$1 must be a whole number (got: $2)" ;; esac
  [ "$2" -ge "$3" ] && [ "$2" -le "$4" ] || die "$1 must be between $3 and $4 (got: $2)"
}

# --- calendar arithmetic (UTC, pure shell, same result on dash and busybox) --

# days_from_civil Y M D -> $R_DAYS (days since 1970-01-01). D may overflow the
# month the way JavaScript's Date does; the result is just days arithmetic.
days_from_civil() {
  _y=$1 _m=$2 _d=$3
  [ "$_m" -le 2 ] && _y=$((_y - 1))
  _era=$((_y / 400))
  _yoe=$((_y - _era * 400))
  _mp=$(((_m + 9) % 12))
  _doy=$(((153 * _mp + 2) / 5 + _d - 1))
  _doe=$((_yoe * 365 + _yoe / 4 - _yoe / 100 + _doy))
  R_DAYS=$((_era * 146097 + _doe - 719468))
}

# civil_from_days N -> $R_Y $R_M $R_D
civil_from_days() {
  _z=$(($1 + 719468))
  _era=$((_z / 146097))
  _doe=$((_z - _era * 146097))
  _yoe=$(((_doe - _doe / 1460 + _doe / 36524 - _doe / 146096) / 365))
  R_Y=$((_yoe + _era * 400))
  _doy=$((_doe - (365 * _yoe + _yoe / 4 - _yoe / 100)))
  _mp=$(((5 * _doy + 2) / 153))
  R_D=$((_doy - (153 * _mp + 2) / 5 + 1))
  if [ "$_mp" -lt 10 ]; then R_M=$((_mp + 3)); else R_M=$((_mp - 9)); fi
  [ "$R_M" -le 2 ] && R_Y=$((R_Y + 1))
  return 0
}

# bucket_keys EPOCH -> $K_DAY $K_WEEK $K_MONTH  (isoWeekKey/monthKey/dayKey in backup-lib.ts)
bucket_keys() {
  _dn=$(($1 / 86400))
  civil_from_days "$_dn"
  K_DAY="$R_Y-$R_M-$R_D"
  K_MONTH="$R_Y-$R_M"
  _dow=$(((_dn + 3) % 7 + 1)) # ISO: Monday=1 .. Sunday=7 (1970-01-01 was a Thursday)
  _thu=$((_dn + 4 - _dow))    # the Thursday of this ISO week decides its year
  civil_from_days "$_thu"
  _ty=$R_Y
  days_from_civil "$_ty" 1 1
  K_WEEK="$_ty-W$(((_thu - R_DAYS + 1 + 6) / 7))"
}

# monthly_cutoff NOW MONTHS -> $R_EPOCH: NOW minus MONTHS calendar months, with
# JavaScript's setMonth overflow (31 March minus one month is 3 March).
monthly_cutoff() {
  _dn=$(($1 / 86400))
  _tod=$(($1 % 86400))
  civil_from_days "$_dn"
  _idx=$((R_Y * 12 + R_M - 1 - $2))
  days_from_civil $((_idx / 12)) $((_idx % 12 + 1)) "$R_D"
  R_EPOCH=$((R_DAYS * 86400 + _tod))
}

min2() { if [ "$1" -lt "$2" ]; then R_MIN=$1; else R_MIN=$2; fi; }

seen() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; } # set key

# select_expired: stdin "<mtime> <name>" lines in any order; prints the names
# retention deletes. Port of selectBackupsToDelete (packages/db/src/backup-lib.ts):
# keep everything from the last 48h, then the NEWEST per day back to the daily
# cut-off, per ISO week back to the weekly one, per month back to the monthly
# one; a bucket already represented by a newer tier is not kept twice.
select_expired() {
  _now="${BACKUP_NOW:-$(date -u +%s)}"
  _daily=$BACKUP_DAILY_DAYS _weekly=$BACKUP_WEEKLY_WEEKS _monthly=$BACKUP_MONTHLY_MONTHS
  [ "$_daily" -lt 1 ] && _daily=1
  [ "$_weekly" -lt 1 ] && _weekly=1
  [ "$_monthly" -lt 1 ] && _monthly=1
  _full=$((_now - 48 * 3600))
  min2 "$_full" $((_now - _daily * 86400)); _dcut=$R_MIN
  min2 "$_dcut" $((_now - _weekly * 7 * 86400)); _wcut=$R_MIN
  monthly_cutoff "$_now" "$_monthly"
  min2 "$_wcut" "$R_EPOCH"; _mcut=$R_MIN

  _days="" _weeks="" _months=""
  sort -rn | while read -r _mtime _name; do
    [ -n "${_name:-}" ] || continue
    bucket_keys "$_mtime"
    if [ "$_mtime" -gt "$_now" ] || [ "$_mtime" -ge "$_full" ]; then
      _days="$_days $K_DAY"; _weeks="$_weeks $K_WEEK"; _months="$_months $K_MONTH"
    elif [ "$_mtime" -ge "$_dcut" ]; then
      if seen "$_days" "$K_DAY"; then printf '%s\n' "$_name"
      else _days="$_days $K_DAY"; _weeks="$_weeks $K_WEEK"; _months="$_months $K_MONTH"; fi
    elif [ "$_mtime" -ge "$_wcut" ]; then
      if seen "$_weeks" "$K_WEEK"; then printf '%s\n' "$_name"
      else _weeks="$_weeks $K_WEEK"; _months="$_months $K_MONTH"; fi
    elif [ "$_mtime" -ge "$_mcut" ]; then
      if seen "$_months" "$K_MONTH"; then printf '%s\n' "$_name"
      else _months="$_months $K_MONTH"; fi
    else
      printf '%s\n' "$_name"
    fi
  done
}

# --- the dump ----------------------------------------------------------------

load_login() {
  [ -r "$BACKUP_SECRETS_FILE" ] || die "database login file is missing or unreadable: $BACKUP_SECRETS_FILE"
  BK_USER="" BK_PASS=""
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line%"$(printf '\r')"}"
    case "$_line" in
      PGUSER=*) BK_USER="${_line#PGUSER=}" ;;
      PGPASSWORD=*) BK_PASS="${_line#PGPASSWORD=}" ;;
    esac
  done <"$BACKUP_SECRETS_FILE"
  [ -n "$BK_USER" ] || die "PGUSER is not set in $BACKUP_SECRETS_FILE"
  [ -n "$BK_PASS" ] || die "PGPASSWORD is not set in $BACKUP_SECRETS_FILE"
}

list_dumps() { # prints "<mtime> <name>" for every dump file retention may touch
  for _f in "$BACKUP_DIR/$BACKUP_FILENAME_PREFIX"-*.sql "$BACKUP_DIR/$BACKUP_FILENAME_PREFIX"-*.sql.gz; do
    [ -f "$_f" ] && [ ! -L "$_f" ] || continue
    _n="${_f##*/}"
    case "$_n" in *[!A-Za-z0-9._-]*) continue ;; esac
    printf '%s %s\n' "$(stat -c %Y "$_f")" "$_n"
  done
}

# The server's own job read the retention from Instance Settings on every run,
# so changing it in the UI took effect without a restart. Do the same, with the
# environment values as the fallback. A bad or unreadable value is logged and
# ignored, never fatal: a retention lookup must not stop a dump.
load_retention_from_db() {
  [ "${BACKUP_RETENTION_FROM_DB:-1}" = 0 ] && return 0
  _row="$(PGPASSWORD="$BK_PASS" PGCONNECT_TIMEOUT=10 psql -X -A -t \
    --host="$PGHOST" --port="$PGPORT" --username="$BK_USER" --dbname="$PGDATABASE" --no-password \
    -c "SELECT concat_ws(' ', general->'backupRetention'->>'dailyDays', general->'backupRetention'->>'weeklyWeeks', general->'backupRetention'->>'monthlyMonths') FROM instance_settings WHERE singleton_key = 'default'" \
    2>/dev/null)" || _row=""
  set -- $_row
  if [ "$#" = 3 ]; then
    for _v in "$1" "$2" "$3"; do
      case "$_v" in ''|*[!0-9]*) log "ignoring unreadable retention setting from the database"; return 0 ;; esac
      [ "$_v" -ge 1 ] && [ "$_v" -le 3650 ] || { log "ignoring out-of-range retention setting from the database"; return 0; }
    done
    BACKUP_DAILY_DAYS=$1 BACKUP_WEEKLY_WEEKS=$2 BACKUP_MONTHLY_MONTHS=$3
    log "retention from Instance Settings: daily $1 day(s), weekly $2 week(s), monthly $3 month(s)"
  else
    log "retention from the service settings: daily $BACKUP_DAILY_DAYS, weekly $BACKUP_WEEKLY_WEEKS, monthly $BACKUP_MONTHLY_MONTHS"
  fi
}

prune() {
  load_retention_from_db
  _expired="$(list_dumps | select_expired)"
  _count=0
  for _n in $_expired; do
    rm -f -- "$BACKUP_DIR/$_n" && _count=$((_count + 1))
  done
  log "retention pruned $_count dump(s)"
}

dump_once() {
  mkdir -p "$BACKUP_DIR"
  _stamp="$(date -u +%Y%m%d-%H%M%S)"
  _final="$BACKUP_DIR/$BACKUP_FILENAME_PREFIX-$_stamp.sql.gz"
  _tmp="$BACKUP_DIR/.$BACKUP_FILENAME_PREFIX-$_stamp.sql.gz.partial"
  _status="$BACKUP_DIR/.$BACKUP_FILENAME_PREFIX-$_stamp.status.partial"
  [ ! -e "$_final" ] || die "refusing to overwrite $_final"
  rm -f -- "$_tmp" "$_status"
  log "dump starting: $_final"

  # sh has no `pipefail`, so pg_dump's own exit status is carried out of the
  # pipeline through a small file and checked next to gzip's.
  _gz=0
  { PGPASSWORD="$BK_PASS" pg_dump \
      --host="$PGHOST" --port="$PGPORT" --username="$BK_USER" --dbname="$PGDATABASE" \
      --no-password --format=plain --clean --if-exists --no-owner --no-privileges
    echo $? >"$_status"; } | gzip -c >"$_tmp" || _gz=$?
  _pg="$(cat "$_status" 2>/dev/null || echo missing)"
  rm -f -- "$_status"
  if [ "$_pg" != 0 ] || [ "$_gz" != 0 ] || [ ! -s "$_tmp" ]; then
    rm -f -- "$_tmp"
    die "dump failed (pg_dump exit: $_pg, gzip exit: $_gz); nothing was kept"
  fi
  sync || true
  mv -- "$_tmp" "$_final" || { rm -f -- "$_tmp"; die "could not move the dump into place"; }
  _size="$(stat -c %s "$_final")"
  log "dump complete: $_final ($_size bytes)"
  : >"$BACKUP_HEALTH_MARKER"
  prune
}

cleanup_partials() { rm -f -- "$BACKUP_DIR"/.*.partial 2>/dev/null || true; }

main_loop() {
  require_int BACKUP_INTERVAL_MINUTES "$BACKUP_INTERVAL_MINUTES" 1 10080
  trap 'log "stopping"; cleanup_partials; exit 143' TERM INT
  while :; do
    _start="$(date -u +%s)"
    dump_once
    _wait=$((BACKUP_INTERVAL_MINUTES * 60 - ($(date -u +%s) - _start)))
    [ "$_wait" -gt 0 ] || _wait=1
    sleep "$_wait" &
    wait $! || true
  done
}

healthcheck() {
  require_int BACKUP_INTERVAL_MINUTES "$BACKUP_INTERVAL_MINUTES" 1 10080
  [ -e "$BACKUP_HEALTH_MARKER" ] || exit 1
  _age=$(($(date -u +%s) - $(stat -c %Y "$BACKUP_HEALTH_MARKER")))
  # Two intervals plus a margin for a slow dump.
  [ "$_age" -le $((BACKUP_INTERVAL_MINUTES * 120 + 900)) ]
}

validate_retention() {
  require_int BACKUP_DAILY_DAYS "$BACKUP_DAILY_DAYS" 1 3650
  require_int BACKUP_WEEKLY_WEEKS "$BACKUP_WEEKLY_WEEKS" 1 3650
  require_int BACKUP_MONTHLY_MONTHS "$BACKUP_MONTHLY_MONTHS" 1 3650
  case "$BACKUP_FILENAME_PREFIX" in ''|*[!A-Za-z0-9_]*) die "BACKUP_FILENAME_PREFIX must be letters, digits and _" ;; esac
}

case "${1:-run}" in
  select-expired) validate_retention; select_expired ;;
  healthcheck) healthcheck ;;
  once) validate_retention; load_login; cleanup_partials; dump_once ;;
  run) validate_retention; load_login; cleanup_partials; main_loop ;;
  *) echo "usage: $0 [run|once|healthcheck|select-expired]" >&2; exit 2 ;;
esac
