# Parallel-safe workspaces and shared dependencies

Last updated: 2026-11-20 (DUR-5184, DUR-5268).

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

It also covers tasks that already existed: a task still bound to the shared
project checkout is not restored there. Its next run gets a fresh worktree, and
new child tasks of such a task get their own worktree too. Only the board can
change `requireIsolation`; an agent that rewrites the project policy keeps the
stored value.

Without `requireIsolation`, a run with no issue on a `project_primary` policy
still works in the shared checkout and its log carries a warning. Do not commit
or reset there.

## Cleanup

- A worktree is removed after its task has been done or cancelled for the
  company's retention period (default 7 days), if it is clean and fully pushed.
- A worktree whose branch is already merged into `origin/custom`, `origin/main`,
  `origin/master` or origin's default branch is removed within about 15 minutes,
  provided every linked issue is done or cancelled (never in review: such a task
  can still be woken), the branch has at least one commit of its own, no run is
  using the folder, and the worktree has been idle for 30 minutes.
- The private `run-<id>` folder of a run with no issue is removed once it has
  been idle for 30 minutes, is clean, and its branch has no commit of its own.
  One with work in it waits for the retention period.
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

### Shared package store (automatic, pnpm)

Every task folder used to hold its own installed packages and build output
(127 folders, about 24 GB, one of 1.9 GB). Paperclip now points every setup
command at one shared pnpm store, so `node_modules` are hard links into that
store and a new folder costs almost nothing.

What Paperclip sets in the environment of the setup command (and so of
`pnpm install` inside it):

| Variable | Value |
| --- | --- |
| `npm_config_store_dir` (pnpm 9), `pnpm_config_store_dir` (pnpm 11) | `<repo>/.paperclip/shared/pnpm-store` |
| `npm_config_prefer_offline`, `pnpm_config_prefer_offline` | `true`: use the store before the network |
| `PAPERCLIP_SHARED_DIR` | `<repo>/.paperclip/shared` (override with the same variable on the server) |
| `PAPERCLIP_SHARED_PNPM_STORE_DIR`, `PAPERCLIP_SHARED_VENV_DIR` | store and virtualenv folders for scripts |

Notes:

- The store lives under the repository's `.paperclip/` folder, next to the
  worktrees, so it is on the same filesystem. Hard links only work inside one
  filesystem. If the store ends up on another one (a custom `worktreeParentDir`
  or `PAPERCLIP_SHARED_DIR`), Paperclip does not use it, says so in the run log,
  and pnpm falls back to its own behaviour.
- An empty store is fine: the first install fills it, later ones link.
- A store the operator already configured (`npm_config_store_dir` or
  `pnpm_config_store_dir` on the server) is kept.
- `PNPM_STORE_DIR` is not read by pnpm 9 or 11; do not rely on it. In pnpm 11 a
  `store-dir` line in `.npmrc` is ignored too, so the environment variables
  above are the portable way.
- `scripts/provision-worktree.sh` adds `--prefer-offline` to its installs.
- Hard links share the file, not a copy: a task that edits a file inside
  `node_modules` in place changes it for every folder that links it. pnpm
  re-checks store files on install, but do not patch installed packages by
  hand; use `pnpm patch`.
- Do not symlink one `node_modules` into several worktrees if branches may
  change the lockfile; they would overwrite each other's dependencies.

### No build output in new folders

A new worktree is a clean checkout of the base branch: `dist`, `.turbo`,
`.next`, caches and similar generated folders are not git-tracked, so they are
not copied. Paperclip copies nothing from another folder. Build in the task
folder when you need it (`pnpm build`); do not copy or link `dist` between
folders.

### Size report

Once per new folder the run log gets a `workspace size report` entry, for
example:

```
New worktree size: 1.9 GiB in 98000 files, 120 MiB of it private to this folder (the rest is linked from elsewhere). node_modules 1.7 GiB, build output 0 B; shared package store /…/.paperclip/shared/pnpm-store.
```

"Private" counts only files that no other path hard-links to, which is what the
folder really adds to the disk. A large private figure right after setup means
packages were copied, not linked: check the store warning in the same entry.

### Python (one shared virtualenv)

The shared virtualenv example above is the Python equivalent, for example for
the Nordstrand Dashboard. Use `$PAPERCLIP_SHARED_VENV_DIR` instead of building
the path by hand; it points at `<repo>/.paperclip/shared/venv`, on the same disk
as the worktrees. Create it once, symlink `.venv` to it from each new folder,
and cache downloads with `PIP_CACHE_DIR="$PAPERCLIP_SHARED_DIR/pip-cache"`.

A virtualenv shared this way is read-only in practice: install new packages
from a branch that changes `requirements.txt` into a separate environment.
