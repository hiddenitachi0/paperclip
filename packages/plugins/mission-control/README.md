# @paperclipai/plugin-mission-control

A **portfolio view across multiple Paperclip instances** — roadmap-6 federation for the
paperclip-fork. Adds a **Mission Control** sidebar link + page that lists your registered remote
instances and, per remote company, shows **live runs / queued / needs-you / cost / agents /
tasks** with a deep link straight into that remote's Now view.

Motivation: ownership, billing, and handoff of client companies running on their **own servers**
(over Tailscale) — not load balancing.

## How it works (zero core edits)

A standalone plugin (`packages/plugins/mission-control/`). The **worker** stores registered
remotes in plugin state and aggregates each remote's portfolio by calling its public REST API
(`/api/health`, `/api/companies`, `/api/companies/stats`, `/api/companies/:id/live-runs`,
`/api/companies/:id/approvals`) with the remote's **board API key** as `Authorization: Bearer`.
The **page** UI shows the portfolio and lets you add/remove remotes. Board API keys live only in
server-side plugin state and are never returned to the browser.

## Build & install (dev)

```bash
pnpm --filter @paperclipai/plugin-mission-control build
pnpm paperclipai plugin install ./packages/plugins/mission-control
```

Open the **Mission Control** link in the sidebar.

### Get a board API key for a remote

On the remote instance: `POST /api/board-api-keys` with `{ "name": "mission-control" }` →
returns `{ token }`. Paste `token` as the board API key. (Board keys inherit the creator's
companies — mint a narrow key per remote.)

### Reaching remotes (SSRF guard)

`ctx.http.fetch` blocks private/reserved IP ranges (RFC-1918 `10/172.16/192.168`, loopback
`127.x`, link-local) to prevent SSRF. It does **not** block Tailscale's CGNAT range
(`100.64.0.0/10`), so **Tailscale remotes work**. A consequence: **loopback self-federation
(`http://localhost:3100`) is blocked** — on a single box the remote shows as unreachable
("private/reserved ranges"). Use a Tailscale hostname/IP (or any public address) for real
verification; the aggregation logic is identical either way.

## Notes / limits (v1)

- Board keys are stored in plugin state (server-side). A future hardening is to store them as
  Paperclip Secrets and resolve by ref.
- Cost = the company's monthly spend/budget (`spentMonthlyCents`/`budgetMonthlyCents`). Health =
  reachability + reported version. Deep links assume the remote runs this fork (Now view route).
- Loopback is SSRF-blocked (see above) — self-federation on one box isn't possible; real
  multi-server use lands with Phase 2 (Hetzner + Tailscale).
