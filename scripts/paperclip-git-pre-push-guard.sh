#!/bin/sh
# Paperclip git `pre-push` guard — refuses a push that would drop commits
# another working copy already put on a shared branch.
#
# WHAT AND WHY (see DUR-3975 for the incident this came from). Agents do not
# push through any Paperclip code:
# `scripts/check-no-git-push.mjs` forbids a `git push` anywhere in adapter or
# runtime source, so the only push path is the agent typing `git push` into
# its own shell, authenticated by the image-wide github.com credential helper
# (scripts/paperclip-git-credential.sh). Every existing guard around that —
# pr-base-branch-guard, pr-open-merge-approval, github-workflow-scope-guard,
# branch-push-duplicate-check — is a Claude Code *PostToolUse* hook: it runs
# after the push and can only leave a comment. Nothing ever checked whether a
# push was a fast-forward.
#
# The mechanism, which the test suite reproduces end to end: two agents work the
# same branch from separate checkouts, git rejects the second plain push as
# non-fast-forward, the agent reads the rejection and reaches for `--force`, and
# the first agent's commits stop being reachable. The branch still looks
# complete afterwards, so anything that depended on one of those commits — a
# database migration whose parent lived there, for instance — is broken without
# anything saying so until it is deployed.
#
# This hook is the layer that cannot be talked around: `--force`,
# `--force-with-lease` and `+refs/...` all still run pre-push, so refusing here
# makes "lose another agent's commits" unrepresentable rather than discouraged.
# It is installed image-wide via `core.hooksPath` (see Dockerfile), so it covers
# every repository every agent clones — the Paperclip fork and the Nordstrand
# Django dashboard alike — with no per-repo wiring.
#
# Rules, per ref being pushed:
#   * deleting a branch                          -> refused
#   * creating a branch that is not on the remote -> allowed
#   * updating a branch, remote tip is an ancestor of what you push -> allowed
#   * updating a branch, remote tip is NOT an ancestor            -> refused
#   * anything that is not refs/heads/* (tags, notes)             -> allowed
#
# A refusal always names the commits that would be lost and the exact commands
# that turn the push into a fast-forward, so an agent can recover on its own.
#
# Escape hatch: deliberately none that an agent can reach. `git push
# --no-verify` skips every pre-push hook, which is why the Claude Code
# PreToolUse hook (scripts/git-push-clobber-guard-hook.mjs) refuses a push
# command carrying it.
#
# Repo-local `.git/hooks/pre-push` still runs: this guard chains to it after
# its own checks pass, so setting core.hooksPath image-wide does not silently
# disable a repository's own pre-push hook.

set -u

REMOTE_NAME="${1:-origin}"

say() { printf '%s\n' "$*" >&2; }

# git feeds one line per ref on stdin: <local ref> <local sha> <remote ref>
# <remote sha>. Buffer it so it can be replayed to a chained repo-local hook.
INPUT="$(cat)"

TMP_REFS="$(mktemp 2>/dev/null)" || TMP_REFS=""
if [ -z "$TMP_REFS" ]; then
  say "[paperclip-pre-push] could not create a temp file; refusing the push rather than skipping the clobber check."
  exit 1
fi
# shellcheck disable=SC2064
trap "rm -f '$TMP_REFS'" EXIT
printf '%s\n' "$INPUT" > "$TMP_REFS"

short() { git rev-parse --short "$1" 2>/dev/null || printf '%s' "$1"; }

is_zero_sha() {
  case "$1" in
    "" ) return 0 ;;
    *[!0]* ) return 1 ;;
    * ) return 0 ;;
  esac
}

REFUSED=0

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${remote_ref:-}" ] || continue
  case "$remote_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  branch="${remote_ref#refs/heads/}"

  if is_zero_sha "$local_sha"; then
    REFUSED=1
    say ""
    say "REFUSED: deleting branch \"$branch\" on \"$REMOTE_NAME\"."
    say ""
    say "Another agent may be working from that branch in a different checkout."
    say "Deleting it takes its commits away from them with no warning."
    say ""
    say "If the branch really is finished, say so on the ticket and let the"
    say "operator delete it — do not delete a shared branch from a run."
    continue
  fi

  if is_zero_sha "$remote_sha"; then
    # Brand new branch on the remote: there is nothing there to lose.
    continue
  fi

  if ! git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    REFUSED=1
    say ""
    say "REFUSED: \"$branch\" on \"$REMOTE_NAME\" is at $remote_sha, and this"
    say "checkout has never seen that commit. Someone else pushed it while you"
    say "were working. Pushing now would throw their work away."
    say ""
    say "Integrate it, then push again:"
    say "  git fetch $REMOTE_NAME"
    say "  git rebase $REMOTE_NAME/$branch      # or: git merge $REMOTE_NAME/$branch"
    say "  # re-run the tests, then:"
    say "  git push $REMOTE_NAME HEAD:$branch"
    continue
  fi

  if git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    # Fast-forward: everything already on the branch is still reachable.
    continue
  fi

  lost_count="$(git rev-list --count "$remote_sha" "^$local_sha" 2>/dev/null || printf '0')"
  REFUSED=1
  say ""
  say "REFUSED: this push would move \"$branch\" on \"$REMOTE_NAME\" to a history"
  say "that does not contain what is already on the branch."
  say ""
  say "  currently on the branch: $(short "$remote_sha")"
  say "  what you are pushing:    $(short "$local_sha")"
  say ""
  say "$lost_count commit(s) would stop being reachable:"
  git log --no-decorate --oneline --max-count=20 "$remote_sha" "^$local_sha" 2>/dev/null \
    | while read -r line; do say "  $line"; done
  say ""
  say "Those commits would still be gone even though the branch looks complete,"
  say "so anything built on them breaks silently. That is DUR-3975."
  say ""
  say "If those commits are someone else's, build on top of them:"
  say "  git fetch $REMOTE_NAME"
  say "  git rebase $REMOTE_NAME/$branch      # or: git merge $REMOTE_NAME/$branch"
  say "  # resolve any conflicts, re-run the tests, then:"
  say "  git push $REMOTE_NAME HEAD:$branch"
  say ""
  say "If they are your own and you rewrote them (rebase, amend, squash) after"
  say "pushing: do not rewrite a branch that is already shared. Either"
  say "  git reset --hard $REMOTE_NAME/$branch   # keep the pushed history"
  say "and redo the change as a new commit, or merge the base branch in instead"
  say "of rebasing onto it, or push to a new branch and open a PR from that."
  say ""
  say "If your work is already on the branch, there is nothing to push."
done < "$TMP_REFS"

if [ "$REFUSED" -ne 0 ]; then
  say ""
  say "No commits were pushed. Nothing has been lost — fix the push, do not"
  say "force it: --force, --force-with-lease and +refs/ are all refused here"
  say "for the same reason."
  exit 1
fi

# Chain to a repository's own pre-push hook, if it has one. Ask for the git
# directory rather than `--git-path hooks/...`: with core.hooksPath set
# image-wide, `--git-path` resolves to this script's own directory and the
# repository's hook would never be found.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || printf '')"
if [ -n "$GIT_COMMON_DIR" ]; then
  LOCAL_HOOK="$GIT_COMMON_DIR/hooks/pre-push"
  if [ -x "$LOCAL_HOOK" ]; then
    SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
    LOCAL_HOOK_ABS="$(cd "$(dirname "$LOCAL_HOOK")" 2>/dev/null && pwd)/$(basename "$LOCAL_HOOK")"
    if [ "$SELF" != "$LOCAL_HOOK_ABS" ]; then
      printf '%s\n' "$INPUT" | "$LOCAL_HOOK" "$@"
      exit $?
    fi
  fi
fi

exit 0
