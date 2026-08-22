#!/usr/bin/env bash
# Claude Code PostToolUse hook (matcher: Bash). Wired via .claude/settings.json.
#
# WHAT AND WHY: DUR-101 item 3 / DUR-98 Class D. DUR-87's incident was an
# agent pushing a brand-new branch for a fix that already had a more
# complete, already-open PR sitting on a differently-named branch — nobody
# checked first, so the work silently diverged instead of landing on the
# existing PR. This hook fires after a branch's first push (`git push -u
# origin <branch>` or equivalent) and, when the branch name carries a ticket
# reference (e.g. `dur101-...`, `DUR-87-...`), looks for another open PR or
# remote branch already carrying the same ticket reference. If one exists,
# it tells the agent via hook feedback rather than letting the push pass
# silently — it can't block a push that already happened, only surface it.
set -uo pipefail

log() { printf '[branch-push-duplicate-check-hook] %s\n' "$*" >&2; }

HOOK_INPUT="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0

TOOL_NAME="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
[[ "$TOOL_NAME" == "Bash" ]] || exit 0

TOOL_BASH_COMMAND="$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
# Only care about a push that establishes a new upstream branch, not every
# push to an already-tracked one — that's when silent divergence starts.
printf '%s' "$TOOL_BASH_COMMAND" | grep -Eq '(^|[;&|]|[[:space:]])git[[:space:]]+push([[:space:]].*)?[[:space:]](-u|--set-upstream)([[:space:]]|$)' || exit 0

HOOK_CWD="$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[[ -n "$HOOK_CWD" && -d "$HOOK_CWD" ]] && cd "$HOOK_CWD"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
[[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || exit 0

# Ticket reference: dur101, dur-101, DUR_101, etc. Case-insensitive, no
# separator required between the letters and the digits.
TICKET="$(printf '%s' "$BRANCH" | grep -Eio 'dur-?[0-9]+' | head -1 | tr '[:upper:]' '[:lower:]' | tr -d '-')"
[[ -n "$TICKET" ]] || exit 0
TICKET_DISPLAY="DUR-${TICKET#dur}"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || exit 0
[[ -n "$REPO" ]] || exit 0

# Other open PRs whose head branch also references this ticket, excluding
# our own branch.
OTHER_PRS="$(gh pr list --repo "$REPO" --state open --json number,url,headRefName,title 2>/dev/null | jq -c --arg branch "$BRANCH" --arg ticket "$TICKET" '
  [ .[] | select(.headRefName != $branch) | select((.headRefName | ascii_downcase | gsub("-";"")) | contains($ticket)) ]
' 2>/dev/null)" || OTHER_PRS="[]"
[[ -n "$OTHER_PRS" && "$OTHER_PRS" != "null" ]] || OTHER_PRS="[]"

# Other remote branches referencing the same ticket with no open PR at all
# (the DUR-87 shape: a branch existed, nobody had opened a PR from it yet).
OTHER_BRANCHES="$(git ls-remote --heads origin 2>/dev/null | awk '{print $2}' | sed 's#refs/heads/##' | grep -vFx "$BRANCH" | grep -Eio "^.*dur-?${TICKET#dur}([^0-9].*)?\$" || true)"

MATCH_COUNT="$(printf '%s' "$OTHER_PRS" | jq 'length' 2>/dev/null || echo 0)"
if [[ "$MATCH_COUNT" -eq 0 && -z "$OTHER_BRANCHES" ]]; then
  log "no other branch or open PR found referencing $TICKET_DISPLAY"
  exit 0
fi

DETAIL=""
if [[ "$MATCH_COUNT" -gt 0 ]]; then
  DETAIL="$(printf '%s' "$OTHER_PRS" | jq -r '.[] | "  - PR #\(.number) on branch \(.headRefName): \(.url)"')"
fi
if [[ -n "$OTHER_BRANCHES" ]]; then
  while IFS= read -r b; do
    [[ -n "$b" ]] || continue
    DETAIL="$DETAIL
  - branch origin/$b (no open PR found)"
  done <<< "$OTHER_BRANCHES"
fi

log "found existing work for $TICKET_DISPLAY on a different branch"

FEEDBACK="The branch you just pushed ($BRANCH) references $TICKET_DISPLAY, and another branch or open PR already references the same ticket:
$DETAIL

Check whether that is the same fix before continuing on $BRANCH — if it is, switch to it (or its PR) instead of letting two branches diverge on the same ticket. This is the exact DUR-87 incident: a branch was pushed against an already-open, more complete PR, and the newer one had to be discarded."

file_operator_comment() {
  [[ -n "${PAPERCLIP_API_KEY:-}" ]] || return 0
  local issue_id="${PAPERCLIP_TASK_ID:-}"
  [[ -n "$issue_id" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  local api_base="${PAPERCLIP_API_URL:-}"
  if [[ -n "${PAPERCLIP_LISTEN_PORT:-}" ]]; then
    api_base="http://127.0.0.1:$PAPERCLIP_LISTEN_PORT"
  fi
  [[ -n "$api_base" ]] || return 0

  local marker="<!-- branch-push-duplicate-check:${TICKET_DISPLAY}:${BRANCH} -->"
  local existing already_filed
  existing="$(curl -sS --max-time 10 -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$api_base/api/issues/$issue_id/comments" 2>/dev/null)" || existing=""
  already_filed="false"
  if [[ -n "$existing" ]]; then
    already_filed="$(printf '%s' "$existing" | jq -r --arg marker "$marker" '
      ([ .[] | select((.body // "") | contains($marker)) ] | length > 0)
    ' 2>/dev/null)" || already_filed="false"
  fi
  [[ "$already_filed" == "true" ]] && return 0

  local comment_body
  comment_body="$marker
**Possible duplicate branch/PR for $TICKET_DISPLAY.**

Branch \`$BRANCH\` was just pushed, and this already exists for the same ticket:
$DETAIL

If this is the same fix, the newer branch should be dropped in favor of the existing one."

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
# push already happened; this can't block it) — that's how FEEDBACK reaches
# the agent's transcript.
printf '%s\n' "$FEEDBACK" >&2
exit 2
