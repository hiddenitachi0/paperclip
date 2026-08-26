#!/usr/bin/env bash
# Claude Code PostToolUse hook (matcher: Bash). Wired via .claude/settings.json.
#
# WHAT AND WHY: DUR-228 / DUR-221 root cause. This repo's GitHub default
# branch used to be `master`, while this project's actual deploy branch is
# `custom` (project.deployPolicy.deployBranch) -- `gh pr create` without an
# explicit `--base` silently targets whatever GitHub's default is, so any
# agent that forgets `--base custom` opens a PR against the wrong branch and
# nothing catches it until deploy time. That's exactly how DUR-217/219/216/
# 191 and DUR-222's own PR (#146) ended up targeting master, and how DUR-221
# nearly force-reset `custom` back by 244 commits from a deploy approval that
# pointed at master.
#
# The GitHub-level default branch has since been flipped to `custom`, which
# fixes the common case, but that's a single point of failure: it needs
# admin:repo token scope this project's token doesn't reliably have, a board
# human has to remember it's load-bearing, and anyone re-flipping it (or a
# PR opened against a *different* repo/fork) reopens the exact same footgun.
# This hook is the enforcement that doesn't depend on any of that: it fires
# after every `gh pr create`, reads the PR that was just opened, looks up
# this project's configured deploy branch via the Paperclip API (not
# GitHub's default), and if the PR's base doesn't match, retargets it
# immediately with `gh pr edit --base` -- before the merge-approval hook
# (pr-open-merge-approval-hook.sh, which runs after this one) can file a
# board approval against the wrong branch. It only ever touches the PR it
# just seen created, and only within this project's own repo.
set -uo pipefail

log() { printf '[pr-base-branch-guard-hook] %s\n' "$*" >&2; }

HOOK_INPUT="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

TOOL_NAME="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
[[ "$TOOL_NAME" == "Bash" ]] || exit 0

TOOL_BASH_COMMAND="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
printf '%s' "$TOOL_BASH_COMMAND" | grep -Eq '(^|[;&|]|[[:space:]])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' || exit 0

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_TASK_ID:-}" ]]; then
  log "not running under a Paperclip agent context (missing PAPERCLIP_API_URL/API_KEY/TASK_ID); skipping"
  exit 0
fi

HOOK_CWD="$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[[ -n "$HOOK_CWD" && -d "$HOOK_CWD" ]] && cd "$HOOK_CWD"

# Direct curls to $PAPERCLIP_API_URL hang from inside the agent sandbox on
# this fork (that hostname isn't reachable directly). When the sandbox's
# local plain-HTTP proxy is available, use it instead; otherwise fall back
# to the real API URL for environments without that proxy.
API_BASE="$PAPERCLIP_API_URL"
if [[ -n "${PAPERCLIP_LISTEN_PORT:-}" ]]; then
  API_BASE="http://127.0.0.1:$PAPERCLIP_LISTEN_PORT"
fi

# `gh pr create` only just ran; ask GitHub what's actually true for the
# current branch instead of trying to scrape a PR number out of tool output.
PR_JSON="$(gh pr view --json number,url,baseRefName 2>/dev/null)" || exit 0
[[ -n "$PR_JSON" ]] || exit 0
PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.number')"
PR_URL="$(printf '%s' "$PR_JSON" | jq -r '.url')"
PR_BASE="$(printf '%s' "$PR_JSON" | jq -r '.baseRefName')"
[[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]] || exit 0

REPO_NAME_WITH_OWNER="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"

# Look up this project's configured deploy branch via the Paperclip API
# (issue -> projectId -> deployPolicy), independent of GitHub's default
# branch setting. Only act when both the lookup succeeds AND the PR's repo
# matches the project's own configured repo -- an unrelated repo (e.g. a
# clone checked out for reference) legitimately might not use `custom`.
ISSUE_JSON="$(curl -sS --max-time 10 -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$API_BASE/api/issues/$PAPERCLIP_TASK_ID" 2>/dev/null)" || ISSUE_JSON=""
PROJECT_ID="$(printf '%s' "$ISSUE_JSON" | jq -r '.projectId // empty' 2>/dev/null)"
[[ -n "$PROJECT_ID" ]] || exit 0

PROJECT_JSON="$(curl -sS --max-time 10 -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$API_BASE/api/projects/$PROJECT_ID" 2>/dev/null)" || PROJECT_JSON=""
[[ -n "$PROJECT_JSON" ]] || exit 0

DEPLOY_BRANCH="$(printf '%s' "$PROJECT_JSON" | jq -r '.deployPolicy.deployBranch // .codebase.defaultRef // empty' 2>/dev/null)"
[[ -n "$DEPLOY_BRANCH" && "$DEPLOY_BRANCH" != "null" ]] || exit 0

PROJECT_REPO_URL="$(printf '%s' "$PROJECT_JSON" | jq -r '.codebase.repoUrl // empty' 2>/dev/null)"
if [[ -n "$PROJECT_REPO_URL" && -n "$REPO_NAME_WITH_OWNER" ]]; then
  PROJECT_REPO_NAME_WITH_OWNER="$(printf '%s' "$PROJECT_REPO_URL" | sed -E 's#^https?://[^/]+/##; s#\.git$##')"
  [[ "$REPO_NAME_WITH_OWNER" == "$PROJECT_REPO_NAME_WITH_OWNER" ]] || exit 0
fi

[[ "$PR_BASE" != "$DEPLOY_BRANCH" ]] || exit 0

log "PR #$PR_NUMBER opened against '$PR_BASE', not this project's configured deploy branch '$DEPLOY_BRANCH'; retargeting"

EDIT_OUT="$(gh pr edit "$PR_NUMBER" --base "$DEPLOY_BRANCH" 2>&1)"
EDIT_STATUS=$?

if [[ $EDIT_STATUS -eq 0 ]]; then
  log "retargeted PR #$PR_NUMBER to '$DEPLOY_BRANCH' ($PR_URL)"
  FEEDBACK="gh pr create opened PR #$PR_NUMBER against '$PR_BASE', not '$DEPLOY_BRANCH' (this project's configured deploy branch) -- this hook auto-corrected it with 'gh pr edit $PR_NUMBER --base $DEPLOY_BRANCH'. Always pass --base $DEPLOY_BRANCH explicitly on gh pr create going forward; don't rely on this hook as the only line of defense."
else
  log "failed to retarget PR #$PR_NUMBER to '$DEPLOY_BRANCH': $EDIT_OUT"
  FEEDBACK="gh pr create opened PR #$PR_NUMBER against '$PR_BASE', not '$DEPLOY_BRANCH' (this project's configured deploy branch), and this hook's attempt to auto-correct it with 'gh pr edit $PR_NUMBER --base $DEPLOY_BRANCH' FAILED ($EDIT_OUT). Fix the PR base manually before filing any merge approval for it."
fi

# Exit 2 on a PostToolUse hook feeds stderr back to the agent as context (the
# tool already ran; this can't block it) -- that's how FEEDBACK reaches the
# agent's transcript.
printf '%s\n' "$FEEDBACK" >&2
exit 2
