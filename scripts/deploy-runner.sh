#!/usr/bin/env bash
# Universal on-box deploy runner (DUR-9, PR3/7 of DUR-6).
#
# Generalizes the poller pattern used today by this fork's own
# scripts/deploy-poller.sh + scripts/deploy-prod.sh, and by the dashboard's
# bespoke /root/nordstrand-deploy-poller.sh + /root/deploy-dashboard.sh, into
# ONE versioned, config-driven runner. Runs on-box, outside any container, as
# root (see deploy/systemd/paperclip-deploy-runner.{service,timer} — the
# first version-controlled copy of these units; today's are hand-installed
# and untracked). Does NOT retire either existing poller yet — that happens
# in PR6/PR7 of DUR-6, after this runner is proven end-to-end.
#
# For every `request_board_approval` approval across ALL companies whose
# payload is `{kind:"deploy", ...}` (see deployRequestPayloadSchema,
# packages/shared/src/validators/approval.ts) and is APPROVED + unprocessed:
#
#   1. Resolve payload.projectId -> project.deployPolicy, and
#      payload.workspaceId -> that project's workspace repoUrl/repoRef.
#      deployPolicy.workspaceId must match payload.workspaceId (defends
#      against a stale/mismatched request targeting the wrong checkout).
#   2. Resolve the company's read-only GITHUB_TOKEN via the
#      instance-admin-only /companies/:id/deploy-github-token endpoint
#      (server/src/routes/secrets.ts) — never a general secret-value read.
#   3. DUR-3905: before touching the checkout at all, query GitHub's combined
#      commit status + check-runs for payload.commit (or the workspace's
#      repoRef) via check_ci_status(). A red check stops the deploy with an
#      explanatory comment instead of shipping it and relying on the
#      health-check + rollback below to catch it after the fact. DUR-3967: a
#      still-RUNNING check is not a verdict — the card is left unprocessed and
#      re-checked on each 60s tick (bounded by CI_WAIT_SECONDS from the
#      approval's decidedAt) so it ships by itself the moment the checks go
#      green, with no second approval from the operator. A check that has
#      already finished RED counts as red even while other checks are still
#      running. A repo
#      with no CI configured at all (both endpoints empty) is treated the same
#      as today — absence of CI is not evidence of failure, so it doesn't
#      block a deploy that would otherwise always have gone through; likewise
#      a GitHub API/network failure fails OPEN (unknown), matching how the
#      merge-pr-automation service treats the same ambiguity elsewhere in this
#      codebase, so a GitHub outage can't itself become a deploy outage — with
#      one exception (DUR-3967): a card that an earlier tick already saw
#      mid-check keeps waiting on an "unknown" instead of shipping, because
#      there we have positive evidence that checks exist and were unfinished.
#   4. In deployTargetPath: git fetch + reset --hard to payload.commit (if
#      pinned) or the workspace's repoRef, authenticating with the resolved
#      token via the SAME credential-helper script the container image uses
#      (paperclip-git-credential.sh) — the token is only ever passed through
#      the process environment for that one git invocation, never written to
#      disk or argv.
#   5. Run the OPERATOR-configured recipe: deployKind is set by the operator
#      in project settings only — the requesting agent can only ask for a
#      deploy of the pre-configured recipe, never inject a command (SECURITY,
#      ties to admin-auth-hardening). compose_recreate/compose_build_swap build
#      their `docker compose` invocation from optional deployPolicy.composeFiles
#      (-f per entry) and deployPolicy.envFile (--env-file), defaulting to a
#      plain `docker compose` (root docker-compose.yml in deployTargetPath)
#      when neither is set:
#       - compose_recreate:    docker compose [--env-file ...] [-f ...] up -d --force-recreate [deployServices...]
#       - compose_build_swap:  docker compose [--env-file ...] [-f ...] build [deployServices...]; docker compose [--env-file ...] [-f ...] up -d --no-build [deployServices...]
#       - custom:               bash -c "$deployCommand"
#   6. Health-check healthCheckUrl for HTTP 200 (retries below); auto-rollback
#      (git reset --hard to the pre-deploy commit + re-run the recipe) when
#      rollback is "git_previous" and the health check never passes.
#   6b. DUR-3974: health-check the APPLICATION, not just an address. Before
#      anything is touched, record how the project's real pages
#      (deployPolicy.appHealthCheckPaths, or the front page when none are
#      configured) answer; after the deploy, open them again and roll back if
#      a page that WAS working now returns a server error. A single 200 from
#      one configured address proves nothing: on 2026-09-10 that address was a
#      login page that renders without touching the database, so it answered
#      200 throughout five and a half minutes of 500s on every page that
#      loads companies, and the deploy called itself healthy. Comparing
#      against the pre-deploy answer (rather than demanding some absolute
#      notion of "healthy") is what stops this check from rolling back good
#      deploys: an already-broken page, a login wall, a redirect and a 404 all
#      answer the same before and after.
#   6c. DUR-3974 ordering: for compose_recreate nothing is rebuilt, so the
#      `git reset --hard` in step 4 IS the moment new code goes live, and the
#      migrations it carries are only applied when the container is recreated
#      in step 5. The quiet-mode drain (up to 240s) used to sit between those
#      two, which is most of what made the 2026-09-10 window five and a half
#      minutes long. The drain and every refusal guard now happen BEFORE the
#      reset (the guards via a dry-run fetch), and where the project names its
#      services those are stopped before the files are swapped, so new code is
#      never served against a schema that has not caught up.
#   7. Comment the result back on the approval.
#
# Idempotent via a processed-set file; flock single-flight — same shape as
# deploy-poller.sh today, generalized across companies/projects and
# file-tracked (this script) instead of hand-installed on the box.
#
# DUR-44: an approval is only ever added to the processed-set AFTER a comment
# (success, failure, or "superseded") has actually been delivered for it —
# never before. comment() retries with backoff (a deploy recreating the very
# container this script talks to via `docker exec` can make it unreachable
# for a stretch, which is exactly what silently dropped 5bd025d5 during
# DUR-42's own deploy). Each approval is also processed inside its own
# subshell with an EXIT trap fallback, so an unexpected script error while
# handling one approval can't abort the whole poll cycle (and orphan
# already-marked-processed approvals queued behind it) without at least
# trying to say so. If two approved deploy requests target the same
# project+workspace in one poll cycle, only the most recently *approved* one
# actually deploys (they converge on the same git ref reset anyway) — the
# older one gets a "superseded" comment instead of silently vanishing.
# Every comment attempt (delivered or not) is also mirrored, best-effort, as
# a JSON line into $STATUS_PATH inside the server container's own volume, so
# an agent without host/docker access can see recent runner activity via the
# API instead of needing a human to read deploy-runner.log by hand. Since
# DUR-3923 a real deploy also writes one `outcome:"started"` line there before
# its slow part begins (see process_approval), so the server can tell "busy
# on it" from "never picked it up".
#
# DUR-3923: an approved card whose kind only LOOKS like a deploy ("deploy_pr",
# "rollout", ...) is answered with a comment saying nothing acts on it (see
# run_unsupported_kind_approval) instead of being skipped in silence -- the
# NOR-1242 incident was exactly an approved deploy_pr card that did nothing.
# Only cards decided within UNSUPPORTED_KIND_MAX_AGE_SECONDS (24h) are
# answered, so a fresh processed-set does not replay history.
#
# Auth: uses the CLI's stored board credential inside the server container,
# same as deploy-poller.sh — must be an instance admin (required for the
# cross-company approval list and the GitHub-token endpoint).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_CREDENTIAL_HELPER="$SCRIPT_DIR/paperclip-git-credential.sh"
PROCESSED="${PAPERCLIP_DEPLOY_RUNNER_PROCESSED:-$REPO_DIR/.deploy-runner-processed}"
LOG="${PAPERCLIP_DEPLOY_RUNNER_LOG:-$REPO_DIR/deploy-runner.log}"
DOCKER_SERVER_CONTAINER="${PAPERCLIP_DEPLOY_RUNNER_CONTAINER:-docker-server-1}"
CLI='cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts'
ARGS='--api-base http://127.0.0.1:3100 --data-dir /paperclip/cli-state --json'
# DUR-164: 8b89106e's own code booted clean and passed /api/health in ~11s
# when reproduced in isolation (fresh embedded Postgres, all 142 migrations
# incl. 0140/0141 applied) — no startup crash, no slow migration. The 90s
# budget (30 * 3s) that deploy previously ran against just wasn't enough
# margin on this box, which DUR-151 already flagged as routinely oversubscribed
# with concurrent agent runs; a real container recreate can take meaningfully
# longer than a bare-process boot under that contention. Widened to 180s
# (60 * 3s) so a slow-but-healthy boot doesn't get killed and rolled back.
HEALTH_RETRIES="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES:-60}"
HEALTH_SLEEP_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP:-3}"
# DUR-163: a `docker build` for a large batch of commits saturates this same
# box (measured load average 13+ on 4 CPUs) right before the health check
# starts probing it — at that load, curl can fail to even complete a TCP
# connect within a couple of seconds, which used to be indistinguishable from
# the server actually refusing/being down. These are separate per-PROBE
# budgets (well under HEALTH_SLEEP_SECONDS) so one stuck probe doesn't eat
# into the next one's turn.
HEALTH_CONNECT_TIMEOUT_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_CONNECT_TIMEOUT:-5}"
HEALTH_MAX_TIME_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_MAX_TIME:-10}"
# How long to wait for the target port to accept a bare TCP connection before
# starting to spend the timed HEALTH_RETRIES budget on it at all — a
# container that hasn't opened its port yet is still booting, not unhealthy,
# and shouldn't burn through retries meant for a slow-to-become-healthy
# process.
PORT_WAIT_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_PORT_WAIT_SECONDS:-30}"
# DUR-3905: overridable so tests can point check_ci_status() at a local fake
# HTTP server instead of the real GitHub API.
GITHUB_API_BASE="${PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE:-https://api.github.com}"
# Durable, on-host location for the failing container's logs, captured just
# before a rollback recreates it and destroys them — see maybe_rollback()
# and capture_failure_diagnostics() (DUR-163's evidence gap). Deliberately
# NOT under deployTargetPath (a git checkout that gets reset --hard) or
# inside any container (which is exactly what's being replaced).
FAILURE_LOG_DIR="${PAPERCLIP_DEPLOY_RUNNER_FAILURE_LOG_DIR:-$REPO_DIR/deploy-failure-logs}"
# How hard to try to actually deliver the outcome comment before giving up
# and leaving the approval unprocessed for the next poll cycle. Sized to
# outlast a `docker exec` blip while the server container itself is being
# recreated by a deploy earlier in the same loop.
COMMENT_RETRIES="${PAPERCLIP_DEPLOY_RUNNER_COMMENT_RETRIES:-12}"
COMMENT_RETRY_SLEEP_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_COMMENT_RETRY_SLEEP:-5}"
# Machine-readable activity feed (DUR-44), written into the same shared
# volume the server container mounts at /paperclip — read it back with
# GET /api/companies/:companyId/deploy-runner/status.
STATUS_PATH="${PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH:-/paperclip/deploy-runner/status.jsonl}"
# DUR-259: how long a compose_recreate/compose_build_swap recipe waits for
# in-flight heartbeat runs (across every company, not just this approval's)
# to finish before recreating the shared docker-server-1 container — see
# maybe_begin_quiet_mode_drain(). Deliberately generous: this only blocks
# the ONE approval currently being processed, not the rest of the poll
# cycle's dispatch, and shutdown()'s own in-process drain (DUR-257,
# PAPERCLIP_SHUTDOWN_DRAIN_TIMEOUT_MS, default 240s) is the fallback net
# once the recreate actually starts either way.
QUIET_MODE_DRAIN_TIMEOUT_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_DRAIN_TIMEOUT_SECONDS:-240}"
QUIET_MODE_DRAIN_POLL_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_DRAIN_POLL_SECONDS:-5}"
# DUR-3965: quiet mode lives in Paperclip's OWN database and is only reachable
# through Paperclip's OWN API. When the deploy being rolled back IS Paperclip,
# that API is down at exactly the moment this runner needs to undo the drain --
# which on 2026-09-10 left the whole instance muted for 27 minutes (both
# companies idle, nothing on screen saying why) after a single failed deploy.
# So the deactivate is retried, with a bounded wait for the server to answer
# its health check again in between, and if it still cannot be delivered the
# failure is written to a marker file that the NEXT poll cycle picks up and
# retries -- silence must never be the resting state.
# DUR-3965: the reason this runner records when it switches quiet mode on.
# The runner authenticates as an instance admin, so without an explicit
# reason its activation is indistinguishable from an operator switching quiet
# mode on for the night — and the two need opposite treatment (the operator's
# overnight quota window is ~22 hours of deliberate silence; a drain the
# deploy never lifted is an incident after half an hour). Both the wording the
# operator sees and the retry below key off this value.
QUIET_MODE_ACTIVATE_REASON="${PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_REASON:-deploy}"
QUIET_MODE_DEACTIVATE_ATTEMPTS="${PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_DEACTIVATE_ATTEMPTS:-5}"
QUIET_MODE_DEACTIVATE_BACKOFF_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_DEACTIVATE_BACKOFF_SECONDS:-5}"
# How long to wait for the health-check URL to answer 200 again before
# spending the next deactivate attempt on a server that is still booting.
QUIET_MODE_RECOVERY_HEALTH_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_RECOVERY_HEALTH_SECONDS:-180}"
# Durable, on-host record of "quiet mode is still on and I could not turn it
# off". Deliberately outside deployTargetPath and outside any container, for
# the same reason FAILURE_LOG_DIR is: the thing that failed is the container.
# Written at the START of the drain, not when the retries give up: the EXIT
# trap that normally undoes the drain does not run on SIGTERM or SIGKILL, so
# `systemctl stop` mid-deploy or the box rebooting would otherwise leave quiet
# mode on with no marker at all — and the next-cycle retry below would have
# nothing to act on. Removed again as soon as a deactivate succeeds.
QUIET_MODE_PENDING_MARKER="${PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_MARKER:-$REPO_DIR/.deploy-runner-quiet-mode-pending}"
# DUR-3923: only deploy-LOOKING cards (deploy_pr, rollout, ...) approved within
# this window get the "nothing acts on this" comment. Without a bound, the
# first poll cycle after this runner ships would comment on every historically
# approved deploy_pr-style card across every company -- and mirror each one
# onto its linked issues -- which is noise, not help: those cards were decided
# long ago and nobody is waiting on them. Matches
# DEPLOY_APPROVAL_FEEDBACK_MAX_AGE_MS (24h) in
# server/src/services/deploy-approval-feedback.ts. Real kind:"deploy" cards
# are NOT bounded by this: a deploy that was approved is still meant to happen.
UNSUPPORTED_KIND_MAX_AGE_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_UNSUPPORTED_MAX_AGE_SECONDS:-86400}"
# DUR-3967: a still-running build is a WAIT, not a verdict. The normal
# sequence is: an agent merges, files the deploy card, GitHub starts CI on the
# merge commit, and the operator approves within the minute -- so the very
# first time this runner looks at a freshly approved card, CI is almost always
# still "pending". Until now that answer was terminal: the card was commented
# on, marked processed, and never looked at again, so a build that went green
# two minutes later simply never shipped and the card sat there reading
# "approved" forever (card ca143f73 / commit 3a372317, 2026-09-10 -- recovered
# only by hand-editing the processed-set file on the box). A pending build now
# leaves the card UNPROCESSED so the next timer tick (every 60s) re-checks it,
# bounded by this deadline measured from the approval's own decidedAt. Only
# when the deadline passes does the card become terminal. "failure" (a build
# that actually went red) is deliberately NOT covered by any of this: that
# needs a person, and stays terminal exactly as before.
CI_WAIT_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS:-2700}"
# The runner ticks every 60s; a card can legitimately wait out the whole
# deadline above. Neither the log nor the machine-readable status feed may get
# a line per tick for the same waiting card, or a held deploy drowns out
# everything else in them. The operator-facing COMMENT is stricter still:
# exactly one when the wait starts and one at the deadline, never on the ticks
# in between (see handle_ci_pending).
CI_WAIT_LOG_INTERVAL_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_LOG_INTERVAL_SECONDS:-600}"
# Which cards are currently waiting on their checks, and when each one was
# last mentioned in the log/status feed. One TAB-separated line per approval:
# `<approval id>\t<first seen epoch>\t<last announced epoch>`. Kept next to the
# processed-set for the same reason it is a file at all -- each tick is a
# separate process, so "have I already said this?" has to survive on disk.
CI_WAIT_STATE="${PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_STATE:-$REPO_DIR/.deploy-runner-ci-waiting}"
# process_approval's exit status for "this card is not finished with -- leave
# it unprocessed and look again next tick". Distinct from 0 (done, a comment
# was delivered) and 1 (no comment could be delivered), both of which already
# mean something specific to run_one_approval.
DEPLOY_HELD_STATUS=10

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

cli_json() { # subcommand args... -> JSON on stdout (runs inside the server container)
  docker exec "$DOCKER_SERVER_CONTAINER" sh -lc "$CLI $* $ARGS" 2>>"$LOG"
}

# Mirrors every comment attempt (delivered or not) into $STATUS_PATH inside
# the server container's volume. Best-effort only — never affects whether
# the approval is considered processed.
#
# DUR-152: `outcome`/`commit` are optional structured fields alongside the
# free-text `body` a human reads. `deploy-completion-gate.ts` used to be able
# to confirm a deploy ONLY by string-matching `body` for the runner's own
# literal success sentence — which a superseded-but-actually-live approval
# can never contain (see run_superseded_approval / the DUR-137 guard branch
# in process_approval, both of which now pass outcome="carried"). Passing a
# structured outcome instead of growing more special-cased substrings keeps
# that matching honest and machine-checkable.
record_status() { # approval_id, company_id, body, delivered(0/1), outcome(optional), commit(optional)
  local aid="$1" company_id="$2" body="$3" delivered="$4" outcome="${5:-}" commit="${6:-}" line
  line="$(AID="$aid" COMPANY_ID="$company_id" BODY="$body" DELIVERED="$delivered" OUTCOME="$outcome" COMMIT="$commit" TS="$(ts)" python3 -c '
import json, os
entry = {
    "ts": os.environ["TS"],
    "approvalId": os.environ["AID"],
    "companyId": os.environ["COMPANY_ID"],
    "commentDelivered": os.environ["DELIVERED"] == "0",
    "body": os.environ["BODY"],
}
if os.environ.get("OUTCOME"):
    entry["outcome"] = os.environ["OUTCOME"]
if os.environ.get("COMMIT"):
    entry["commit"] = os.environ["COMMIT"]
print(json.dumps(entry))
' 2>>"$LOG")"
  [ -z "$line" ] && return 0
  docker exec -e STATUS_LINE="$line" -e STATUS_PATH="$STATUS_PATH" "$DOCKER_SERVER_CONTAINER" sh -lc \
    'mkdir -p "$(dirname "$STATUS_PATH")" && printf "%s\n" "$STATUS_LINE" >> "$STATUS_PATH" && tail -n 500 "$STATUS_PATH" > "$STATUS_PATH.tmp" 2>/dev/null && mv "$STATUS_PATH.tmp" "$STATUS_PATH"' \
    >/dev/null 2>>"$LOG" || log "runner: $aid failed to record status line (non-fatal)"
}

comment() { # approval_id, company_id, body, outcome(optional), commit(optional) -> 0 if delivered, 1 if not (after retries)
  local aid="$1" company_id="$2" body="$3" outcome="${4:-}" commit="${5:-}" attempt=1 delivered=1
  while [ "$attempt" -le "$COMMENT_RETRIES" ]; do
    if docker exec -e BODY="$body" "$DOCKER_SERVER_CONTAINER" sh -lc \
         "$CLI approval comment $aid --body \"\$BODY\" $ARGS" >/dev/null 2>>"$LOG"; then
      delivered=0
      break
    fi
    log "runner: $aid comment attempt $attempt/$COMMENT_RETRIES failed"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$COMMENT_RETRIES" ] && sleep "$COMMENT_RETRY_SLEEP_SECONDS"
  done
  if [ "$delivered" -ne 0 ]; then
    log "runner: $aid could not deliver a comment after $COMMENT_RETRIES attempts — will retry next poll cycle"
  fi
  record_status "$aid" "$company_id" "$body" "$delivered" "$outcome" "$commit"
  mirror_comment_to_linked_issues "$aid" "$body"
  return "$delivered"
}

# Best-effort mirror of a deploy outcome comment onto every issue linked to
# the approval — not just the approval object itself. Without this, a deploy
# failure (e.g. a bad projectId in the approval payload) is only ever visible
# on the approval, which nobody watching the issue thread has any reason to
# check (the DUR-98/DUR-136 silent-failure pattern: an issue can sit
# `in_review` looking done while its deploy quietly failed). Never affects
# whether the approval itself is considered processed — a failure here is
# logged and swallowed, same as record_status.
mirror_comment_to_linked_issues() { # approval_id, body
  local aid="$1" body="$2" issue_ids issue_id
  issue_ids="$(docker exec "$DOCKER_SERVER_CONTAINER" sh -lc "$CLI approval issues $aid $ARGS" 2>>"$LOG" | \
    python3 -c 'import json,sys
try:
    items = json.load(sys.stdin)
except Exception:
    items = []
for i in items:
    iid = i.get("id") if isinstance(i, dict) else None
    if iid:
        print(iid)
' 2>>"$LOG")"
  [ -z "${issue_ids//[[:space:]]/}" ] && return 0
  while IFS= read -r issue_id; do
    [ -z "$issue_id" ] && continue
    docker exec -e BODY="$body" "$DOCKER_SERVER_CONTAINER" sh -lc \
      "$CLI issue comment $issue_id --body \"\$BODY\" $ARGS" >/dev/null 2>>"$LOG" || \
      log "runner: $aid could not mirror comment onto issue $issue_id (non-fatal)"
  done <<< "$issue_ids"
}

already_processed() { grep -qxF "$1" "$PROCESSED" 2>/dev/null; }
# DUR-3967: marking a card processed is the ONE place every terminal outcome
# passes through -- a deploy, a red build, a superseded card, an unsupported
# kind, the crash fallback, and every early return in process_approval that
# never reaches the CI gate at all. Dropping the wait-state row here means no
# path can end a card and leave it listed as "waiting on its checks" forever.
mark_processed() { echo "$1" >> "$PROCESSED"; ci_wait_state_clear "$1"; }

now_epoch() { date -u +%s; }

# DUR-3967: ISO-8601 (with or without a trailing Z) -> epoch seconds. Prints
# nothing when the value is missing or unparseable, and every caller treats
# that as "I don't know when this was decided" rather than as a number.
epoch_of() { # iso8601 -> stdout: epoch seconds, or empty
  [ -n "${1:-}" ] || return 0
  python3 -c '
import sys
from datetime import datetime, timezone
text = sys.argv[1].strip()
if text.endswith("Z") or text.endswith("z"):
    text = text[:-1] + "+00:00"
try:
    parsed = datetime.fromisoformat(text)
except ValueError:
    raise SystemExit(0)
if parsed.tzinfo is None:
    parsed = parsed.replace(tzinfo=timezone.utc)
print(int(parsed.timestamp()))
' "$1" 2>/dev/null
}

# DUR-3967 wait-state file (see CI_WAIT_STATE). Three tiny helpers rather than
# inline awk at each call site, so the "one line per approval" invariant lives
# in one place.
ci_wait_state_get() { # aid -> stdout: "<first seen epoch>\t<last announced epoch>"; exit 1 if this card is not waiting
  [ -f "$CI_WAIT_STATE" ] || return 1
  awk -F'\t' -v id="$1" '$1 == id { print $2 "\t" $3; found = 1; exit } END { if (!found) exit 1 }' "$CI_WAIT_STATE" 2>/dev/null
}

ci_wait_state_put() { # aid, first_seen_epoch, last_announced_epoch
  local aid="$1" first="$2" last="$3" tmp="$CI_WAIT_STATE.tmp.$$"
  {
    if [ -f "$CI_WAIT_STATE" ]; then awk -F'\t' -v id="$aid" '$1 != id' "$CI_WAIT_STATE"; fi
    printf '%s\t%s\t%s\n' "$aid" "$first" "$last"
  } > "$tmp" 2>>"$LOG" && mv "$tmp" "$CI_WAIT_STATE" 2>>"$LOG" || {
    rm -f "$tmp" 2>/dev/null
    log "runner: $aid could not update the waiting-for-checks state file $CI_WAIT_STATE (it may be announced again next tick)"
  }
}

ci_wait_state_clear() { # aid
  [ -f "$CI_WAIT_STATE" ] || return 0
  local tmp="$CI_WAIT_STATE.tmp.$$"
  awk -F'\t' -v id="$1" '$1 != id' "$CI_WAIT_STATE" > "$tmp" 2>>"$LOG" && mv "$tmp" "$CI_WAIT_STATE" 2>>"$LOG" || rm -f "$tmp" 2>/dev/null
  return 0
}

# DUR-3967: belt and braces for the file above. mark_processed() clears a
# card's row as it ends, but this file also survives crashes, kill -9 mid-
# deploy, and rows written by an older version of this script that had no
# clearing at all. Anything already in the processed set is finished with by
# definition, so its row is dead weight -- and a stale row is not inert: the
# "unknown means keep waiting" guard in process_approval keys off exactly this
# file. Runs once per poll cycle.
ci_wait_state_prune() {
  [ -f "$CI_WAIT_STATE" ] || return 0
  [ -f "$PROCESSED" ] || return 0
  local tmp="$CI_WAIT_STATE.tmp.$$"
  awk -F'\t' 'NR == FNR { done[$0] = 1; next } !($1 in done)' "$PROCESSED" "$CI_WAIT_STATE" > "$tmp" 2>>"$LOG" \
    && mv "$tmp" "$CI_WAIT_STATE" 2>>"$LOG" || rm -f "$tmp" 2>/dev/null
  return 0
}

# Resolve approval + project JSON into a shell-safe block of KEY='value'
# assignments (via `eval`) so bash never has to hand-parse JSON itself.
# Exits non-zero (with a REASON on stderr) if the request doesn't resolve to
# a valid, matching, enabled deploy policy.
resolve_deploy_vars() {
  python3 - "$1" "$2" <<'PY'
import json, shlex, sys

approval = json.loads(sys.argv[1])
project = json.loads(sys.argv[2])

payload = approval.get("payload") or {}
project_id = payload.get("projectId")
workspace_id = payload.get("workspaceId")
commit = payload.get("commit") or ""
title = payload.get("title") or ""
allow_backward_deploy = "1" if payload.get("allowBackwardDeploy") else ""

policy = project.get("deployPolicy") or {}
if not policy.get("enabled"):
    print(f"deploy_policy is disabled or missing for project {project_id}", file=sys.stderr)
    sys.exit(1)
if policy.get("workspaceId") != workspace_id:
    print(
        f"payload.workspaceId ({workspace_id}) does not match the project's configured "
        f"deploy_policy.workspaceId ({policy.get('workspaceId')}) — refusing to deploy",
        file=sys.stderr,
    )
    sys.exit(1)

workspaces = project.get("workspaces") or []
workspace = next((w for w in workspaces if w.get("id") == workspace_id), None)
if workspace is None:
    print(f"workspace {workspace_id} not found on project {project_id}", file=sys.stderr)
    sys.exit(1)

repo_url = workspace.get("repoUrl") or ""
repo_ref = workspace.get("repoRef") or workspace.get("defaultRef") or "main"
if not repo_url:
    print(f"workspace {workspace_id} has no repoUrl — nothing to fetch", file=sys.stderr)
    sys.exit(1)

deploy_kind = policy.get("deployKind") or "custom"
if deploy_kind not in ("compose_recreate", "compose_build_swap", "custom"):
    print(f"unknown deployKind {deploy_kind!r}", file=sys.stderr)
    sys.exit(1)
deploy_target_path = policy.get("deployTargetPath") or ""
if not deploy_target_path:
    print("deploy_policy.deployTargetPath is empty", file=sys.stderr)
    sys.exit(1)
deploy_services = " ".join(str(s) for s in (policy.get("deployServices") or []))
deploy_command = policy.get("deployCommand") or ""
compose_files = " ".join(str(f) for f in (policy.get("composeFiles") or []))
env_file = policy.get("envFile") or ""
health_check_url = policy.get("healthCheckUrl") or ""
if not health_check_url:
    print("deploy_policy.healthCheckUrl is empty", file=sys.stderr)
    sys.exit(1)
# DUR-3974: the real pages that must still work after this deploy. Newline
# separated (never space) so a path is never split by accident; entries that
# contain whitespace are dropped here rather than silently probed as two
# broken half-URLs.
app_health_paths = "\n".join(
    entry
    for entry in (str(p).strip() for p in (policy.get("appHealthCheckPaths") or []))
    if entry and not any(c.isspace() for c in entry)
)
rollback = policy.get("rollback") or "none"

fields = {
    "DV_PROJECT_ID": project_id or "",
    "DV_WORKSPACE_ID": workspace_id or "",
    "DV_COMMIT": commit,
    "DV_TITLE": title,
    "DV_REPO_URL": repo_url,
    "DV_REPO_REF": repo_ref,
    "DV_DEPLOY_KIND": deploy_kind,
    "DV_DEPLOY_TARGET_PATH": deploy_target_path,
    "DV_DEPLOY_SERVICES": deploy_services,
    "DV_DEPLOY_COMMAND": deploy_command,
    "DV_COMPOSE_FILES": compose_files,
    "DV_ENV_FILE": env_file,
    "DV_HEALTH_CHECK_URL": health_check_url,
    "DV_APP_HEALTH_PATHS": app_health_paths,
    "DV_ROLLBACK": rollback,
    "DV_ALLOW_BACKWARD_DEPLOY": allow_backward_deploy,
}
for key, value in fields.items():
    print(f"{key}={shlex.quote(value)}")
PY
}

load_average() { # -> 1-minute load average, or "unknown" if /proc/loadavg isn't available
  awk '{print $1}' /proc/loadavg 2>/dev/null || echo unknown
}

# Classifies one curl(1) exit status + http_code pair (DUR-163). A refused
# connection (curl exit 7) or one that never completed within the per-probe
# budget (exit 28) means the box never actually answered — that is NOT the
# same finding as a real HTTP response that just isn't 200, and must not be
# reported identically. Anything else that kept curl from getting a response
# (DNS, TLS, etc.) is bucketed separately as "unreachable" rather than folded
# into either specific case.
probe_verdict() { # curl_exit_status, http_code -> ok | http_error | refused | timeout | unreachable
  local curl_status="$1" code="$2"
  if [ "$curl_status" -eq 0 ]; then
    if [ "$code" = "200" ]; then echo ok; else echo http_error; fi
    return
  fi
  case "$curl_status" in
    7) echo refused ;;
    28) echo timeout ;;
    *) echo unreachable ;;
  esac
}

# Waits up to $timeout seconds for a bare TCP connect to the health-check
# URL's host:port to succeed — no HTTP request sent, just "has the container
# opened its port at all". Returns as soon as a connect succeeds (or the URL
# has no discernible host, in which case there's nothing to wait on); returns
# 1 if the timeout elapses with the port never accepting a connection.
wait_for_port() { # url, timeout_seconds
  local url="$1" timeout="$2"
  python3 - "$url" "$timeout" <<'PY' 2>/dev/null
import socket, sys, time
from urllib.parse import urlparse

url, timeout = sys.argv[1], float(sys.argv[2])
parsed = urlparse(url)
host = parsed.hostname
if not host:
    sys.exit(0)
port = parsed.port or (443 if parsed.scheme == "https" else 80)
deadline = time.time() + timeout
while True:
    try:
        with socket.create_connection((host, port), timeout=2):
            sys.exit(0)
    except OSError:
        if time.time() >= deadline:
            sys.exit(1)
        time.sleep(1)
PY
}

health_check() { # url -> 0 if any of HEALTH_RETRIES probes returns HTTP 200
  local url="$1" code curl_status verdict load attempt

  if ! wait_for_port "$url" "$PORT_WAIT_SECONDS"; then
    log "runner: health check: $url never accepted a TCP connection within ${PORT_WAIT_SECONDS}s (load $(load_average)) — the container may never have opened its port"
  fi

  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    load="$(load_average)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" --max-time "$HEALTH_MAX_TIME_SECONDS" "$url")"
    curl_status=$?
    verdict="$(probe_verdict "$curl_status" "$code")"
    if [ "$verdict" = ok ]; then
      log "runner: health probe $attempt/$HEALTH_RETRIES ok (http_code=200 load=$load)"
      return 0
    fi
    log "runner: health probe $attempt/$HEALTH_RETRIES $verdict (curl_status=$curl_status http_code=${code:-000} load=$load)"
    sleep "$HEALTH_SLEEP_SECONDS"
  done
  return 1
}

# DUR-3974 ---------------------------------------------------------------
# health_check() above answers one question: did SOMETHING answer 200 at the
# one address the project has configured. On 2026-09-10 that address was a
# login page that renders without reading the database at all, so it kept
# answering 200 through five and a half minutes in which every page that loads
# companies returned 500. The deploy declared itself healthy, no rollback
# fired, and the window was only noticed afterwards.
#
# So a deploy is also checked against REAL pages of the app — and it is
# checked DIFFERENTIALLY: how each page answers is recorded immediately before
# anything is touched, and compared with how it answers afterwards. Only a
# page that worked before and is broken after — a server error, or no answer
# at all — can fail a deploy. That is the whole reason this check cannot cause
# a false rollback:
#   - a page that is already broken answers the same before and after;
#   - a login wall (401/403), a redirect (3xx) and a missing page (404) are
#     all "not broken" and pass;
#   - a page nothing could reach before (no answer at all) is skipped
#     entirely, since there is no working state to have regressed from;
#   - a slow-to-warm app gets PAGE_CHECK_RETRIES attempts before any verdict,
#     and those attempts now cover "the port isn't open yet" too.
# The only thing that fails is the thing the operator would call breakage: a
# page that used to work and now returns a server error or nothing at all.
PAGE_CHECK_RETRIES="${PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_RETRIES:-10}"
PAGE_CHECK_SLEEP_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_SLEEP:-3}"
# How long to wait for the ROLLED-BACK version to answer before re-checking the
# pages and telling the operator whether the site came back. `docker compose up
# -d --force-recreate` returns when the container has started, not when the
# server inside it is listening, so a re-check fired the instant the rollback
# recipe returns is reading a booting app — and it is the one re-check whose
# answer the operator acts on. Same order of magnitude as the deploy's own
# health budget (HEALTH_RETRIES * HEALTH_SLEEP_SECONDS = 180s by default), and
# bounded so a rollback into a dead server cannot hang the runner.
ROLLBACK_HEALTH_WAIT_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_ROLLBACK_HEALTH_WAIT_SECONDS:-180}"

probe_http_code() { # url -> stdout: the HTTP status, or 000 when nothing answered at all
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" --max-time "$HEALTH_MAX_TIME_SECONDS" "$1" 2>/dev/null)"
  case "$code" in
    ''|*[!0-9]*) code="000" ;;
  esac
  printf '%s' "$code"
}

is_server_error() { # http code -> 0 if it is a 5xx
  case "$1" in
    5[0-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

# DUR-3974 follow-up: "broken" is not only a 5xx. probe_http_code() prints 000
# when nothing answered at all — connection refused, the port never reopened,
# the container gone — and that is the single clearest way a deploy can break a
# page: the app is simply not there any more. An earlier version of this file
# only ever asked is_server_error(), so a page that answered 200 before and
# answered NOTHING after was logged as "still works after the deploy (was 200,
# now 000)" and passed. That inverted the whole feature: a deploy that took the
# application completely down sailed through the check written to catch exactly
# that. Both shapes are "down" now.
#
# This deliberately stays a comparison, not a verdict: 000 only counts against
# a deploy when the page answered something before it (see the baseline skips
# in verify_pages_after_deploy), so a page that was unreachable all along, or a
# host that is firewalled from the box, still cannot roll anything back.
is_page_down() { # http code -> 0 if the page is broken (a 5xx, or no answer at all)
  [ "$1" = "000" ] && return 0
  is_server_error "$1"
}

# 000 is a curl detail, not something to show an operator.
describe_http_code() { # http code -> stdout: the code, or plain words for "no answer"
  if [ "$1" = "000" ]; then printf 'nothing at all'; else printf '%s' "$1"; fi
}

# The absolute addresses of the pages to check. Each configured entry is
# either already a full http(s) address or a path resolved against the health
# check address's own origin, so the operator never has to repeat the host.
# With nothing configured the front page is the only page the runner can name
# on its own — better than nothing, and the deploy comment says out loud that
# this is all that was checked.
app_health_check_urls() { # health_check_url, newline_separated_paths -> stdout: one absolute URL per line
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import sys
from urllib.parse import urljoin, urlparse

base, raw = sys.argv[1], sys.argv[2]
parsed = urlparse(base)
origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
entries = [line.strip() for line in raw.splitlines() if line.strip()]
if not entries:
    entries = ["/"]
urls, seen = [], set()
for entry in entries:
    if entry.startswith("http://") or entry.startswith("https://"):
        url = entry
    elif origin:
        url = urljoin(origin + "/", entry.lstrip("/"))
    else:
        continue
    if url not in seen:
        seen.add(url)
        urls.append(url)
print("\n".join(urls))
PY
}

# Reads how every page answers RIGHT NOW, before the deploy changes anything.
# One line per page: "<url><TAB><http code>".
capture_page_baseline() { # aid, health_check_url, paths -> stdout: the baseline
  local aid="$1" url code urls
  urls="$(app_health_check_urls "$2" "$3")"
  [ -n "${urls//[[:space:]]/}" ] || return 0
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    code="$(probe_http_code "$url")"
    log "runner: $aid before the deploy: $url answered $code"
    printf '%s\t%s\n' "$url" "$code"
  done <<< "$urls"
}

# Compares the pages against that baseline. Prints the regressed ones (a
# human-readable, comma-separated list) and returns 1; returns 0 when nothing
# that worked before is broken now.
verify_pages_after_deploy() { # aid, baseline -> 0 nothing regressed, 1 something did
  local aid="$1" baseline="$2" url before now attempt broken=""
  [ -n "${baseline//[[:space:]]/}" ] || return 0
  while IFS=$'\t' read -r url before; do
    [ -n "$url" ] || continue
    if [ "$before" = "000" ]; then
      log "runner: $aid skipping $url — nothing answered there before the deploy either, so there is no working state to compare against"
      continue
    fi
    if is_server_error "$before"; then
      log "runner: $aid skipping $url — it was already answering $before before the deploy, so this deploy did not break it"
      continue
    fi
    # The retry budget is what keeps a slow-starting app from being read as a
    # failure, and it now covers "nothing answered yet" as well as a 5xx — an
    # app still opening its port gets every one of these attempts before any
    # verdict, where before it got none (000 left the loop on the first pass).
    attempt=1
    while :; do
      now="$(probe_http_code "$url")"
      is_page_down "$now" || break
      [ "$attempt" -ge "$PAGE_CHECK_RETRIES" ] && break
      attempt=$((attempt + 1))
      sleep "$PAGE_CHECK_SLEEP_SECONDS"
    done
    if is_page_down "$now"; then
      log "runner: $aid $url answered $before before the deploy and $(describe_http_code "$now") after it, on all $attempt attempts"
      broken="${broken}${broken:+, }$url (answered $before before, $(describe_http_code "$now") now)"
    else
      log "runner: $aid $url still works after the deploy (was $before, now $now)"
    fi
  done <<< "$baseline"
  [ -z "$broken" ] && return 0
  printf '%s' "$broken"
  return 1
}

# DUR-3965: a small, separately-budgeted "is the server answering again yet?"
# wait, used only while trying to undo the quiet-mode drain after a failed
# deploy. Deliberately NOT health_check(): that one owns the deploy's own
# pass/fail verdict and its full HEALTH_RETRIES budget, and calling it here
# would both re-log a deploy verdict that was already decided and blow the
# time budget of a recovery step that must stay short.
wait_for_health() { # url, budget_seconds -> 0 as soon as a probe returns 200, 1 if the budget runs out
  local url="$1" budget="${2:-0}" waited=0 code curl_status step
  [ -n "$url" ] || return 1
  # The budget is spent in HEALTH_SLEEP_SECONDS steps — but that is tunable and
  # can legitimately be 0 (tests, a fast local loop), which would advance the
  # clock by nothing and spin here forever. Never count a step as less than a
  # second: this wait is a courtesy on a failure path and must always end.
  step="$HEALTH_SLEEP_SECONDS"
  [ "$step" -gt 0 ] 2>/dev/null || step=1
  while [ "$waited" -lt "$budget" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" --max-time "$HEALTH_MAX_TIME_SECONDS" "$url")"
    curl_status=$?
    [ "$(probe_verdict "$curl_status" "$code")" = ok ] && return 0
    sleep "$HEALTH_SLEEP_SECONDS"
    waited=$((waited + step))
  done
  return 1
}

# DUR-3905: owner/repo out of an https or ssh GitHub remote URL. Prints
# nothing (caller treats that as "can't tell" -> unknown/fail-open) for
# anything that isn't recognizably github.com, matching the credential
# helper's own github.com-only scope (paperclip-git-credential.sh) — there is
# no token that would work against any other host anyway.
github_owner_repo() { # repo_url -> stdout: "owner/repo" or empty
  python3 -c '
import re, sys
m = re.search(r"github\.com[:/]+([^/]+)/(.+?)(\.git)?/?$", sys.argv[1])
print(f"{m.group(1)}/{m.group(2)}" if m else "")
' "$1" 2>/dev/null
}

# DUR-3905: combined GitHub commit-status + check-runs verdict for a ref
# (branch name or commit SHA both work against GitHub's API). Never touches
# the local checkout. Always prints exactly one of:
#   success  - CI configured and every status/check-run is green
#   failure  - CI configured and at least one status/check-run is red
#   pending  - CI configured, nothing red yet, and something is still running
#   unknown  - no CI configured at all, the repo isn't github.com, or the
#              GitHub API call itself failed -- treated as fail-open by the
#              caller, same ambiguity-handling choice merge-pr-automation.ts
#              makes for the equivalent merge_pr gate.
#
# DUR-3967: "red beats still-running" is deliberate and is checked BEFORE
# pending. A check-run that has already COMPLETED with a failing conclusion is
# a known-red build even while some other job is still going, and the runner
# must stop on it rather than sit in the wait loop. The old ordering returned
# "pending" there, which since DUR-3967 means "hold the card and re-check it
# every 60s" -- so if somebody re-ran just the failed job and it went green
# inside the wait window, a build the operator had been told nothing about
# would ship on their original approval. A person deciding to re-run a red
# job is welcome to; they just have to file the deploy again afterwards.
check_ci_status() { # repo_url, ref_or_commit, github_token
  local repo_url="$1" ref="$2" token="$3" owner_repo status_json checkruns_json
  owner_repo="$(github_owner_repo "$repo_url")"
  if [ -z "$owner_repo" ]; then
    echo unknown
    return
  fi
  local auth_header=()
  [ -n "$token" ] && auth_header=(-H "authorization: Bearer $token")
  local encoded_ref
  encoded_ref="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ref")"
  status_json="$(curl -s --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" --max-time 15 \
    -H "accept: application/vnd.github+json" -H "x-github-api-version: 2022-11-28" \
    "${auth_header[@]}" \
    "$GITHUB_API_BASE/repos/$owner_repo/commits/$encoded_ref/status" 2>>"$LOG")"
  checkruns_json="$(curl -s --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" --max-time 15 \
    -H "accept: application/vnd.github+json" -H "x-github-api-version: 2022-11-28" \
    "${auth_header[@]}" \
    "$GITHUB_API_BASE/repos/$owner_repo/commits/$encoded_ref/check-runs" 2>>"$LOG")"
  STATUS_JSON="$status_json" CHECKRUNS_JSON="$checkruns_json" python3 -c '
import json, os

def load(env):
    try:
        parsed = json.loads(os.environ.get(env) or "")
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}

status = load("STATUS_JSON")
checkruns = load("CHECKRUNS_JSON")
total_status = status.get("total_count") or 0
runs = checkruns.get("check_runs") or []

def completed_red(run):
    # A check-run only has a verdict once it has completed; an unfinished one
    # has conclusion None and is "pending", not "red".
    return run.get("status") == "completed" and run.get(
        "conclusion"
    ) not in ("success", "neutral", "skipped")

if not total_status and not runs:
    print("unknown")
elif total_status and status.get("state") not in ("success", "pending"):
    print("failure")
elif any(completed_red(r) for r in runs):
    # DUR-3967: a check that has already finished red is terminal even while
    # other checks are still running -- see the ordering note above.
    print("failure")
elif total_status and status.get("state") == "pending":
    print("pending")
elif any(r.get("status") != "completed" for r in runs):
    print("pending")
else:
    print("success")
'
}

git_fetch_reset() { # target_dir, repo_url, ref_or_commit, github_token, allow_backward, dry_run, deploy_branch_ref -> stdout: resolved target commit (refusal path only); 0 ok, 1 fetch/resolve failed, 2 refused (would move backward), 3 refused (not reachable from deploy branch)
  local target_dir="$1" repo_url="$2" ref="$3" token="$4" allow_backward="${5:-}" dry_run="${6:-}" deploy_branch_ref="${7:-}"
  (
    cd "$target_dir" || exit 1
    if [ -n "$token" ]; then
      export GITHUB_TOKEN="$token"
    fi
    local fetch_refs=("$ref")
    if [ -n "$deploy_branch_ref" ] && [ "$deploy_branch_ref" != "$ref" ]; then
      fetch_refs+=("$deploy_branch_ref")
    fi
    git -c credential.helper= \
        -c "credential.https://github.com.helper=$GIT_CREDENTIAL_HELPER" \
        -c "credential.https://github.com.useHttpPath=false" \
        fetch --quiet origin "${fetch_refs[@]}" 2>>"$LOG" || \
      git -c credential.helper= \
          -c "credential.https://github.com.helper=$GIT_CREDENTIAL_HELPER" \
          -c "credential.https://github.com.useHttpPath=false" \
          fetch --quiet origin 2>>"$LOG" || exit 1
    # DUR-53: prefer the just-fetched remote-tracking ref (origin/$ref) when
    # $ref names a branch. Checking bare "$ref" first is a trap when this
    # checkout already has a local branch of the same name (the normal case
    # for a long-lived deploy target) — `git fetch origin custom` never moves
    # a local `custom` branch pointer, only `refs/remotes/origin/custom`, so
    # resolving "custom" hits the STALE local branch and `reset --hard`
    # becomes a silent no-op that still reports success at the old commit.
    # Only fall back to bare "$ref" for a pinned commit SHA, which has no
    # origin/<sha> equivalent.
    local target_commit
    if git rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
      target_commit="$(git rev-parse "origin/$ref")"
    else
      target_commit="$(git rev-parse --verify --quiet "$ref^{commit}" 2>/dev/null)" || exit 1
    fi

    # DUR-137: never let a reset move the checkout backward *silently*.
    # Approvals are grouped/ordered by decidedAt, not git ancestry, so a
    # stale approval (targeting a commit that shipped earlier) can end up
    # approved and processed after a newer commit is already live —
    # including across separate poll cycles, where the newer approval is
    # long since marked processed and isn't even in the same batch to
    # compare against. The only reliable check is against what's actually
    # checked out right now: if the target is an ancestor of (or equal to)
    # the current HEAD, resetting to it would discard everything that
    # shipped since. Refuse unless the approval explicitly opted in via
    # payload.allowBackwardDeploy — a genuine intentional rollback still
    # needs a way through, it just can't happen by accident.
    if [ -z "$allow_backward" ]; then
      local current_commit
      current_commit="$(git rev-parse HEAD 2>/dev/null || echo "")"
      if [ -n "$current_commit" ] && [ "$target_commit" != "$current_commit" ] && \
         git merge-base --is-ancestor "$target_commit" "$current_commit" 2>/dev/null; then
        # DUR-152: print the resolved commit so a caller that only wants to
        # know "is this commit already live" (never intending to deploy it
        # itself — e.g. a superseded approval checking what shipped under a
        # different approval) can record it, instead of only learning THAT
        # it was refused.
        printf '%s' "$target_commit"
        exit 2
      fi
    fi

    # DUR-229: the backward guard above only protects against moving
    # backward *on the same lineage* — it compares target_commit against
    # whatever is currently checked out, so a commit that only exists on an
    # unrelated branch (e.g. master, when this project deploys custom) is
    # never an ancestor of the current HEAD and sails through untouched, even
    # though resetting to it would silently discard everything the deploy
    # branch has that the other branch doesn't (see DUR-221). Independently
    # confirm target_commit is actually reachable from the *configured*
    # deploy branch's remote tip before ever resetting to it — not "isn't
    # behind HEAD", but "is actually on the branch we're supposed to be
    # deploying at all". No allow_backward-style override: unlike a genuine
    # rollback, there is no legitimate reason a deploy approval should point
    # off the configured deploy branch. Skipped (fails open) only when the
    # caller didn't pass a deploy_branch_ref or that ref doesn't resolve.
    if [ -n "$deploy_branch_ref" ]; then
      local deploy_branch_commit
      deploy_branch_commit="$(git rev-parse --verify --quiet "origin/$deploy_branch_ref^{commit}" 2>/dev/null)" || deploy_branch_commit=""
      if [ -n "$deploy_branch_commit" ] && [ "$target_commit" != "$deploy_branch_commit" ] && \
         ! git merge-base --is-ancestor "$target_commit" "$deploy_branch_commit" 2>/dev/null; then
        printf '%s' "$target_commit"
        exit 3
      fi
    fi

    if [ -n "$dry_run" ]; then
      # DUR-3974: report which commit the guards above just approved, not only
      # that they passed. process_approval now does its dry run, then drains,
      # then resets — and a branch tip can move during a drain that lasts up
      # to QUIET_MODE_DRAIN_TIMEOUT_SECONDS. Handing this commit back lets the
      # real reset be pinned to exactly what was checked, instead of
      # re-resolving the branch and deploying something nobody looked at.
      printf '%s' "$target_commit"
      exit 0
    fi

    git reset --hard --quiet "$target_commit"
  )
}

# DUR-259: whether $kind's run_recipe call is about to recreate the shared
# docker-server-1 container this script (and every company's agent
# heartbeat) talks to. "custom" is an operator-authored black box that may
# or may not touch it, so it's deliberately excluded — draining ahead of a
# recipe that never touches the shared container would just add latency to
# every such deploy for no safety benefit.
recreates_shared_container() { # kind -> 0 if yes, 1 if no
  case "$1" in
    compose_recreate|compose_build_swap) return 0 ;;
    *) return 1 ;;
  esac
}

quiet_mode_field() { # json, field -> stdout: field value ("" if missing/false/unparseable)
  printf '%s' "$1" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = d.get('$2')
if isinstance(v, bool):
    print('1' if v else '')
elif v is not None:
    print(v)
" 2>/dev/null
}

# DUR-259 proactive drain: freezes new agent wakes instance-wide (the DUR-224
# Quiet Mode mechanism, across ALL companies — not just this approval's) and
# waits up to QUIET_MODE_DRAIN_TIMEOUT_SECONDS for heartbeat runs already in
# flight to finish, so the `docker compose up -d --force-recreate`/`--no-build`
# call below finds nothing running to interrupt. Sets the global
# QUIET_MODE_OWNED_BY_RUNNER=1 iff THIS call is the one that activated quiet
# mode (vs. it already being active — e.g. an operator's own manual
# maintenance window), so the matching maybe_end_quiet_mode_drain call below
# knows whether it's this call's place to deactivate it again afterward.
# Best-effort throughout: any failure talking to the quiet-mode endpoints (or
# a full timeout with runs still in flight) is logged and swallowed — this
# makes a deploy's timing safer when it can, but must never block one
# outright. A still-in-flight run that gets recreated out from under it after
# a full timeout isn't given a dedicated status here (e.g. a "paused, will
# resume" status distinct from failed) — doing that safely means auditing
# every heartbeatRuns.status consumer (UI badges, success-rate/metrics,
# HEARTBEAT_RUN_TERMINAL_STATUSES-style sets), which is its own follow-up
# (DUR-259's child issue), not this drain wait.
QUIET_MODE_OWNED_BY_RUNNER=0
maybe_begin_quiet_mode_drain() { # aid, kind
  local aid="$1" kind="$2"
  QUIET_MODE_OWNED_BY_RUNNER=0
  recreates_shared_container "$kind" || return 0

  local status active
  status="$(cli_json instance quiet-mode:status)" || {
    log "runner: $aid could not read quiet-mode status before deploy — proceeding without a drain wait"
    return 0
  }
  active="$(quiet_mode_field "$status" active)"

  if [ -z "$active" ]; then
    if ! cli_json instance quiet-mode:activate --reason "$QUIET_MODE_ACTIVATE_REASON" >/dev/null; then
      log "runner: $aid could not activate quiet mode before deploy — proceeding without a drain wait"
      return 0
    fi
    QUIET_MODE_OWNED_BY_RUNNER=1
    # The marker goes down BEFORE the risky part, not after the retries fail:
    # a SIGTERM from `systemctl stop`, or the box rebooting mid-deploy, kills
    # this process without ever running the EXIT trap, and an instance left
    # muted with no marker is one nobody comes back for.
    quiet_mode_pending_marker_write "$aid"
    log "runner: $aid activated quiet mode instance-wide before recreating the shared container"
  else
    log "runner: $aid quiet mode was already active (external maintenance window) — draining under it, will leave it active afterward"
  fi

  local waited=0 count
  while [ "$waited" -lt "$QUIET_MODE_DRAIN_TIMEOUT_SECONDS" ]; do
    status="$(cli_json instance quiet-mode:status)" || break
    count="$(quiet_mode_field "$status" activeRunCount)"
    case "$count" in
      ''|*[!0-9]*) count="" ;;
    esac
    if [ -n "$count" ] && [ "$count" -eq 0 ]; then
      log "runner: $aid drain complete after ${waited}s — no in-flight heartbeat runs across any company"
      return 0
    fi
    sleep "$QUIET_MODE_DRAIN_POLL_SECONDS"
    waited=$((waited + QUIET_MODE_DRAIN_POLL_SECONDS))
  done

  status="$(cli_json instance quiet-mode:status)" || status=""
  count="$(quiet_mode_field "$status" activeRunCount)"
  [ -z "$count" ] && count="unknown"
  log "runner: $aid drain timed out after ${QUIET_MODE_DRAIN_TIMEOUT_SECONDS}s with $count heartbeat run(s) still in flight — marking them paused_for_restart before the recreate"
  # DUR-257 / DUR-296: the server can mark every in-flight run
  # paused_for_restart in one transaction (agents go idle, each affected
  # issue gets a continuation wake queued behind quiet mode). Without this
  # call the recreate kills the children and the runs surface as
  # process_lost failures with their agents stuck in "error" -- which is
  # exactly what happened on every deploy on 2026-09-06.
  local paused
  if paused="$(cli_json instance heartbeat-runs:pause-for-restart --reason "'"Paused for the platform deploy of approval $aid -- will resume automatically after the restart."'")"; then
    log "runner: $aid paused in-flight heartbeat runs for the restart: $(printf '%s' "$paused" | tr -d '\n' | cut -c1-200)"
  else
    log "runner: $aid could not mark in-flight runs paused_for_restart — proceeding anyway; they may surface as process_lost and be retried by the reaper"
  fi
}

# DUR-3965: one deactivate call is not enough. The failure mode that muted the
# instance for 27 minutes on 2026-09-10 is: the deploy fails, the rollback
# recreates the shared container, and the single `quiet-mode:deactivate` call
# lands while the server it is talking to is still booting (or crash-looping),
# so it fails and quiet mode simply stays on with nothing on screen saying so.
# Retries with backoff, and once waits (bounded) for the health-check URL to
# answer 200 again before spending a further attempt on a server that is
# demonstrably not up yet.
quiet_mode_deactivate_with_retries() { # aid, health_url -> 0 delivered, 1 gave up
  local aid="$1" health_url="${2:-}" attempt=1 delay="$QUIET_MODE_DEACTIVATE_BACKOFF_SECONDS" waited_for_health=0
  while :; do
    if cli_json instance quiet-mode:deactivate >/dev/null; then
      [ "$attempt" -gt 1 ] && log "runner: $aid deactivated quiet mode on attempt $attempt of $QUIET_MODE_DEACTIVATE_ATTEMPTS — agents can take work again"
      return 0
    fi
    log "runner: $aid could not deactivate quiet mode (attempt $attempt of $QUIET_MODE_DEACTIVATE_ATTEMPTS) — Paperclip's own API may still be coming back up after this deploy"
    [ "$attempt" -ge "$QUIET_MODE_DEACTIVATE_ATTEMPTS" ] && return 1
    if [ -n "$health_url" ] && [ "$waited_for_health" -eq 0 ]; then
      waited_for_health=1
      if wait_for_health "$health_url" "$QUIET_MODE_RECOVERY_HEALTH_SECONDS"; then
        log "runner: $aid $health_url is answering again — retrying the quiet-mode deactivate"
      else
        log "runner: $aid $health_url still not answering after ${QUIET_MODE_RECOVERY_HEALTH_SECONDS}s — retrying the quiet-mode deactivate anyway"
      fi
    else
      sleep "$delay"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done
}

quiet_mode_pending_marker_write() { # aid
  printf '%s\t%s\n' "$(ts)" "$1" > "$QUIET_MODE_PENDING_MARKER" 2>>"$LOG" || \
    log "runner: $1 could not write the quiet-mode marker file $QUIET_MODE_PENDING_MARKER"
}

maybe_end_quiet_mode_drain() { # aid, health_url(optional)
  local aid="$1" health_url="${2:-}"
  [ "${QUIET_MODE_OWNED_BY_RUNNER:-0}" -eq 1 ] || return 0
  # Cleared up front so this is idempotent: the outcome paths in
  # process_approval call it explicitly (so the drain ends before the
  # operator-facing comment is posted) and the EXIT trap in run_one_approval
  # calls it again as a safety net. Only the first call does any work.
  QUIET_MODE_OWNED_BY_RUNNER=0
  if quiet_mode_deactivate_with_retries "$aid" "$health_url"; then
    rm -f "$QUIET_MODE_PENDING_MARKER" 2>/dev/null
    return 0
  fi
  log "runner: $aid QUIET MODE IS STILL ON and could not be turned off after $QUIET_MODE_DEACTIVATE_ATTEMPTS attempts — no agent in ANY company will start work until it is cleared. The marker at $QUIET_MODE_PENDING_MARKER stays in place for the next poll cycle to retry; an operator can also clear it under Settings > Instance settings > General, or with \`instance quiet-mode:deactivate\`."
  quiet_mode_pending_marker_write "$aid"
  return 1
}

# DUR-3965: the next-tick half of the recovery. Runs at the top of every poll
# cycle, before any approval is dispatched, so an instance left muted by a
# deploy that failed while the API was down gets un-muted about a minute
# later instead of staying silent until a person happens to notice.
retry_pending_quiet_mode_deactivate() {
  [ -f "$QUIET_MODE_PENDING_MARKER" ] || return 0
  local marker status active reason
  marker="$(tr -d '\n' < "$QUIET_MODE_PENDING_MARKER" 2>/dev/null)"
  status="$(cli_json instance quiet-mode:status)" || {
    log "runner: quiet mode was left on by an earlier failed deploy ($marker) and the status endpoint is still unreachable — will retry next poll cycle"
    return 0
  }
  active="$(quiet_mode_field "$status" active)"
  if [ -z "$active" ]; then
    log "runner: quiet mode is off again (someone cleared it, or a later deploy did) — clearing the leftover marker from $marker"
    rm -f "$QUIET_MODE_PENDING_MARKER"
    return 0
  fi
  # DUR-3965: the quiet mode that is on NOW may not be the one this marker is
  # about — the operator can perfectly well have switched it on themselves
  # after the failed deploy (the overnight quota window is exactly that). The
  # server refuses to auto-clear a deliberate quiet mode; so does this. Only a
  # quiet mode whose recorded reason is this runner's own gets turned off.
  reason="$(quiet_mode_field "$status" activatedReason)"
  if [ -n "$reason" ] && [ "$reason" != "$QUIET_MODE_ACTIVATE_REASON" ]; then
    log "runner: quiet mode is on, but it was switched on deliberately (reason: $reason), not left behind by the failed deploy recorded at $marker — leaving it exactly as it is and dropping the leftover marker"
    rm -f "$QUIET_MODE_PENDING_MARKER"
    return 0
  fi
  # An empty reason means the server predates the recorded-reason field; the
  # marker is then the only evidence there is, and the 2026-09-10 failure
  # mode (an instance left muted with nobody coming back for it) is the worse
  # of the two risks.
  [ -z "$reason" ] && log "runner: quiet mode is on and this server does not record why — treating it as the drain left behind by the failed deploy recorded at $marker"
  if cli_json instance quiet-mode:deactivate >/dev/null; then
    log "runner: quiet mode was still on after the failed deploy recorded at $marker — turned it off now; every agent can take work again"
    rm -f "$QUIET_MODE_PENDING_MARKER"
    return 0
  fi
  log "runner: quiet mode is STILL on after the failed deploy recorded at $marker and could not be turned off — no agent in any company will do any work until it is cleared (Settings > Instance settings > General, or \`instance quiet-mode:deactivate\`)"
  return 1
}

# DUR-3974: one place that builds a `docker compose` invocation out of the
# project's optional composeFiles/envFile, so the pre-swap stop below and
# run_recipe cannot drift into disagreeing about which compose project they
# are talking to.
compose_cmd() { # target_dir, compose_files, env_file, args... -> docker compose's own exit status
  local target_dir="$1" compose_files="$2" env_file="$3"
  shift 3
  (
    cd "$target_dir" || exit 1
    local compose_args=() f
    [ -n "$env_file" ] && compose_args+=(--env-file "$env_file")
    for f in $compose_files; do compose_args+=(-f "$f"); done
    docker compose "${compose_args[@]}" "$@" >>"$LOG" 2>&1
  )
}

# DUR-3974: a compose_recreate deploy does not build anything — the ONLY way
# its `up -d --force-recreate` can put different code live is by the files in
# deployTargetPath being what the container runs. Which means the `git reset
# --hard` IS the moment the new code goes live, minutes before the recreate
# that applies the migrations the same commit carried. On 2026-09-10 the
# checkout was reset at 22:25:16 and those migrations did not land until
# 22:30:55; for five and a half minutes production served new code against the
# old schema and answered 500 on every page that reads the database.
#
# So where the operator has named which services run the code, stop exactly
# those before swapping the files. The recipe immediately after starts them
# again and the entrypoint applies the migrations as it does, so the new code
# is never served against a schema that has not caught up.
#
# Deliberately narrow:
#   - only compose_recreate. compose_build_swap puts code live at the swap,
#     not at the reset, and a custom command is a black box whose containers
#     this script has no business stopping.
#   - only when services are named. With none, `docker compose stop` means
#     "stop everything in the file", database included — a bigger and riskier
#     action than the one being made safe. Those deploys fall back to the
#     before/after page check, which rolls the deploy back rather than leaving
#     a broken version live.
# Set PAPERCLIP_DEPLOY_RUNNER_STOP_BEFORE_SWAP=0 on the box to switch it off.
STOP_BEFORE_SWAP="${PAPERCLIP_DEPLOY_RUNNER_STOP_BEFORE_SWAP:-1}"
SERVICES_STOPPED_BEFORE_SWAP=0
stop_services_before_swap() { # aid, target_dir, kind, services, compose_files, env_file -> 0 stopped, 1 not stopped
  local aid="$1" target_dir="$2" kind="$3" services="$4" compose_files="$5" env_file="$6"
  SERVICES_STOPPED_BEFORE_SWAP=0
  [ "$STOP_BEFORE_SWAP" = "1" ] || return 1
  [ "$kind" = "compose_recreate" ] || return 1
  if [ -z "${services//[[:space:]]/}" ]; then
    log "runner: $aid this project names no services, so the runner will not stop anything before swapping the files (stopping every service would take the database down too) — the before/after page check is what guards this deploy"
    return 1
  fi
  # shellcheck disable=SC2086
  if compose_cmd "$target_dir" "$compose_files" "$env_file" stop $services; then
    SERVICES_STOPPED_BEFORE_SWAP=1
    log "runner: $aid stopped $services before swapping the files, so the new code cannot be served before its migrations have run"
    return 0
  fi
  log "runner: $aid could not stop $services before swapping the files — continuing anyway; the before/after page check still guards this deploy"
  return 1
}

# The undo for the stop above, for the paths where the deploy gives up between
# the stop and the recipe that would have started the services again. Never
# leaves production stopped because a git fetch failed.
restart_services_after_abandoned_swap() { # aid, target_dir, services, compose_files, env_file
  local aid="$1" target_dir="$2" services="$3" compose_files="$4" env_file="$5"
  [ "${SERVICES_STOPPED_BEFORE_SWAP:-0}" -eq 1 ] || return 0
  SERVICES_STOPPED_BEFORE_SWAP=0
  [ -n "$target_dir" ] && [ -n "${services//[[:space:]]/}" ] || return 0
  log "runner: $aid starting $services again — this deploy stopped before it got as far as starting them itself"
  # shellcheck disable=SC2086
  compose_cmd "$target_dir" "$compose_files" "$env_file" start $services && return 0
  # shellcheck disable=SC2086
  compose_cmd "$target_dir" "$compose_files" "$env_file" up -d $services && return 0
  log "runner: $aid COULD NOT START $services AGAIN — they are still stopped and need a person. Check deploy-runner.log."
  return 1
}

run_recipe() { # target_dir, kind, services, command, compose_files, env_file
  # Exit status: 0 = ok; 3 = compose_build_swap's `build` step failed before
  # anything was swapped (the `&&` short-circuits `up --no-build`), so the
  # previously running container was never touched; 1 = the recipe failed
  # after touching the running container (compose_recreate, the swap half of
  # compose_build_swap, or a custom command we can't reason about).
  local target_dir="$1" kind="$2" services="$3" command="$4" compose_files="$5" env_file="$6"
  case "$kind" in
    compose_recreate)
      # shellcheck disable=SC2086
      compose_cmd "$target_dir" "$compose_files" "$env_file" up -d --force-recreate $services
      ;;
    compose_build_swap)
      # shellcheck disable=SC2086
      compose_cmd "$target_dir" "$compose_files" "$env_file" build $services || return 3
      # shellcheck disable=SC2086
      compose_cmd "$target_dir" "$compose_files" "$env_file" up -d --no-build $services
      ;;
    custom)
      (
        cd "$target_dir" || exit 1
        bash -c "$command" >>"$LOG" 2>&1
      )
      ;;
    *)
      return 1
      ;;
  esac
}

# DUR-3967: what to do about a card whose automated checks have not (yet) come
# back green -- either they are still running, or a later tick could no longer
# get an answer out of GitHub for a card we already know was mid-check.
# Returns $DEPLOY_HELD_STATUS while the card should stay unprocessed (the next
# tick re-checks it), or comment()'s delivery status once the deadline has
# passed and the card is finished with.
#
# Three things have to be true at once here:
#   * the wait must end (CI_WAIT_SECONDS from the approval's own decidedAt --
#     a card approved 40 minutes ago has 5 minutes left, not another 45),
#   * the operator gets exactly two comments across the whole wait: one when
#     it starts, one at the deadline. Nothing on the ticks in between, or a
#     45-minute wait posts 45 comments,
#   * the wait is still visible while it lasts -- so the log line and the
#     machine-readable status line are throttled (CI_WAIT_LOG_INTERVAL_SECONDS)
#     rather than dropped.
# The "have I already said this?" answer lives in $CI_WAIT_STATE because every
# tick is a fresh process. It is only written once the announcing comment has
# actually been DELIVERED, so a card whose comment could not be posted (server
# container mid-recreate) is announced properly on a later tick instead of
# waiting out its deadline in silence.
handle_ci_pending() { # aid, company_id, target_ref, decided_at, why(pending|unknown)
  local aid="$1" company_id="$2" target_ref="$3" decided_at="${4:-}" why="${5:-pending}"
  local now state first_seen last_announced decided_epoch started waited waited_minutes wait_minutes what

  # How the log describes what the last check actually returned. Never
  # operator-facing: from the card's point of view "still being checked" and
  # "we could not find out whether it is still being checked" are the same
  # situation and get the same two comments.
  if [ "$why" = "unknown" ]; then
    what="could not be read back from GitHub at all"
  else
    what="are still running"
  fi

  now="$(now_epoch)"
  first_seen=""
  last_announced=""
  if state="$(ci_wait_state_get "$aid")"; then
    first_seen="$(printf '%s' "$state" | cut -f1)"
    last_announced="$(printf '%s' "$state" | cut -f2)"
  fi
  case "$first_seen" in ''|*[!0-9]*) first_seen="" ;; esac
  case "$last_announced" in ''|*[!0-9]*) last_announced="" ;; esac

  # When the clock started. The wait is measured from the EARLIEST of: the
  # operator's own decision time (what the spec measures from and what the
  # comment quotes back), the first tick that saw this card waiting, and now.
  #
  # Taking the earliest, rather than preferring decidedAt outright, is what
  # keeps the wait bounded no matter what the timestamp says. A decidedAt
  # AHEAD of this host's clock -- a clock skew between the app container and
  # the box, a hand-edited row, a timezone bug upstream -- used to make
  # `now - started` negative, and clamping that to 0 pinned the wait at zero
  # seconds forever: the card was announced once and then held indefinitely,
  # re-hitting GitHub every 60s, never reaching the deadline and never telling
  # the operator anything again. min() cannot do that: `first_seen` and `now`
  # are both this host's own clock, so the elapsed time can only grow.
  decided_epoch="$(epoch_of "$decided_at")"
  case "$decided_epoch" in ''|*[!0-9]*) decided_epoch="" ;; esac
  started="$now"
  if [ -n "$first_seen" ] && [ "$first_seen" -lt "$started" ]; then started="$first_seen"; fi
  if [ -n "$decided_epoch" ] && [ "$decided_epoch" -lt "$started" ]; then started="$decided_epoch"; fi
  waited=$(( now - started ))
  [ "$waited" -lt 0 ] && waited=0
  # Rounded to the nearest minute, floor 1: the deadline note quotes how long
  # this card ACTUALLY waited, not the configured budget. A card the runner
  # only got back to after 90 minutes (single-flight: no tick happens at all
  # while another deploy is running) must not claim it gave up after 45.
  waited_minutes=$(( (waited + 30) / 60 ))
  [ "$waited_minutes" -lt 1 ] && waited_minutes=1
  wait_minutes=$(( CI_WAIT_SECONDS / 60 ))

  if [ "$waited" -ge "$CI_WAIT_SECONDS" ]; then
    log "runner: $aid giving up — the automated checks for $target_ref $what ${waited}s after the approval was decided (deadline ${CI_WAIT_SECONDS}s); nothing deployed"
    # Deliberately NOT clearing the wait state here. mark_processed() clears it
    # on every delivered/terminal path, and clearing it first is actively
    # dangerous: if this comment cannot be delivered (server container mid-
    # recreate), the card stays UNPROCESSED with its wait row already erased —
    # and a card with no wait row is exactly what tells the next tick that an
    # "unknown" verdict is a repo with no checks rather than one we have
    # already seen mid-check. That combination silently deploys an unproven
    # build. Losing state before the outcome is confirmed is the bug; keep the
    # row until something durable has actually happened.
    comment "$aid" "$company_id" "Deploy not started — the automated checks on this version had still not passed about $waited_minutes minutes after it was approved, so this deploy stopped waiting for them. Nothing was deployed and whatever was already live is untouched. Once the checks have passed, ask the agent that filed this deploy to file a new deploy approval for the same version. If the checks keep hanging or finish red, asking again will hit the same wall — someone has to fix what is failing first." "checks_timed_out"
    return
  fi

  if [ -z "$first_seen" ]; then
    log "runner: $aid waiting — the automated checks for $target_ref $what; will re-check every poll cycle for up to ${CI_WAIT_SECONDS}s from the approval"
    if comment "$aid" "$company_id" "Waiting for the automated checks — this version is still being checked automatically before it can go live, so the deploy has not started yet. You do not need to do anything: it will start on its own, usually within a minute or two of the checks passing, longer if another deploy is already running. If they are still not finished about $wait_minutes minutes after this was approved, the deploy will not go ahead and a note will be posted here saying so." "waiting_for_checks"; then
      ci_wait_state_put "$aid" "$now" "$now"
    else
      log "runner: $aid could not post the waiting-for-checks note — will try again next poll cycle"
    fi
    return "$DEPLOY_HELD_STATUS"
  fi

  # Already announced on an earlier tick: no comment, and only an occasional
  # log/status line so a long wait stays visible without flooding either.
  if [ -z "$last_announced" ] || [ $(( now - last_announced )) -ge "$CI_WAIT_LOG_INTERVAL_SECONDS" ]; then
    log "runner: $aid still waiting — the automated checks for $target_ref $what, ${waited}s into the ${CI_WAIT_SECONDS}s the runner will wait"
    record_status "$aid" "$company_id" "Still waiting for the automated checks on this version to finish before the deploy starts (${waited}s of up to ${CI_WAIT_SECONDS}s)." 1 "waiting_for_checks"
    ci_wait_state_put "$aid" "$first_seen" "$now"
  fi
  return "$DEPLOY_HELD_STATUS"
}

process_approval() { # approval_id, company_id -> comment()'s delivery status, or $DEPLOY_HELD_STATUS to be re-checked next tick
  local aid="$1" company_id="$2"

  local approval_json project_json
  approval_json="$(cli_json approval get "$aid")" || {
    log "runner: $aid could not re-fetch approval"
    comment "$aid" "$company_id" "Deploy failed — could not re-fetch the approval. Check deploy-runner.log on the server."
    return
  }

  # DUR-3967: when the operator actually decided this card. The wait deadline
  # for still-running checks is measured from here, not from whenever this
  # runner first happened to look at it.
  local decided_at
  decided_at="$(printf '%s' "$approval_json" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print(d.get("decidedAt") or d.get("updatedAt") or d.get("createdAt") or "")' 2>/dev/null)" || decided_at=""

  local project_id
  project_id="$(printf '%s' "$approval_json" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("payload") or {}).get("projectId") or "")')"
  if [ -z "$project_id" ]; then
    log "runner: $aid payload has no projectId"
    comment "$aid" "$company_id" "Deploy failed — approval payload has no projectId."
    return
  fi

  project_json="$(cli_json project get "$project_id" -C "$company_id")" || {
    log "runner: $aid could not fetch project $project_id"
    comment "$aid" "$company_id" "Deploy failed — could not fetch project $project_id."
    return
  }

  local vars reason
  if ! vars="$(resolve_deploy_vars "$approval_json" "$project_json" 2>/tmp/paperclip-deploy-runner-reason.$$)"; then
    reason="$(cat "/tmp/paperclip-deploy-runner-reason.$$" 2>/dev/null)"
    rm -f "/tmp/paperclip-deploy-runner-reason.$$"
    log "runner: $aid rejected — $reason"
    comment "$aid" "$company_id" "Deploy failed — $reason"
    return
  fi
  rm -f "/tmp/paperclip-deploy-runner-reason.$$"
  eval "$vars"

  if [ ! -d "$DV_DEPLOY_TARGET_PATH/.git" ]; then
    log "runner: $aid deployTargetPath $DV_DEPLOY_TARGET_PATH is not a git checkout"
    comment "$aid" "$company_id" "Deploy failed — deployTargetPath ($DV_DEPLOY_TARGET_PATH) is not set up as a git checkout on the box yet. An operator needs to \`git clone\` it there first."
    return
  fi

  local token
  token="$(cli_json secrets deploy-github-token -C "$company_id" | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("token") or "")' 2>/dev/null)" || token=""

  local target_ref="${DV_COMMIT:-$DV_REPO_REF}"

  # DUR-3905: check GitHub CI for $target_ref BEFORE touching the checkout at
  # all, so a red/still-running build never gets shipped in the first place —
  # this is a precondition, not a substitute for the health-check + rollback
  # below (which still guards against a build that passed CI but is broken in
  # a way CI doesn't catch).
  local ci_status
  ci_status="$(check_ci_status "$DV_REPO_URL" "$target_ref" "$token")"
  # DUR-3905 + DUR-3967: red and still-running are NOT the same finding.
  #   failure - the checks ran and something is actually broken. Terminal, as
  #             it has always been: no amount of waiting fixes it, a person
  #             has to change the code.
  #   pending - the checks simply have not finished yet. Handled by
  #             handle_ci_pending, which leaves the card unprocessed so a
  #             later tick can ship it by itself once they pass.
  #   unknown - no checks configured at all, a non-github.com repo, or the
  #             GitHub API call itself failed (unreachable, timed out, a 403
  #             rate-limit body, unparseable JSON -- they are all one answer).
  #             Deliberately fail-open (falls through to the deploy below):
  #             absence of checks is not evidence of failure, and a GitHub
  #             outage must not become a deploy outage. But see the
  #             wait-state guard directly below for the one case where it is
  #             NOT fail-open any more.
  if [ "$ci_status" = "failure" ]; then
    log "runner: $aid holding — GitHub CI for $target_ref is failure"
    ci_wait_state_clear "$aid"
    comment "$aid" "$company_id" "Deploy stopped — the automated checks on this version did not pass, so nothing was deployed and whatever was already live is untouched. Approving this again will not help on its own: someone needs to fix what is failing first, and then this version can be put live." "checks_failed"
    return
  fi
  if [ "$ci_status" = "pending" ]; then
    handle_ci_pending "$aid" "$company_id" "$target_ref" "$decided_at" "pending"
    return
  fi
  # DUR-3967: fail-open has to survive exactly where it is justified, and only
  # there. Before this ticket a card was looked at ONCE, so exactly one GitHub
  # API sample decided it and fail-open risked one coin toss. A held card now
  # re-samples every 60s for up to CI_WAIT_SECONDS -- ~45 chances for a single
  # unreachable API, timeout or 403 rate-limit body to turn into "unknown" and
  # ship a build we had already been told was mid-check. (The connect timeout
  # is HEALTH_CONNECT_TIMEOUT_SECONDS against api.github.com from a box that
  # runs at load 13+ during a deploy; this is not exotic.)
  #
  # So: an "unknown" for a card that is ALREADY WAITING is not evidence that
  # there is nothing to wait for -- we have positive evidence from an earlier
  # tick that checks exist and were incomplete. Keep waiting, bounded by the
  # SAME deadline, so a genuine GitHub outage still ends in the terminal
  # "stopped waiting" note rather than an unbounded hold. A repo that never
  # had checks, a non-github remote and a FIRST look that finds nothing all
  # still fail open, because none of them has any wait state.
  if [ "$ci_status" = "unknown" ] && ci_wait_state_get "$aid" >/dev/null 2>&1; then
    log "runner: $aid still waiting — could not get a check verdict for $target_ref out of GitHub, and an earlier tick already saw its checks running; not treating that as 'no checks'"
    handle_ci_pending "$aid" "$company_id" "$target_ref" "$decided_at" "unknown"
    return
  fi
  # Checks passed (or there are none to consult) — this card is no longer
  # waiting on anything, so drop any wait-state left from earlier ticks.
  ci_wait_state_clear "$aid"

  local before_commit
  # DUR-420: `--short=12` (not the 7-char default) so the logged/commented commit prefix is
  # too long to grind a colliding vanity commit against in feasible time -- see the matching
  # `commitsMatch()` minimum-length comment in deploy-completion-gate.ts for the full threat
  # model this and that change close together.
  before_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

  log "runner: $aid deploying project $DV_PROJECT_ID ($DV_DEPLOY_TARGET_PATH) -> $target_ref"
  # DUR-3923: write a "started" status line BEFORE the slow part (git fetch, quiet-mode drain of
  # up to QUIET_MODE_DRAIN_TIMEOUT_SECONDS, the build, the health check, and a possible rollback
  # that repeats the last two). Every other status line is a terminal outcome written at the very
  # end, so without this one the server's deploy-approval-feedback tick had no way to tell "the
  # runner is busy on this deploy right now" from "the runner never picked it up" and could tell
  # the operator the runner service was stopped in the middle of a perfectly normal long deploy.
  # Not a comment (nothing is posted on the card), not an outcome, never affects the processed set.
  record_status "$aid" "$company_id" "Deploy started — the deploy runner is working on this approval (fetching $target_ref, then building and health-checking). The outcome will be posted here when it finishes." 1 "started"
  # DUR-3974: fetch and run every refusal guard WITHOUT resetting the checkout
  # yet (dry run). The reset is the point of no return for a compose_recreate
  # project — the files in the folder are what the running container serves —
  # so everything that can still say "don't do this deploy" has to happen
  # before it, and so does the quiet-mode drain, which used to sit BETWEEN the
  # reset and the recreate and was most of the 2026-09-10 window: the drain
  # waits up to QUIET_MODE_DRAIN_TIMEOUT_SECONDS (240s by default), all of it
  # with the new code already live against the old schema.
  local carried_commit
  carried_commit="$(git_fetch_reset "$DV_DEPLOY_TARGET_PATH" "$DV_REPO_URL" "$target_ref" "$token" "$DV_ALLOW_BACKWARD_DEPLOY" "dry_run" "$DV_REPO_REF")"
  local fetch_reset_status=$?
  if [ "$fetch_reset_status" -eq 2 ]; then
    log "runner: $aid refused — $target_ref is already reachable from the live commit $before_commit; deploying it would move production backward"
    # DUR-152: this approval's own change already shipped (as an ancestor of
    # what's live now, via an earlier or concurrent deploy) — record it as
    # "carried" so deploy-completion-gate.ts can confirm it by commit instead
    # of leaving whoever filed/is waiting on this approval stuck forever
    # watching an id that will never get its own success comment. Still
    # phrased as a skip, not a success — DUR-137's own guard exists because
    # this script never actually re-ran the health check against THIS
    # approval's target, only against what an earlier deploy already proved.
    # Operator-facing: no payload field names here. A person who genuinely
    # wants an older version back uses the project page's "Roll back to
    # previous version" button (ui/src/components/ProjectDeployHistoryCard.tsx),
    # which files a rollback card with the opt-in already set.
    comment "$aid" "$company_id" "Deploy skipped — this approval points at $target_ref (commit ${carried_commit:-unknown}), which is older than what is already live ($before_commit). Its change already shipped as part of an earlier deploy, so nothing is missing. Applying it now would move production backward and undo everything that has shipped since, so the deploy runner left production untouched. If you really do want to go back to an older version, open the project page and use the \"Roll back to previous version\" button — that files a rollback card for you to approve. This card can be left as it is." "carried" "$carried_commit"
    return
  elif [ "$fetch_reset_status" -eq 3 ]; then
    log "runner: $aid refused — $target_ref (commit ${carried_commit:-unknown}) is not reachable from $DV_REPO_REF, this project's configured deploy branch"
    # DUR-229: target_commit isn't an ancestor of the current live commit
    # (so DUR-137's guard above doesn't fire) but it also isn't reachable
    # from the deploy branch at all — it lives on a different, unrelated
    # branch. Resetting to it would silently switch production onto that
    # branch's lineage, discarding whatever the deploy branch has that the
    # other branch doesn't (the DUR-221 incident). Hard fail; there is no
    # allowBackwardDeploy-style override for this one.
    comment "$aid" "$company_id" "Deploy failed — approval target ($target_ref, commit ${carried_commit:-unknown}) is not reachable from \"$DV_REPO_REF\", the branch this project deploys from. It looks like it lives on a different branch entirely. Resetting to it would discard whatever \"$DV_REPO_REF\" has that the other branch doesn't (DUR-229 guard). Re-file the deploy approval against a commit that's actually on \"$DV_REPO_REF\"."
    return
  elif [ "$fetch_reset_status" -ne 0 ]; then
    log "runner: $aid git fetch failed"
    comment "$aid" "$company_id" "Deploy failed — git fetch/reset of $DV_DEPLOY_TARGET_PATH to $target_ref failed. Check deploy-runner.log."
    return
  fi

  # DUR-3974: how the app's real pages answer RIGHT NOW, while the currently
  # live version is still the one running. Everything after this is compared
  # against it, which is what makes a rollback verdict evidence of THIS
  # deploy breaking something rather than a guess about what "healthy" means.
  local page_baseline
  page_baseline="$(capture_page_baseline "$aid" "$DV_HEALTH_CHECK_URL" "$DV_APP_HEALTH_PATHS")"

  # DUR-259: quiet mode stays active (if we're the one who activated it)
  # across the recipe, health check, AND a possible rollback below — a
  # rollback re-runs the same recipe, so the shared container can be
  # recreated a second time for this one approval, and both need to be
  # covered by the same drained window. Ended right before whichever
  # comment() call reports this approval's final outcome, on every exit path.
  # DUR-3974 moved this ahead of the reset: see the dry-run note above.
  maybe_begin_quiet_mode_drain "$aid" "$DV_DEPLOY_KIND"

  # DUR-3974: stop the services that serve the code before the files change
  # under them, where that is a safe and well-defined thing to do.
  stop_services_before_swap "$aid" "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"

  # Pinned to the commit the dry run's guards approved (it prints it), so a
  # branch tip that moved while we were draining cannot slip a commit nobody
  # has looked at into this deploy. Falls back to the ref only if the dry run
  # printed nothing, which an older/stubbed git_fetch_reset may do.
  local reset_ref="${carried_commit:-$target_ref}"
  git_fetch_reset "$DV_DEPLOY_TARGET_PATH" "$DV_REPO_URL" "$reset_ref" "$token" "$DV_ALLOW_BACKWARD_DEPLOY" "" "$DV_REPO_REF" >/dev/null
  fetch_reset_status=$?
  if [ "$fetch_reset_status" -ne 0 ]; then
    log "runner: $aid git fetch/reset failed (status $fetch_reset_status) after the guards had already passed"
    restart_services_after_abandoned_swap "$aid" "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_SERVICES" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
    maybe_end_quiet_mode_drain "$aid" "$DV_HEALTH_CHECK_URL"
    comment "$aid" "$company_id" "Deploy failed — git fetch/reset of $DV_DEPLOY_TARGET_PATH to $target_ref failed. Check deploy-runner.log."
    return
  fi
  local after_commit
  # DUR-420: see the matching comment on before_commit above -- `--short=12` closes a
  # short-SHA-prefix-collision hole in the server-side carried-issue/deploy-completion commit
  # matcher.
  after_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

  run_recipe "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_DEPLOY_COMMAND" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
  local recipe_status=$?
  if [ "$recipe_status" -ne 0 ]; then
    log "runner: $aid recipe ($DV_DEPLOY_KIND) failed (status $recipe_status)"
    local diag_path
    diag_path="$(maybe_rollback "$aid" "$before_commit" "$after_commit")"
    # DUR-3974: the recipe is what would have started the services this deploy
    # stopped before swapping the files. It didn't, so (unless the rollback's
    # own recipe already did) they are still down — never leave production
    # stopped because a deploy failed.
    restart_services_after_abandoned_swap "$aid" "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_SERVICES" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
    maybe_end_quiet_mode_drain "$aid" "$DV_HEALTH_CHECK_URL"
    local broken_note="the running version may be broken."
    [ "$recipe_status" -eq 3 ] && broken_note="the build failed before anything was swapped, so the previously running version was left untouched."
    comment "$aid" "$company_id" "Deploy failed — the $DV_DEPLOY_KIND recipe failed at commit $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit." || echo "No rollback configured; $broken_note" )$( [ -n "$diag_path" ] && echo " Failing container logs captured to $diag_path before rollback." ) Check deploy-runner.log."
    return
  fi
  # The recipe started the services again; nothing is left stopped by the swap.
  SERVICES_STOPPED_BEFORE_SWAP=0

  if ! health_check "$DV_HEALTH_CHECK_URL"; then
    log "runner: $aid health check failed at $DV_HEALTH_CHECK_URL"
    local diag_path
    diag_path="$(maybe_rollback "$aid" "$before_commit" "$after_commit")"
    maybe_end_quiet_mode_drain "$aid" "$DV_HEALTH_CHECK_URL"
    comment "$aid" "$company_id" "Deploy failed — health check against $DV_HEALTH_CHECK_URL never returned 200 after deploying $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit and re-recreated." || echo "No rollback configured; the running version may be unhealthy." )$( [ -n "$diag_path" ] && echo " Failing container logs captured to $diag_path before rollback." ) Check deploy-runner.log."
    return
  fi

  # DUR-3974: the health check above only proves that SOMETHING answered 200.
  # This is the part that proves the app itself still works, by comparing real
  # pages against how the very same pages answered minutes ago, before this
  # deploy touched anything.
  local broken_pages
  if ! broken_pages="$(verify_pages_after_deploy "$aid" "$page_baseline")"; then
    log "runner: $aid pages that worked before this deploy are failing after it: $broken_pages"
    local diag_path
    diag_path="$(maybe_rollback "$aid" "$before_commit" "$after_commit")"
    # DUR-3974: do not TELL the operator the site is working again — check.
    # The same pages, the same baseline, after the rollback. A rollback that
    # did not actually fix it is the one case where he has to be interrupted,
    # and it is exactly the case a hopeful sentence would hide.
    local recovery_note="No rollback is set up for this project, so the broken version is still live and someone needs to look at it."
    if [ "$DV_ROLLBACK" = git_previous ]; then
      # The rollback's recipe has returned, which only means the container has
      # been started — not that the old version is listening yet. Re-checking
      # now would read a booting app as "the rollback did not help", and that
      # verdict is the one the operator is asked to act on, so wait (bounded)
      # for the old version to answer first.
      if wait_for_health "$DV_HEALTH_CHECK_URL" "$ROLLBACK_HEALTH_WAIT_SECONDS"; then
        log "runner: $aid the rolled-back version is answering at $DV_HEALTH_CHECK_URL — re-checking the pages"
      else
        log "runner: $aid the rolled-back version still has not answered at $DV_HEALTH_CHECK_URL after ${ROLLBACK_HEALTH_WAIT_SECONDS}s — re-checking the pages anyway"
      fi
      local still_broken
      if still_broken="$(verify_pages_after_deploy "$aid" "$page_baseline")"; then
        recovery_note="Production has been put back to the version that was live before this ($before_commit), and those pages have been checked again and are working."
      else
        # The worst case there is. Loud in the log, and unmistakable on the
        # card: do not let this read like the reassuring branch above.
        log "runner: $aid ROLLBACK DID NOT RESTORE THE APP — after rolling $DV_DEPLOY_TARGET_PATH back to $before_commit these pages are still broken: $still_broken"
        recovery_note="Production has been put back to the version that was live before this ($before_commit), but these pages are STILL not working: $still_broken. Putting the old version back was not enough, so the app is still down and this needs a person now."
      fi
    fi
    maybe_end_quiet_mode_drain "$aid" "$DV_HEALTH_CHECK_URL"
    comment "$aid" "$company_id" "Deploy failed — the new version answered on its health check address, but pages of the app that were working just before the deploy are now returning an error: $broken_pages. $recovery_note$( [ -n "$diag_path" ] && echo " The failing version's logs were saved to $diag_path first." ) Nothing else was changed."
    return
  fi

  maybe_end_quiet_mode_drain "$aid" "$DV_HEALTH_CHECK_URL"
  log "runner: $aid deployed OK ($before_commit -> $after_commit)"
  # DUR-3974: never let the card imply a thorough check that did not happen.
  # With no pages listed for this project the runner can only reach the front
  # page on its own, and the operator should be told that in the same breath
  # as the word "healthy" — the 2026-09-10 deploy was called clean on exactly
  # this kind of evidence.
  local checked_note=" The app's own pages were opened afterwards and still work."
  if [ -z "${DV_APP_HEALTH_PATHS//[[:space:]]/}" ]; then
    checked_note=" Only the health check address and the front page were opened afterwards, because this project does not list any pages to check. You can add the pages that matter under \"Pages that must still work\" in the project's deploy settings, and future deploys will be undone automatically if one of them breaks."
  fi
  # DUR-237: record the deployed commit as a structured field here too (not just in the free-text
  # body) so deploy-completion-gate.ts can confirm ANY issue whose merge commit matches — not only
  # the issue this approval happens to be linked to — without parsing prose.
  comment "$aid" "$company_id" "Deployed to $DV_DEPLOY_TARGET_PATH — commit $after_commit is live and healthy (health check: $DV_HEALTH_CHECK_URL).$checked_note" "" "$after_commit"
}

# DUR-163: docker logs for the container being replaced only exist as long as
# that specific container does — `docker compose up --force-recreate` (or the
# swap half of compose_build_swap) throws the old one away, so a rollback
# that re-runs the recipe destroys the only evidence of why the just-deployed
# version failed unless it's captured first. Written to FAILURE_LOG_DIR
# (on-host, outside deployTargetPath and outside any container) so it
# survives both the git reset --hard and the container recreate. Best
# effort: a failure here is logged and swallowed, never blocks the rollback.
capture_failure_diagnostics() { # approval_id, commit -> stdout: path written (empty if nothing could be captured)
  local aid="$1" commit="$2" dir ts out
  dir="$FAILURE_LOG_DIR"
  mkdir -p "$dir" 2>>"$LOG" || { log "runner: $aid could not create $dir for failure diagnostics"; return 0; }
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$dir/${ts}-${aid}-${commit}.log"
  (
    echo "# deploy failure diagnostics: approval=$aid commit=$commit kind=$DV_DEPLOY_KIND captured=$ts load=$(load_average)"
    if [ "$DV_DEPLOY_KIND" = "compose_recreate" ] || [ "$DV_DEPLOY_KIND" = "compose_build_swap" ]; then
      cd "$DV_DEPLOY_TARGET_PATH" 2>/dev/null || { echo "(could not cd to $DV_DEPLOY_TARGET_PATH)"; exit 0; }
      local compose_args=() f
      [ -n "$DV_ENV_FILE" ] && compose_args+=(--env-file "$DV_ENV_FILE")
      for f in $DV_COMPOSE_FILES; do compose_args+=(-f "$f"); done
      echo "## docker compose logs --no-color --tail 500 ${DV_DEPLOY_SERVICES:-<all services>}"
      # shellcheck disable=SC2086
      docker compose "${compose_args[@]}" logs --no-color --tail 500 $DV_DEPLOY_SERVICES 2>&1
    else
      echo "## docker logs --tail 500 $DOCKER_SERVER_CONTAINER"
      docker logs --tail 500 "$DOCKER_SERVER_CONTAINER" 2>&1
    fi
  ) >"$out" 2>>"$LOG"
  log "runner: $aid captured pre-rollback failure diagnostics to $out"
  printf '%s' "$out"
}

maybe_rollback() { # approval_id, before_commit, after_commit -> stdout: failure-diagnostics log path (empty if rollback isn't configured or nothing could be captured)
  local aid="$1" before="$2" after="${3:-unknown}"
  [ "$DV_ROLLBACK" = "git_previous" ] || return 0
  local diag_path
  diag_path="$(capture_failure_diagnostics "$aid" "$after")"
  if [ "$before" = "unknown" ]; then
    printf '%s' "$diag_path"
    return 0
  fi
  log "runner: $aid rolling back $DV_DEPLOY_TARGET_PATH to $before"
  git -C "$DV_DEPLOY_TARGET_PATH" reset --hard --quiet "$before" 2>>"$LOG"
  run_recipe "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_DEPLOY_COMMAND" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
  local rollback_status=$?
  if [ "$rollback_status" -eq 3 ]; then
    log "runner: $aid rollback build also failed, but nothing was swapped — the running container is untouched, no manual intervention needed"
  elif [ "$rollback_status" -ne 0 ]; then
    log "runner: $aid rollback recipe also failed — manual intervention needed"
  fi
  printf '%s' "$diag_path"
}

# EXIT trap safety net for run_one_approval/run_superseded_approval's
# subshells (DUR-44). If the subshell dies for a reason that never reached
# one of the explicit comment() calls above — an unbound-variable typo, a
# future bug, anything — this still tries to tell the operator, and the
# subshell boundary means that failure can't also take down the rest of the
# poll cycle's approvals the way a top-level crash would.
crash_fallback_comment() { # approval_id, company_id, result_file
  local aid="$1" company_id="$2" result_file="$3"
  [ -s "$result_file" ] && return 0
  if comment "$aid" "$company_id" "Deploy failed — the deploy runner exited unexpectedly while processing this approval (internal script error). Check deploy-runner.log."; then
    echo ok > "$result_file"
  fi
}

# DUR-3965: the single EXIT handler for a deploy's subshell. Undoing the
# quiet-mode drain comes FIRST and unconditionally: every explicit outcome
# path in process_approval already ends the drain itself (this is a no-op
# then), but an early return that a future change forgets to cover, an
# unbound-variable crash, or the subshell being killed mid-deploy would
# otherwise leave the whole instance muted with nothing saying why -- exactly
# the 2026-09-10 incident. Telling the operator about the approval is the
# second job, and must not be able to skip the first.
deploy_approval_exit_guard() { # approval_id, company_id, result_file
  # DUR-3974: and before either of those, put back anything this deploy
  # stopped and never got as far as starting again. A crash between the stop
  # and the recipe would otherwise leave production down — a strictly worse
  # outcome than the broken-schema window this stop exists to prevent. A
  # no-op unless a stop actually happened and nothing has restarted it.
  restart_services_after_abandoned_swap "$1" "${DV_DEPLOY_TARGET_PATH:-}" "${DV_DEPLOY_SERVICES:-}" "${DV_COMPOSE_FILES:-}" "${DV_ENV_FILE:-}"
  maybe_end_quiet_mode_drain "$1" "${DV_HEALTH_CHECK_URL:-}"
  crash_fallback_comment "$1" "$2" "$3"
}

run_one_approval() { # approval_id, company_id
  local aid="$1" company_id="$2" result_file
  result_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-deploy-runner-result.XXXXXX")"
  (
    trap 'deploy_approval_exit_guard "$aid" "$company_id" "$result_file"' EXIT
    process_approval "$aid" "$company_id"
    local status=$?
    # DUR-3967: three outcomes, not two. "held" is written so the EXIT trap's
    # crash fallback (which fires only on an EMPTY result file) knows this
    # subshell finished deliberately — but it is not "ok", so the approval is
    # NOT added to the processed set and the next tick re-evaluates it.
    if [ "$status" -eq "$DEPLOY_HELD_STATUS" ]; then
      echo held > "$result_file"
    elif [ "$status" -eq 0 ]; then
      echo ok > "$result_file"
    fi
  )
  local result=""
  [ -s "$result_file" ] && result="$(cat "$result_file" 2>/dev/null)"
  case "$result" in
    ok)
      mark_processed "$aid"
      ;;
    held)
      # Intentionally unprocessed and intentionally quiet: handle_ci_pending
      # has already logged (throttled) why this card is still waiting.
      ;;
    *)
      log "runner: $aid — no comment could be delivered after retries; leaving unprocessed so it is retried next poll cycle"
      ;;
  esac
  rm -f "$result_file"
}

# DUR-152: resolves aid's OWN target commit (never resetting anything — pure
# read-only fetch + a dry-run git_fetch_reset call) and checks whether it is
# already an ancestor of (or equal to) whatever the deploy target checkout is
# CURRENTLY sitting on. Meant to be called for a same-cycle SUPERSEDED
# approval AFTER its group's KEEP approval has already run, so "currently
# checked out" reflects KEEP's real outcome (success or failure — either way
# it's the truth, not a guess). Prints the resolved commit and returns 0 when
# it's confirmed already live; returns 1 (nothing printed) if the approval's
# own project/policy doesn't resolve, its commit can't be fetched, or it
# genuinely isn't reachable from what's live — callers must fall back to a
# plain "skipped" message in every 1-case, not assume "not yet checked" means
# "not live".
check_commit_already_live() { # approval_id, company_id
  local aid="$1" company_id="$2"
  local approval_json project_json
  approval_json="$(cli_json approval get "$aid")" || return 1
  local project_id
  project_id="$(printf '%s' "$approval_json" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("payload") or {}).get("projectId") or "")' 2>/dev/null)" || return 1
  [ -z "$project_id" ] && return 1
  project_json="$(cli_json project get "$project_id" -C "$company_id")" || return 1
  local vars
  vars="$(resolve_deploy_vars "$approval_json" "$project_json" 2>/dev/null)" || return 1
  eval "$vars"
  [ -d "$DV_DEPLOY_TARGET_PATH/.git" ] || return 1
  local token
  token="$(cli_json secrets deploy-github-token -C "$company_id" | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("token") or "")' 2>/dev/null)" || token=""
  local target_ref="${DV_COMMIT:-$DV_REPO_REF}"
  local out status
  out="$(git_fetch_reset "$DV_DEPLOY_TARGET_PATH" "$DV_REPO_URL" "$target_ref" "$token" "" "1" "$DV_REPO_REF")"
  status=$?
  [ "$status" -eq 2 ] || return 1
  printf '%s' "$out"
  return 0
}

run_superseded_approval() { # approval_id, company_id, keep_approval_id
  local aid="$1" company_id="$2" keep_id="$3" result_file
  # DUR-3967: a superseded card is never going through the CI gate again --
  # this runner will not deploy it at all -- so it stops waiting for its
  # checks right here, whether or not the comment below can be delivered.
  # (mark_processed() clears the row too, but only on the delivered path.)
  ci_wait_state_clear "$aid"
  result_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-deploy-runner-result.XXXXXX")"
  (
    trap 'crash_fallback_comment "$aid" "$company_id" "$result_file"' EXIT
    local body outcome="" commit=""
    local carried_commit
    if carried_commit="$(check_commit_already_live "$aid" "$company_id")"; then
      log "runner: $aid (superseded by $keep_id) — its own target ($carried_commit) is already reachable from what $keep_id just deployed; recording as carried"
      body="Skipped — a newer deploy approval ($keep_id) for the same project/workspace was approved in this poll cycle and ran instead. This approval's own target commit ($carried_commit) is already reachable from what's now live, so its change shipped as part of $keep_id's deploy — see $keep_id for that deploy's outcome."
      outcome="carried"
      commit="$carried_commit"
    else
      body="Skipped — a newer deploy approval ($keep_id) for the same project/workspace was approved in this poll cycle and ran instead, to avoid two resets racing on the same checkout. If this approval targets a different commit than $keep_id ends up deploying, deploy-runner's backward-deploy guard (DUR-137) will still refuse to apply it if it's older than what's live — re-file it if it genuinely needs to run."
    fi
    if comment "$aid" "$company_id" "$body" "$outcome" "$commit"; then
      echo ok > "$result_file"
    fi
  )
  if [ -s "$result_file" ]; then
    mark_processed "$aid"
  else
    log "runner: $aid (superseded by $keep_id) — no comment could be delivered after retries; leaving unprocessed so it is retried next poll cycle"
  fi
  rm -f "$result_file"
}

# DUR-3923: an approved request_board_approval whose payload.kind looks like a
# deploy but is not "deploy" (the NOR-1242 card was kind "deploy_pr"). Nothing
# here can act on it -- there is no project/workspace/commit contract behind
# it -- so the only correct outcome is to SAY so, on the card (and, via
# comment()'s mirror, on its linked issues), and mark it processed so it is
# said once. Never deploys anything. Same processed-set/comment-delivery
# contract as the other run_* functions (DUR-44).
run_unsupported_kind_approval() { # approval_id, company_id, kind
  local aid="$1" company_id="$2" kind="$3" result_file
  result_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-deploy-runner-result.XXXXXX")"
  (
    trap 'crash_fallback_comment "$aid" "$company_id" "$result_file"' EXIT
    log "runner: $aid was approved with kind \"$kind\", which this runner does not act on -- answering, not deploying"
    local body
    body="Nothing happened — this card was filed with kind \"$kind\", which the deploy runner does not act on. Only cards with kind \"deploy\" (project, workspace and commit filled in) get deployed. If this change should go live, file a new deploy approval with kind \"deploy\"; this card can be left as it is."
    if comment "$aid" "$company_id" "$body" "unsupported_kind"; then
      echo ok > "$result_file"
    fi
  )
  if [ -s "$result_file" ]; then
    mark_processed "$aid"
  else
    log "runner: $aid (unsupported kind \"$kind\") — no comment could be delivered after retries; leaving unprocessed so it is retried next poll cycle"
  fi
  rm -f "$result_file"
}

main() {
  # DUR-3965: before anything else, un-mute an instance a previous cycle left
  # muted. This must run even when there is nothing else to do this cycle --
  # a stuck quiet mode means zero approvals will ever be filed either.
  retry_pending_quiet_mode_deactivate
  # DUR-3967: drop waiting-for-checks rows belonging to cards that are already
  # finished with, before anything reads that file this cycle.
  ci_wait_state_prune

  local companies company_ids
  companies="$(cli_json company list)" || {
    log "runner: company list failed (auth expired? re-run 'auth login' inside $DOCKER_SERVER_CONTAINER)"
    exit 0
  }
  company_ids="$(printf '%s' "$companies" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    # See the matching PARSE_ERROR handling below for approval list -- same
    # rationale: a JSON-parse failure here is a real, loggable problem (the
    # CLI returned something unexpected), not the ordinary "zero companies"
    # case, and the two must not look identical in deploy-runner.log.
    print("PARSE_ERROR")
    sys.exit(0)
items = d if isinstance(d, list) else d.get("companies", [])
for c in items:
    if c.get("id"):
        print(c["id"])
')"
  if [ "$company_ids" = "PARSE_ERROR" ]; then
    log "runner: company list did not parse as JSON -- aborting this poll cycle. First 200 chars: $(printf '%s' "$companies" | head -c 200)"
    exit 0
  fi
  [ -z "${company_ids//[[:space:]]/}" ] && exit 0

  local company_id list selection kind aid extra
  for company_id in $company_ids; do
    # DUR-259 follow-up: this used to be `|| continue` with zero logging on
    # failure -- a silent no-op indistinguishable (from deploy-runner.log)
    # from "nothing to do this cycle". That blind spot is exactly what made
    # a real production stall look identical to normal idle behavior: if
    # this docker-exec CLI call itself hangs or errors (host contention,
    # auth hiccup, transient docker/API flake), main() would silently skip
    # this company forever with no trace, and the *actual* run_recipe/drain
    # logic below would never even be reached -- yet nothing in the log
    # would say so. Log the failure so the next occurrence is diagnosable
    # instead of indistinguishable from "no approvals pending".
    if ! list="$(cli_json approval list -C "$company_id" --status approved)"; then
      log "runner: could not list approved deploy requests for company $company_id (docker exec/CLI call failed) -- skipping this company this poll cycle"
      continue
    fi
    # Group approved deploy requests by (projectId, workspaceId): they
    # converge on the same git ref reset, so only the most recently
    # *approved* one in the group needs to actually run this cycle (DUR-44).
    # Approvals missing a projectId are never grouped together, so a
    # malformed row can't accidentally swallow an unrelated one.
    selection="$(printf '%s' "$list" | UNSUPPORTED_KIND_MAX_AGE_SECONDS="$UNSUPPORTED_KIND_MAX_AGE_SECONDS" python3 -c '
import json, os, sys

try:
    d = json.load(sys.stdin)
except Exception:
    # Distinguish "the CLI returned something that is not valid JSON" (a
    # real bug worth logging -- e.g. stray stdout noise ahead of the --json
    # payload) from "the CLI legitimately returned an empty/no-op list",
    # which is the normal, expected, silent case every poll cycle when
    # nothing is pending. See the PARSE_ERROR handling in the bash caller.
    print("PARSE_ERROR")
    sys.exit(0)
items = d if isinstance(d, list) else d.get("approvals", [])
candidates = [
    a for a in items
    if a.get("type") == "request_board_approval"
    and str((a.get("payload") or {}).get("kind")) == "deploy"
    and a.get("status") == "approved"
]

# DUR-3923 (NOR-1242): an approved card whose kind merely LOOKS like a deploy
# ("deploy_pr", "deploy_release", "rollout", ...) used to be invisible to this
# runner -- the operator approved it and nothing at all happened, with no
# comment saying why. Same regex as isUnsupportedDeployLikeKind() in
# server/src/services/deploy-workspace.ts. These are answered (a comment
# explaining nothing acts on them) and marked processed, never deployed.
#
# Bounded by decidedAt (UNSUPPORTED_KIND_MAX_AGE_SECONDS, default 24h): the
# processed-set is per host and starts empty on a fresh box or after a wipe,
# so without this bound the first cycle would answer every deploy_pr/rollout
# card ever approved across all companies (and mirror onto every linked
# issue). A card whose decision time is missing or unparseable is treated as
# old -- the safe direction is to stay quiet, not to spam.
import re
from datetime import datetime, timezone

def parse_when(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed

try:
    max_age_seconds = float(os.environ.get("UNSUPPORTED_KIND_MAX_AGE_SECONDS") or 86400)
except ValueError:
    max_age_seconds = 86400.0
now = datetime.now(timezone.utc)

def decided_recently(a):
    decided = parse_when(a.get("decidedAt") or a.get("updatedAt") or a.get("createdAt"))
    if decided is None:
        return False
    return (now - decided).total_seconds() <= max_age_seconds

unsupported = [
    a for a in items
    if a.get("type") == "request_board_approval"
    and a.get("status") == "approved"
    and isinstance((a.get("payload") or {}).get("kind"), str)
    and str((a.get("payload") or {}).get("kind")).strip() != "deploy"
    and re.search(r"deploy|release|rollout|ship", str((a.get("payload") or {}).get("kind")), re.I)
    and decided_recently(a)
]
for a in unsupported:
    kind = str((a.get("payload") or {}).get("kind")).strip().replace("\t", " ")
    unsupported_id = a.get("id")
    if unsupported_id:
        print(f"UNSUPPORTED\t{unsupported_id}\t{kind}")

groups = {}
for a in candidates:
    payload = a.get("payload") or {}
    project_id = payload.get("projectId")
    workspace_id = payload.get("workspaceId")
    key = (project_id, workspace_id) if project_id else a.get("id")
    groups.setdefault(key, []).append(a)

def decided_key(a):
    return str(a.get("decidedAt") or a.get("updatedAt") or a.get("createdAt") or "")

for group in groups.values():
    group.sort(key=decided_key)
    keep = group[-1]
    keep_id = keep.get("id")
    # DUR-152: KEEP runs first, SUPERSEDED entries after. A superseded
    # approval'\''s own outcome comment now checks (via check_commit_already_live)
    # whether its target commit already shipped as part of KEEP'\''s deploy —
    # that check is only meaningful once KEEP has actually run and the
    # checkout reflects its real result (success or failure), not before.
    print(f"KEEP\t{keep_id}")
    for superseded in group[:-1]:
        superseded_id = superseded.get("id")
        print(f"SUPERSEDED\t{superseded_id}\t{keep_id}")
')"
    if [ "$selection" = "PARSE_ERROR" ]; then
      log "runner: approval list for company $company_id did not parse as JSON -- skipping this company this poll cycle. First 200 chars: $(printf '%s' "$list" | head -c 200)"
      continue
    fi
    [ -z "${selection//[[:space:]]/}" ] && continue

    while IFS=$'\t' read -r kind aid extra; do
      [ -z "$aid" ] && continue
      already_processed "$aid" && continue
      case "$kind" in
        KEEP) run_one_approval "$aid" "$company_id" ;;
        SUPERSEDED) run_superseded_approval "$aid" "$company_id" "$extra" ;;
        UNSUPPORTED) run_unsupported_kind_approval "$aid" "$company_id" "$extra" ;;
      esac
    done <<< "$selection"
  done
}

# Guarded so tests can `source` this file (to exercise its real functions
# directly, instead of hand-extracting them) without acquiring the single-
# flight lock, touching the real processed-set file, or running a poll cycle.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # Only one run at a time (a deploy can take minutes; the timer fires every minute).
  exec 9>"/tmp/paperclip-deploy-runner.lock"
  flock -n 9 || exit 0

  touch "$PROCESSED"

  main
fi
