#!/usr/bin/env bash
# Claude Code PostToolUse hook (matcher: Bash). Wired via .claude/settings.json.
#
# WHAT AND WHY: the standing rule "after opening a PR, file a plain-language
# merge_pr board approval so the operator never has to touch GitHub" used to
# live only in agent memory/instructions, which agents could forget. This
# hook makes it automatic: it fires after every Bash call, no-ops unless the
# command looks like `gh pr create`, and then files the approval itself by
# reading whatever PR now exists for the current branch — so it works even if
# the agent forgets, and it's idempotent if the agent already filed one by
# hand or the hook fires again later on an unrelated command.
#
# De-duplication is authoritative on the server: before filing, this script
# lists existing approvals and skips if one already references this
# repo+PR number, regardless of that approval's status (open, approved, or
# rejected) — a PR only ever gets one merge_pr approval, ever.
set -uo pipefail

log() { printf '[pr-open-merge-approval-hook] %s\n' "$*" >&2; }

# Fast, cheap exit for the overwhelming majority of Bash calls this hook sees.
HOOK_INPUT="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

TOOL_NAME="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
[[ "$TOOL_NAME" == "Bash" ]] || exit 0

TOOL_BASH_COMMAND="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
printf '%s' "$TOOL_BASH_COMMAND" | grep -Eq '(^|[;&|]|[[:space:]])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' || exit 0

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_COMPANY_ID:-}" ]]; then
  log "not running under a Paperclip agent context (missing PAPERCLIP_API_URL/API_KEY/COMPANY_ID); skipping"
  exit 0
fi

HOOK_CWD="$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[[ -n "$HOOK_CWD" && -d "$HOOK_CWD" ]] && cd "$HOOK_CWD"

# `gh pr create` only just ran; ask GitHub what's actually true for the
# current branch instead of trying to scrape a PR number out of tool output.
# If this fails, either the create failed or there's no PR — nothing to do.
PR_JSON="$(gh pr view --json number,url,title,body,baseRefName,headRepositoryOwner,headRepository 2>/dev/null)" || exit 0
[[ -n "$PR_JSON" ]] || exit 0

PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.number')"
PR_URL="$(printf '%s' "$PR_JSON" | jq -r '.url')"
PR_TITLE="$(printf '%s' "$PR_JSON" | jq -r '.title')"
PR_BODY="$(printf '%s' "$PR_JSON" | jq -r '.body // ""')"
PR_BASE="$(printf '%s' "$PR_JSON" | jq -r '.baseRefName')"
REPO="$(printf '%s' "$PR_JSON" | jq -r '(.headRepositoryOwner.login // "") + "/" + (.headRepository.name // "")')"
if [[ -z "$REPO" || "$REPO" == "/" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi
[[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]] || exit 0

# Plain-language "what this does": strip a conventional-commit prefix off the
# PR title (agents already write these; see CONTRIBUTING.md PR title rules).
PLAIN_WHAT="$(printf '%s' "$PR_TITLE" | sed -E 's/^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\([^)]*\))?!?:[[:space:]]*//I')"
[[ -n "$PLAIN_WHAT" ]] || PLAIN_WHAT="$PR_TITLE"

# First "## Summary" bullet, if the PR body follows the standard template;
# otherwise fall back to the plain title.
SUMMARY_LINE="$(printf '%s\n' "$PR_BODY" | awk '
  /^##[[:space:]]*Summary/{insum=1; next}
  /^##[[:space:]]/{insum=0}
  insum && /^[-*][[:space:]]/{sub(/^[-*][[:space:]]*/, ""); print; exit}
')"
if [[ -n "$SUMMARY_LINE" ]]; then
  PLAIN_SUMMARY="$SUMMARY_LINE"
else
  PLAIN_SUMMARY="$PLAIN_WHAT"
fi
APPROVAL_SUMMARY="$PLAIN_SUMMARY. Approving merges this into $PR_BASE — nothing else happens automatically."

# --- De-duplicate: skip if a merge_pr approval already exists for this PR ---
EXISTING="$(curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals" 2>/dev/null)" || EXISTING=""
if [[ -n "$EXISTING" ]]; then
  ALREADY_FILED="$(printf '%s' "$EXISTING" | jq -r --arg repo "$REPO" --argjson pr "$PR_NUMBER" '
    [ .[] | select(
        .type == "request_board_approval"
        and (.payload.kind == "merge_pr")
        and (.payload.prNumber == $pr)
        and ((.payload.repo // "") == $repo)
      ) ] | length > 0
  ' 2>/dev/null)"
  if [[ "$ALREADY_FILED" == "true" ]]; then
    log "merge_pr approval already exists for $REPO#$PR_NUMBER; skipping"
    exit 0
  fi
fi

ISSUE_IDS_JSON="[]"
if [[ -n "${PAPERCLIP_TASK_ID:-}" ]]; then
  ISSUE_IDS_JSON="$(jq -nc --arg id "$PAPERCLIP_TASK_ID" '[$id]')"
fi

PAYLOAD="$(jq -nc \
  --arg title "Merge: $PLAIN_WHAT" \
  --arg summary "$APPROVAL_SUMMARY" \
  --arg plainSummary "$APPROVAL_SUMMARY" \
  --argjson prNumber "$PR_NUMBER" \
  --arg base "$PR_BASE" \
  --arg repo "$REPO" \
  --arg url "$PR_URL" \
  --arg agentId "${PAPERCLIP_AGENT_ID:-}" \
  --argjson issueIds "$ISSUE_IDS_JSON" \
  '{
    type: "request_board_approval",
    issueIds: $issueIds,
    requestedByAgentId: (if $agentId == "" then null else $agentId end),
    payload: {
      kind: "merge_pr",
      title: $title,
      summary: $summary,
      plainSummary: $plainSummary,
      prNumber: $prNumber,
      base: $base,
      repo: $repo,
      url: $url
    }
  }')"

RUN_ID_HEADER=()
if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  RUN_ID_HEADER=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")
fi

RESPONSE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "${RUN_ID_HEADER[@]}" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD" 2>/dev/null)" || RESPONSE="000"

if [[ "$RESPONSE" == "201" ]]; then
  log "filed merge_pr approval for $REPO#$PR_NUMBER ($PR_URL)"
else
  log "failed to file merge_pr approval for $REPO#$PR_NUMBER (HTTP $RESPONSE)"
fi

exit 0
