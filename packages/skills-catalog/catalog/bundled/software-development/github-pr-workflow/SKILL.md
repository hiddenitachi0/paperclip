---
name: github-pr-workflow
description: Prepare a GitHub pull request from a feature branch — branch hygiene, commit shape, title/body, verification notes, screenshots for UI work, and replies to review comments.
key: paperclipai/bundled/software-development/github-pr-workflow
recommendedForRoles:
  - engineer
tags:
  - github
  - pull-requests
  - code-review
  - release
---

# GitHub Pull Request Workflow

Ship a PR a reviewer can land without follow-up clarifying questions. The aim is high signal in the title and body, evidence the change works, and clean replies when feedback comes in.

## When to use

- You are about to open a PR for a change that is functionally complete.
- A reviewer left comments and you need to respond and push fixes.
- A PR has been open more than a day and needs to be brought back into shape (stale conflicts, missing description, missing verification).

## When not to use

- The change is not yet functionally complete. Finish the work first; draft PRs that bounce on review are noise.
- The repository uses a non-GitHub forge. Adjust to that forge's conventions; do not force GitHub-isms.

## Never replace what is already on a shared branch

Assume another agent is working from the same branch in a different checkout. A
push that moves the branch to a history not containing its current tip deletes
their commits, and nothing tells them: a lost migration parent in exactly this
way left a branch whose migrations could not apply, and the deploy approved on
top of it rolled back.

- Never `--force` / `--force-with-lease` a branch you have already pushed. Add a
  new commit instead of rewriting one that is out there.
- Squash and rebase *before* the first push, not after.
- If you need the base branch's newer commits on a branch you already pushed,
  merge the base in rather than rebasing onto it — a merge keeps every commit
  that is already on the branch reachable, a rebase does not.
- If a push is refused, never retry it with force. Fetch, integrate the current
  tip, re-run the tests, push again.
- Never delete a shared branch from a run. Say it is finished and let the
  operator delete it.

A `pre-push` guard enforces this for real, so a forced push is refused rather
than quietly accepted. Its refusal text names the commits at stake and the
commands that make the push legal.

## Branch hygiene before opening

- Rebase or merge from the target base so the diff is current (merge, not
  rebase, once the branch has been pushed — see above).
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, and lint pass locally. Note any deliberate skips in the PR body.
- Remove debug prints, commented-out code, and `TODO` markers that are not tracked.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
- No trailing period.

## PR body

Use this structure:

```md
## Summary
- 1–3 bullets describing what changed and why.

## Implementation notes
- Anything non-obvious in the diff: trade-offs, dropped alternatives, gotchas.
- Migration or config implications.

## Verification
- The exact commands or steps you ran.
- Screenshots or short clips for UI changes (required if pixels moved).
- Edge cases you exercised by hand.

## Risk and rollback
- What breaks if this is reverted, and how to revert cleanly.
```

Skip the `Risk and rollback` section only for clearly trivial PRs (typos, docs).

## Verification evidence

- Tests passing in CI is necessary, not sufficient. Reviewers also need to know the change behaves correctly end to end.
- For UI work, include screenshots of the golden path and one edge case. Tag dark and light mode if the project supports both.
- For migrations, include a dry-run plan and reversal steps.
- For performance changes, include a before/after measurement, not adjectives.

## Replying to review comments

- Reply on every comment, even with just "fixed in <commit-sha>" — silent fixes leave the reviewer guessing.
- Push fixes as new commits while review is active; do not amend during review unless the reviewer agrees.
- If you disagree with feedback, say so with one sentence of rationale and let the reviewer decide. Don't escalate over comments.
- Re-request review explicitly after pushing changes.

## Merge checklist

- All required checks green.
- All review comments resolved.
- PR title/body still accurate (update if scope changed mid-review).
- Linked issue moves to `in_review` or `done` per project convention.
- Delete the branch after merge unless it is a long-lived integration branch.

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Force-pushing a branch that is already pushed — during review or at any other point.
