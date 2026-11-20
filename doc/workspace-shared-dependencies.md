# Parallel-safe workspaces and shared dependencies

Last updated: 2026-11-20 (DUR-5184).

## One folder and one branch per run

With the execution workspace strategy `git_worktree`, every issue gets its own
folder under `<repo>/.paperclip/worktrees/` and its own branch (default
`{{issue.identifier}}-{{slug}}`). A run that has **no issue** (a timer or
routine run that only has a project) gets `run-<first 8 characters of the run id>`
instead of a shared `issue` branch, so two runs never share a writable folder.

### Forcing it: `requireIsolation`

Set `requireIsolation: true` on the project's execution workspace policy:

```json
{ "enabled": true, "defaultMode": "shared_workspace", "requireIsolation": true }
```

Every run of that project then uses `git_worktree`, whatever the issue, the
project's default mode or a stored `project_primary` strategy says. It is
honoured even when the experimental "isolated workspaces" instance flag is off.
Other settings of the strategy (`baseRef`, `branchTemplate`,
`provisionCommand`) are kept.

Without `requireIsolation`, a run with no issue on a `project_primary` policy
still works in the shared checkout and its log carries a warning. Do not commit
or reset there.

## Cleanup

- A worktree is removed after its task has been done or cancelled for the
  company's retention period (default 7 days), if it is clean and fully pushed.
- A worktree whose branch is already merged into `origin/custom`, `origin/main`,
  `origin/master` or origin's default branch is removed within about 15 minutes,
  provided every linked issue is done, cancelled or in review and the worktree
  has been idle for 30 minutes.
- After removal the local branch is deleted with `git branch -d` only. Git
  refuses to delete a branch that is not fully merged (into its upstream, else
  into the main checkout's HEAD), and that branch is simply kept. Squash-merged
  branches are therefore kept; delete them by hand when you know they are done.
- An idle `run-<id>` worktree with no issue is treated like a finished task after
  the retention period.

## Fresh worktrees without reinstalling everything

A worktree is a fresh checkout, so `node_modules` or a Python virtualenv are not
there. Use the strategy's `provisionCommand` (the project workspace "setup
command"). It runs in the new worktree on every run, with `created=true` only the
first time, and receives:

| Variable | Meaning |
| --- | --- |
| `PAPERCLIP_WORKSPACE_PATH` | the new worktree |
| `PAPERCLIP_WORKSPACE_REPO_ROOT` | the main checkout |
| `PAPERCLIP_WORKSPACE_CREATED` | `true` the first time, `false` on reuse |
| `PAPERCLIP_WORKSPACE_BRANCH`, `PAPERCLIP_ISSUE_IDENTIFIER`, ... | for naming caches |

Commands starting with `./` or `bash ./` are looked up in the main checkout, so
the script can live in the repository (for example `scripts/provision.sh`).

### Shared Python virtualenv

```bash
#!/usr/bin/env bash
set -euo pipefail
SHARED="${PAPERCLIP_WORKSPACE_REPO_ROOT}/.paperclip/shared/venv"
if [ ! -d "$SHARED" ]; then
  python3 -m venv "$SHARED"
  "$SHARED/bin/pip" install -r "$PAPERCLIP_WORKSPACE_PATH/requirements.txt"
fi
if [ "$PAPERCLIP_WORKSPACE_CREATED" = "true" ]; then
  ln -s "$SHARED" "$PAPERCLIP_WORKSPACE_PATH/.venv"
fi
```

### Shared node_modules cache

Prefer the package manager's content-addressed store: with pnpm, point
`store-dir` at one folder outside the worktrees (`pnpm config set store-dir
/paperclip/cache/pnpm-store`) and run `pnpm install --frozen-lockfile --offline`
in the provision script; a fresh worktree then links instead of downloading.
Do not symlink one `node_modules` into several worktrees if branches may change
the lockfile; they would overwrite each other's dependencies.

A virtualenv shared this way is read-only in practice: install new packages
from a branch that changes `requirements.txt` into a separate environment.
