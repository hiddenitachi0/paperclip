---
name: code-review
description: Review a pull request or diff for correctness bugs first, then for risky design and missing tests, with file:line evidence and a severity for every finding and a clear verdict. Use when a task asks you to review, check or second-opinion a PR, branch or patch before it is merged.
key: paperclipai/optional/quality/code-review
recommendedForRoles:
  - reviewer
  - engineer
  - qa
  - tech-lead
tags:
  - code-review
  - pull-request
  - quality
  - engineering
---

# Code Review

Find the problems that would hurt users or the team after merge, prove each one, and give the author a short list they can act on. A review is judged by the bugs it catches and the noise it avoids — not by the number of comments.

Use the `paperclip` skill for task mechanics. For opening or updating PRs yourself, see `paperclipai/bundled/software-development/github-pr-workflow`.

## When to use

- A task asks you to review a PR, a branch, or a patch.
- You are the second pair of eyes before a merge request goes to the board.
- An agent claims work is done and you are asked to verify it against the code.

## When not to use

- Security-focused review of auth, data access, secrets or input handling: use `paperclipai/optional/quality/security-review` (you may run both).
- Writing acceptance criteria for a feature: use `paperclipai/bundled/quality/qa-acceptance`.
- You wrote the change. Do not review your own work as the final check; ask for another reviewer.

## Procedure

1. **Read the task first.** What was asked, what "done" means, linked issues and decisions. A correct-looking change that solves the wrong problem is a finding.
2. **Get the real diff.** Check out the branch or fetch the PR diff against its actual base. Note the head commit so your verdict is tied to exact code.
3. **Map the change.** List touched areas: data model/migrations, API routes, background jobs, UI, config. Note anything that changes behaviour for existing users or data.
4. **Hunt for correctness bugs**, in this order:
   - Logic errors, wrong conditions, off-by-one, null/empty cases, wrong units or time zones
   - Data safety: migrations that lose or lock data, non-idempotent re-runs, missing transactions
   - Scoping: multi-tenant/company boundaries, permission checks on every new route
   - Concurrency and retries: double-submits, races, partial failure leaving bad state
   - Error handling: swallowed errors, user-visible failures without a message
   - Contract drift: schema, types, validators, API client and UI not updated together
5. **Check tests.** Do the tests exercise the risky path, or only the happy path? Run the relevant tests yourself when you can and record the command and result.
6. **Then design and maintainability** — only what will cause real cost: duplication of existing helpers, dead code, misleading names, missing docs for a changed contract. Skip pure style that a formatter or linter handles.
7. **Prove each finding.** File and line, what happens, how to reproduce or the input that triggers it. If you cannot prove it, label it a question, not a bug.
8. **Write the verdict** with the template below and post it on the task (and on the PR if the task asks).

## Severity

| Level | Meaning | Merge? |
|---|---|---|
| **Blocker** | Wrong behaviour, data loss, security hole, broken build/migration | No, must fix |
| **Major** | Likely bug in a realistic case, missing test for risky path, contract drift | Fix before merge unless the board accepts the risk |
| **Minor** | Edge case unlikely in practice, maintainability cost | Can follow up |
| **Question** | You suspect something but could not prove it | Author answers |

## Output template

```
Review of <PR/branch> at <commit sha>
Verdict: CHANGES NEEDED | OK TO MERGE (pending board approval) | OK WITH FOLLOW-UPS
Scope read: <files/areas>    Tests run: <command> → <passed/failed counts> | not run because <reason>

Findings
1. [Blocker] path/to/file.ts:123 — <what is wrong>. Trigger: <input/steps>. Fix: <suggestion>.
2. [Major] ...
Questions
- path:line — <question>
Not checked
- <areas you did not review and why>
```

## Hard rules

- Never approve or merge yourself. Merge approval belongs to the board; your verdict is advice.
- Never push changes to the author's branch unless the task explicitly asks you to fix things.
- Every Blocker/Major has file:line and a trigger. No vague "consider refactoring".
- Say what you did not check. Silence reads as "checked".
- Re-review against the new head commit after fixes; do not carry an old verdict forward.

## Done when

- [ ] The task's intent was read and compared to the change
- [ ] The verdict names the exact commit reviewed
- [ ] Every finding has severity, location and evidence
- [ ] Tests were run (or the reason they were not is stated)
- [ ] Unchecked areas are listed
- [ ] The verdict is posted where the task asked
