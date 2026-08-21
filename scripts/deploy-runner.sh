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
#   3. In deployTargetPath: git fetch + reset --hard to payload.commit (if
#      pinned) or the workspace's repoRef, authenticating with the resolved
#      token via the SAME credential-helper script the container image uses
#      (paperclip-git-credential.sh) — the token is only ever passed through
#      the process environment for that one git invocation, never written to
#      disk or argv.
#   4. Run the OPERATOR-configured recipe: deployKind is set by the operator
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
#   5. Health-check healthCheckUrl for HTTP 200 (retries below); auto-rollback
#      (git reset --hard to the pre-deploy commit + re-run the recipe) when
#      rollback is "git_previous" and the health check never passes.
#   6. Comment the result back on the approval.
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
HEALTH_RETRIES="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES:-30}"
HEALTH_SLEEP_SECONDS="${PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP:-3}"
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

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

cli_json() { # subcommand args... -> JSON on stdout (runs inside the server container)
  docker exec "$DOCKER_SERVER_CONTAINER" sh -lc "$CLI $* $ARGS" 2>>"$LOG"
}

# Mirrors every comment attempt (delivered or not) into $STATUS_PATH inside
# the server container's volume. Best-effort only — never affects whether
# the approval is considered processed.
record_status() { # approval_id, company_id, body, delivered(0/1)
  local aid="$1" company_id="$2" body="$3" delivered="$4" line
  line="$(AID="$aid" COMPANY_ID="$company_id" BODY="$body" DELIVERED="$delivered" TS="$(ts)" python3 -c '
import json, os
print(json.dumps({
    "ts": os.environ["TS"],
    "approvalId": os.environ["AID"],
    "companyId": os.environ["COMPANY_ID"],
    "commentDelivered": os.environ["DELIVERED"] == "0",
    "body": os.environ["BODY"],
}))
' 2>>"$LOG")"
  [ -z "$line" ] && return 0
  docker exec -e STATUS_LINE="$line" -e STATUS_PATH="$STATUS_PATH" "$DOCKER_SERVER_CONTAINER" sh -lc \
    'mkdir -p "$(dirname "$STATUS_PATH")" && printf "%s\n" "$STATUS_LINE" >> "$STATUS_PATH" && tail -n 500 "$STATUS_PATH" > "$STATUS_PATH.tmp" 2>/dev/null && mv "$STATUS_PATH.tmp" "$STATUS_PATH"' \
    >/dev/null 2>>"$LOG" || log "runner: $aid failed to record status line (non-fatal)"
}

comment() { # approval_id, company_id, body -> 0 if delivered, 1 if not (after retries)
  local aid="$1" company_id="$2" body="$3" attempt=1 delivered=1
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
  record_status "$aid" "$company_id" "$body" "$delivered"
  return "$delivered"
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
}
for key, value in fields.items():
    print(f"{key}={shlex.quote(value)}")
PY
}

health_check() { # url -> 0 if any of HEALTH_RETRIES probes returns HTTP 200
  local url="$1" code
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    [ "$code" = "200" ] && return 0
    sleep "$HEALTH_SLEEP_SECONDS"
  done
  return 1
}

git_fetch_reset() { # target_dir, repo_url, ref_or_commit, github_token
  local target_dir="$1" repo_url="$2" ref="$3" token="$4"
  (
    cd "$target_dir" || exit 1
    if [ -n "$token" ]; then
      export GITHUB_TOKEN="$token"
    fi
    git -c credential.helper= \
        -c "credential.https://github.com.helper=$GIT_CREDENTIAL_HELPER" \
        -c "credential.https://github.com.useHttpPath=false" \
        fetch --quiet origin "$ref" 2>>"$LOG" || \
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
    if git rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
      git reset --hard --quiet "origin/$ref"
    else
      git reset --hard --quiet "$ref"
    fi
  )
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
  local before_commit
  before_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  log "runner: $aid deploying project $DV_PROJECT_ID ($DV_DEPLOY_TARGET_PATH) -> $target_ref"
  if ! git_fetch_reset "$DV_DEPLOY_TARGET_PATH" "$DV_REPO_URL" "$target_ref" "$token"; then
    log "runner: $aid git fetch/reset failed"
    comment "$aid" "$company_id" "Deploy failed — git fetch/reset of $DV_DEPLOY_TARGET_PATH to $target_ref failed. Check deploy-runner.log."
    return
  fi
  local after_commit
  after_commit="$(git -C "$DV_DEPLOY_TARGET_PATH" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  run_recipe "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_DEPLOY_COMMAND" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
  local recipe_status=$?
  if [ "$recipe_status" -ne 0 ]; then
    log "runner: $aid recipe ($DV_DEPLOY_KIND) failed (status $recipe_status)"
    maybe_rollback "$aid" "$before_commit"
    local broken_note="the running version may be broken."
    [ "$recipe_status" -eq 3 ] && broken_note="the build failed before anything was swapped, so the previously running version was left untouched."
    comment "$aid" "$company_id" "Deploy failed — the $DV_DEPLOY_KIND recipe failed at commit $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit." || echo "No rollback configured; $broken_note" ) Check deploy-runner.log."
    return
  fi

  if ! health_check "$DV_HEALTH_CHECK_URL"; then
    log "runner: $aid health check failed at $DV_HEALTH_CHECK_URL"
    maybe_rollback "$aid" "$before_commit"
    comment "$aid" "$company_id" "Deploy failed — health check against $DV_HEALTH_CHECK_URL never returned 200 after deploying $after_commit. $( [ "$DV_ROLLBACK" = git_previous ] && echo "Rolled back to $before_commit and re-recreated." || echo "No rollback configured; the running version may be unhealthy." ) Check deploy-runner.log."
    return
  fi

  log "runner: $aid deployed OK ($before_commit -> $after_commit)"
  comment "$aid" "$company_id" "Deployed to $DV_DEPLOY_TARGET_PATH — commit $after_commit is live and healthy (health check: $DV_HEALTH_CHECK_URL)."
}

maybe_rollback() { # approval_id, before_commit
  local aid="$1" before="$2"
  [ "$DV_ROLLBACK" = "git_previous" ] || return 0
  [ "$before" = "unknown" ] && return 0
  log "runner: $aid rolling back $DV_DEPLOY_TARGET_PATH to $before"
  git -C "$DV_DEPLOY_TARGET_PATH" reset --hard --quiet "$before" 2>>"$LOG"
  run_recipe "$DV_DEPLOY_TARGET_PATH" "$DV_DEPLOY_KIND" "$DV_DEPLOY_SERVICES" "$DV_DEPLOY_COMMAND" "$DV_COMPOSE_FILES" "$DV_ENV_FILE"
  local rollback_status=$?
  if [ "$rollback_status" -eq 3 ]; then
    log "runner: $aid rollback build also failed, but nothing was swapped — the running container is untouched, no manual intervention needed"
  elif [ "$rollback_status" -ne 0 ]; then
    log "runner: $aid rollback recipe also failed — manual intervention needed"
  fi
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

run_superseded_approval() { # approval_id, company_id, keep_approval_id
  local aid="$1" company_id="$2" keep_id="$3" result_file
  result_file="$(mktemp "${TMPDIR:-/tmp}/paperclip-deploy-runner-result.XXXXXX")"
  (
    trap 'crash_fallback_comment "$aid" "$company_id" "$result_file"' EXIT
    if comment "$aid" "$company_id" "Skipped — a newer deploy approval ($keep_id) for the same project was approved in this poll cycle and will be deployed instead; both target the same git ref, so running this one too would be redundant."; then
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
    sys.exit(0)
items = d if isinstance(d, list) else d.get("companies", [])
for c in items:
    if c.get("id"):
        print(c["id"])
')"
  [ -z "${company_ids//[[:space:]]/}" ] && exit 0

  local company_id list selection kind aid extra
  for company_id in $company_ids; do
    list="$(cli_json approval list -C "$company_id" --status approved)" || continue
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
    for superseded in group[:-1]:
        superseded_id = superseded.get("id")
        print(f"SUPERSEDED\t{superseded_id}\t{keep_id}")
    print(f"KEEP\t{keep_id}")
')"
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
