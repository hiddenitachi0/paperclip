#!/usr/bin/env bash
# Claude Code PostToolUse hook (matcher: Bash). Wired via .claude/settings.json.
#
# WHAT AND WHY: a GitHub token missing the "workflow" OAuth scope makes any
# push touching .github/workflows/* fail with a 403 — GitHub's rejection
# message for this is extremely distinctive. Three times now that failure
# went unnoticed by the operator (fork DUR-15; dashboard NOR-53 twice); once
# an agent "fixed" it by reverting the CI change, silently degrading CI. This
# hook watches every Bash tool result for that exact rejection and, when it
# fires: (1) tells the agent via hook feedback not to work around it by
# reverting, and (2) files a plain-language comment on the current issue so
# the operator finds out too, not just the agent.
set -uo pipefail

log() { printf '[github-workflow-scope-guard-hook] %s\n' "$*" >&2; }

HOOK_INPUT="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
[[ "$TOOL_NAME" == "Bash" ]] || exit 0

# Only consider commands that could plausibly be a git/gh push or PR
# operation. Without this guard, matching the rejection text anywhere in the
# whole hook payload false-triggers on any unrelated command whose output
# happens to echo that phrase back — e.g. `curl` fetching this very issue's
# comment history once a past comment has quoted GitHub's error message.
COMMAND="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
printf '%s' "$COMMAND" | grep -Eq '(^|[|&;[:space:]])git[[:space:]]+.*push|(^|[|&;[:space:]])gh[[:space:]]' || exit 0

# Match on the tool_response portion (falling back to the whole payload if
# that field is missing/reshaped) rather than including tool_input, so the
# command string itself can't self-match.
RESPONSE_TEXT="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_response // empty' 2>/dev/null)"
[[ -n "$RESPONSE_TEXT" ]] || RESPONSE_TEXT="$HOOK_INPUT"
printf '%s' "$RESPONSE_TEXT" | grep -Fq 'without `workflow` scope' || exit 0

log "detected a GitHub push rejected for missing 'workflow' token scope"

FEEDBACK="That push was rejected by GitHub because this project's GitHub token doesn't have the 'workflow' permission, so it can't touch files under .github/workflows/. Do NOT work around this by reverting or dropping the CI/workflow change — leave it as-is; that would silently degrade CI. A plain-language notification has been filed on this issue explaining how the operator can fix the token. If you can't make progress without this push landing, say so and name the missing GitHub token 'workflow' scope as the blocker."

file_operator_comment() {
  [[ -n "${PAPERCLIP_API_KEY:-}" ]] || return 0
  local issue_id="${PAPERCLIP_TASK_ID:-}"
  [[ -n "$issue_id" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  # Direct curls to $PAPERCLIP_API_URL hang from inside the agent sandbox on
  # this fork (that hostname isn't reachable directly). When the sandbox's
  # local plain-HTTP proxy is available, use it instead; otherwise fall back
  # to the real API URL for environments without that proxy.
  local api_base="${PAPERCLIP_API_URL:-}"
  if [[ -n "${PAPERCLIP_LISTEN_PORT:-}" ]]; then
    api_base="http://127.0.0.1:$PAPERCLIP_LISTEN_PORT"
  fi
  [[ -n "$api_base" ]] || return 0

  # De-dupe: only file the operator comment once per issue, even though this
  # hook may see the same rejection repeated across retried pushes.
  local marker="<!-- github-workflow-scope-guard -->"
  local existing already_filed
  existing="$(curl -sS --max-time 10 -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$api_base/api/issues/$issue_id/comments" 2>/dev/null)" || existing=""
  already_filed="false"
  if [[ -n "$existing" ]]; then
    already_filed="$(printf '%s' "$existing" | jq -r --arg marker "$marker" '
      ([ .[] | select((.body // "") | contains($marker)) ] | length > 0)
    ' 2>/dev/null)" || already_filed="false"
  fi
  if [[ "$already_filed" == "true" ]]; then
    log "operator notification already filed on issue $issue_id; not filing again"
    return 0
  fi

  local comment_body
  comment_body="$marker
**Your GitHub token for this project can't edit the automated-checks files.**

GitHub blocked a push because it touched \`.github/workflows/\`, and the token bound to this project doesn't have the **workflow** permission.

**To fix it:** on GitHub, open the token's settings (Settings → Developer settings → Personal access tokens), then add the **workflow** scope (classic token) or the **Actions: Read and write** permission (fine-grained token). Then update the token value in Paperclip's project token settings.

The agent has been told not to work around this by reverting the change."

  local payload response
  payload="$(jq -nc --arg comment "$comment_body" '{comment: $comment}')"
  response="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X PATCH \
    "$api_base/api/issues/$issue_id" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" 2>/dev/null)" || response="000"
  if [[ "$response" == 2* ]]; then
    log "filed operator notification comment on issue $issue_id"
  else
    log "failed to file operator notification comment (HTTP $response)"
  fi
}

file_operator_comment

# Exit 2 on a PostToolUse hook feeds stderr back to the agent as context (the
# tool already ran; this can't block it) — that's how FEEDBACK reaches the
# agent's transcript.
printf '%s\n' "$FEEDBACK" >&2
exit 2
