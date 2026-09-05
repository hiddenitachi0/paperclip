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
#      repoRef) via check_ci_status(). A red or still-running check holds the
#      deploy with an explanatory comment instead of shipping it and relying
#      on the health-check + rollback below to catch it after the fact. A repo
#      with no CI configured at all (both endpoints empty) is treated the same
#      as today — absence of CI is not evidence of failure, so it doesn't
#      block a deploy that would otherwise always have gone through; likewise
#      a GitHub API/network failure fails OPEN (unknown), matching how the
#      merge-pr-automation service treats the same ambiguity elsewhere in this
#      codebase, so a GitHub outage can't itself become a deploy outage.
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
# API instead of needing a human to read deploy-runner.log by hand.
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
mark_processed() { echo "$1" >> "$PROCESSED"; }

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
#   pending  - CI configured but still running
#   unknown  - no CI configured at all, the repo isn't github.com, or the
#              GitHub API call itself failed -- treated as fail-open by the
#              caller, same ambiguity-handling choice merge-pr-automation.ts
#              makes for the equivalent merge_pr gate.
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

if not total_status and not runs:
    print("unknown")
elif total_status and status.get("state") not in ("success", "pending"):
    print("failure")
elif total_status and status.get("state") == "pending":
    print("pending")
elif any(r.get("status") != "completed" for r in runs):
    print("pending")
elif any(r.get("conclusion") not in ("success", "neutral", "skipped") for r in runs):
    print("failure")
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
    if ! cli_json instance quiet-mode:activate >/dev/null; then
      log "runner: $aid could not activate quiet mode before deploy — proceeding without a drain wait"
      return 0
    fi
    QUIET_MODE_OWNED_BY_RUNNER=1
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
  log "runner: $aid drain timed out after ${QUIET_MODE_DRAIN_TIMEOUT_SECONDS}s with $count heartbeat run(s) still in flight — proceeding with the recreate anyway (see DUR-259 follow-up: no paused-for-restart status yet, these may surface as process_lost)"
}

maybe_end_quiet_mode_drain() { # aid
  local aid="$1"
  [ "$QUIET_MODE_OWNED_BY_RUNNER" -eq 1 ] || return 0
  if ! cli_json instance quiet-mode:deactivate >/dev/null; then
    log "runner: $aid could not deactivate quiet mode after deploy — an operator may need to run \`instance quiet-mode:deactivate\` manually"
  fi
  QUIET_MODE_OWNED_BY_RUNNER=0
}

run_recipe() { # target_dir, kind, services, command, compose_files, env_file
  # Exit status: 0 = ok; 3 = compose_build_swap's `build` step failed before
  # anything was swapped (the `&&` short-circuits `up --no-build`), so the
  # previously running container was never touched; 1 = the recipe failed
  # after touching the running container (compose_recreate, the swap half of
  # compose_build_swap, or a custom command we can't reason about).
  local target_dir="$1" kind="$2" services="$3" command="$4" compose_files="$5" env_file="$6"
  (
    cd "$target_dir" || exit 1
    local compose_args=()
    [ -n "$env_file" ] && compose_args+=(--env-file "$env_file")
    if [ -n "$compose_files" ]; then
      local f
      for f in $compose_files; do
        compose_args+=(-f "$f")
      done
    fi
    case "$kind" in
      compose_recreate)
        # shellcheck disable=SC2086
        docker compose "${compose_args[@]}" up -d --force-recreate $services >>"$LOG" 2>&1
        ;;
      compose_build_swap)
        # shellcheck disable=SC2086
        if ! docker compose "${compose_args[@]}" build $services >>"$LOG" 2>&1; then
          exit 3
        fi
        # shellcheck disable=SC2086
        docker compose "${compose_args[@]}" up -d --no-build $services >>"$LOG" 2>&1
        ;;
      custom)
        bash -c "$command" >>"$LOG" 2>&1
        ;;
      *)
        return 1
        ;;
    esac
  )
}

process_approval() { # approval_id, company_id -> exit status is comment()'s delivery status
  local aid="$1" company_id="$2"

  local approval_json project_json
  approval_json="$(cli_json approval get "$aid")" || {
    log "runner: $aid could not re-fetch approval"
    comment "$aid" "$company_id" "Deploy failed — could not re-fetch the approval. Check deploy-runner.log on the server."
    return
  }

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
  if [ "$ci_status" = "failure" ] || [ "$ci_status" = "pending" ]; then
    log "runner: $aid holding — GitHub CI for $target_ref is $ci_status"
    comment "$aid" "$company_id" "Deploy held — GitHub CI for $target_ref is $( [ "$ci_status" = "pending" ] && echo "still running" || echo "red (failing checks)" ). Refusing to deploy an unproven build. Re-approve/re-file this deploy once CI is green."
    return
  fi

  local before_commit
  # DUR-420: `--short=12` (not the 7-char default) so the logged/commented commit prefix is
  # too long to grind a colliding vanity commit against in feasible time -- see the matching
  # `commitsMatch()` minimum-length comment in deploy-completion-gate.ts for the full threat
  # model this and that change close together.
  before_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

  log "runner: $aid deploying project $DV_PROJECT_ID ($DV_DEPLOY_TARGET_PATH) -> $target_ref"
  local carried_commit
  carried_commit="$(git_fetch_reset "$DV_DEPLOY_TARGET_PATH" "$DV_REPO_URL" "$target_ref" "$token" "$DV_ALLOW_BACKWARD_DEPLOY" "" "$DV_REPO_REF")"
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
    comment "$aid" "$company_id" "Deploy skipped — approval target ($target_ref, commit ${carried_commit:-unknown}) is an ancestor of the currently live commit ($before_commit): its change has already shipped as part of an earlier or concurrent deploy, so applying this approval directly would only reset production backward and silently discard whatever has shipped since (DUR-137 guard). If a rollback is genuinely intended, re-file the deploy approval with payload.allowBackwardDeploy: true to confirm that explicitly." "carried" "$carried_commit"
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
    log "runner: $aid git fetch/reset failed"
    comment "$aid" "$company_id" "Deploy failed — git fetch/reset of $DV_DEPLOY_TARGET_PATH to $target_ref failed. Check deploy-runner.log."
    return
  fi
  local after_commit
  # DUR-420: see the matching comment on before_commit above -- `--short=12` closes a
  # short-SHA-prefix-collision hole in the server-side carried-issue/deploy-completion commit
  # matcher.
  after_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

  # DUR-259: quiet mode stays active (if we're the one who activated it)
  # across the recipe, health check, AND a possible rollback below — a
  # rollback re-runs the same recipe, so the shared container can be
  # recreated a second time for this one approval, and both need to be
  # covered by the same drained window. Ended right before whichever
  # comment() call reports this approval's final outcome, on every exit path.
  maybe_begin_quiet_mode_drain "$aid" "$DV_DEPLOY_KIND"

  run_recipe "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_DEPLOY_COMMAND" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
  local recipe_status=$?
  if [ "$recipe_status" -ne 0 ]; then
    log "runner: $aid recipe ($DV_DEPLOY_KIND) failed (status $recipe_status)"
    local diag_path
    diag_path="$(maybe_rollback "$aid" "$before_commit" "$after_commit")"
    maybe_end_quiet_mode_drain "$aid"
    local broken_note="the running version may be broken."
    [ "$recipe_status" -eq 3 ] && broken_note="the build failed before anything was swapped, so the previously running version was left untouched."
    comment "$aid" "$company_id" "Deploy failed — the $DV_DEPLOY_KIND recipe failed at commit $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit." || echo "No rollback configured; $broken_note" )$( [ -n "$diag_path" ] && echo " Failing container logs captured to $diag_path before rollback." ) Check deploy-runner.log."
    return
  fi

  if ! health_check "$DV_HEALTH_CHECK_URL"; then
    log "runner: $aid health check failed at $DV_HEALTH_CHECK_URL"
    local diag_path
    diag_path="$(maybe_rollback "$aid" "$before_commit" "$after_commit")"
    maybe_end_quiet_mode_drain "$aid"
    comment "$aid" "$company_id" "Deploy failed — health check against $DV_HEALTH_CHECK_URL never returned 200 after deploying $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit and re-recreated." || echo "No rollback configured; the running version may be unhealthy." )$( [ -n "$diag_path" ] && echo " Failing container logs captured to $diag_path before rollback." ) Check deploy-runner.log."
    return
  fi

  maybe_end_quiet_mode_drain "$aid"
  log "runner: $aid deployed OK ($before_commit -> $after_commit)"
  # DUR-237: record the deployed commit as a structured field here too (not just in the free-text
  # body) so deploy-completion-gate.ts can confirm ANY issue whose merge commit matches — not only
  # the issue this approval happens to be linked to — without parsing prose.
  comment "$aid" "$company_id" "Deployed to $DV_DEPLOY_TARGET_PATH — commit $after_commit is live and healthy (health check: $DV_HEALTH_CHECK_URL)." "" "$after_commit"
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

run_one_approval() { # approval_id, company_id
  local aid="$1" company_id="$2" result_file
  result_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-deploy-runner-result.XXXXXX")"
  (
    trap 'crash_fallback_comment "$aid" "$company_id" "$result_file"' EXIT
    if process_approval "$aid" "$company_id"; then
      echo ok > "$result_file"
    fi
  )
  if [ -s "$result_file" ]; then
    mark_processed "$aid"
  else
    log "runner: $aid — no comment could be delivered after retries; leaving unprocessed so it is retried next poll cycle"
  fi
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

main() {
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
    selection="$(printf '%s' "$list" | python3 -c '
import json, sys

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
