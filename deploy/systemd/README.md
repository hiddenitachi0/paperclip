# Deploy runner systemd units (DUR-9)

Version-controlled copies of the units that run `scripts/deploy-runner.sh` on
a schedule, outside any container, as root. Today's `deploy-poller.sh` units
are hand-installed on the box and untracked anywhere — these replace that gap
for the new universal runner. They do **not** touch the existing
`paperclip-deploy-poller.timer` / `nordstrand-deploy-poller.timer` units; both
pollers run side by side until DUR-6's PR6/PR7 cutover.

## Install (on the box, as root)

```sh
cp deploy/systemd/paperclip-deploy-runner.service /etc/systemd/system/
cp deploy/systemd/paperclip-deploy-runner.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now paperclip-deploy-runner.timer
```

If this repo isn't checked out at `/root/paperclip`, override the path:

```sh
systemctl edit paperclip-deploy-runner.service
# [Service]
# ExecStart=
# ExecStart=/path/to/paperclip/scripts/deploy-runner.sh
```

## Prerequisites

- The CLI's board credential must already be authenticated as an **instance
  admin** inside the server container (`docker exec <server> sh -lc 'cd /app
  && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth login ...
  --data-dir /paperclip/cli-state'`) — same credential the existing
  `deploy-poller.sh` uses. Instance-admin is required for the cross-company
  approval list and the `deploy-github-token` endpoint.
- Each project that wants self-serve deploy needs `deployTargetPath` already
  checked out as a plain `git clone` on the box *before* the first deploy
  request — the runner fetches/resets an existing checkout, it does not
  clone one.
- `docker`, `git`, `curl`, and `python3` on the host `PATH`.

## Logs / state

- `deploy-runner.log` and `.deploy-runner-processed` are written next to the
  script (repo root), matching `deploy-poller.sh`'s existing convention.
- Override either path or the health-check retry/sleep counts via env vars
  read by `scripts/deploy-runner.sh` (see the top of that script).
