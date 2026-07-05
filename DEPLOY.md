# DEPLOY.md — paperclip-fork production (Hetzner + Tailscale)

The always-on brain runs the `custom` branch in Docker on a Hetzner CPU VPS, reachable **only
over Tailscale** at an HTTPS URL, in `authenticated/private` mode with durable volumes.

## Current deployment

- **Server:** Hetzner CX33 (Ubuntu 24.04, 4 vCPU / 8 GB), public IP `89.167.46.191`.
- **Tailnet:** machine `paperclip-prod` = `100.115.97.22` on tailnet `tailc4d456.ts.net`.
- **URL (tailnet only):** `https://paperclip-prod.tailc4d456.ts.net` (via `tailscale serve` → `127.0.0.1:3100`).
- **Mode:** `authenticated` / `private`. **Stack:** `docker/docker-compose.yml` (server + Postgres 17)
  + `docker/docker-compose.prod.yml` (hardening). App dir on server: `/root/paperclip`.
- **Data:** Docker named volumes `paperclip-data` (PAPERCLIP_HOME) + `pgdata` (Postgres). Survives
  container/host restarts (`restart: unless-stopped`, `tailscaled`/`docker` enabled).

## Security posture

- `ufw`: only `22/tcp` (SSH) + the `tailscale0` interface are allowed; everything else denied.
- Published ports bound to `127.0.0.1` (Postgres not published at all) — nothing on the public
  internet. All app access is through the Tailscale-served HTTPS URL.
- `BETTER_AUTH_SECRET` + all runtime config live in `/root/paperclip/.env` (gitignored, never committed).

## First-time bring-up (what was done)

```bash
# On the server (root):
curl -fsSL https://get.docker.com | sh
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled && tailscale up --ssh --hostname paperclip-prod   # approve in admin console
tailscale serve --bg --https=443 http://127.0.0.1:3100                              # enable Serve in admin console first
git clone https://github.com/hiddenitachi0/paperclip.git /root/paperclip && cd /root/paperclip && git checkout custom
ufw allow 22/tcp && ufw allow in on tailscale0 && ufw --force enable
printf 'BETTER_AUTH_SECRET=%s\nPAPERCLIP_PUBLIC_URL=https://paperclip-prod.tailc4d456.ts.net\nPAPERCLIP_ALLOWED_HOSTNAMES=paperclip-prod.tailc4d456.ts.net,localhost,127.0.0.1\n' "$(openssl rand -hex 32)" > .env
docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --build
# Then open the HTTPS URL in a tailnet browser and "Claim this instance" for the first admin.
```

## Operating it

```bash
cd /root/paperclip
COMPOSE="docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml"
$COMPOSE ps                 # status
$COMPOSE logs -f server     # app logs
$COMPOSE restart server     # restart app

# Deploy the latest custom (the gated deploy path — pull + rebuild + swap + health-check):
./scripts/deploy-prod.sh            # logs to deploy.log; no-op if custom hasn't moved

# (manual equivalent) take an upstream/fork update:
git pull && $COMPOSE up -d --build
```

## Deploy on approval (agent asks → you approve → it deploys)

`scripts/deploy-poller.sh` (run by the `paperclip-deploy-poller` systemd timer, ~1/min) watches
for **approved deploy requests** and runs `deploy-prod.sh` for each, commenting the result back.

- A **deploy request** is a board approval with `payload.kind == "deploy"` — it appears in the
  operator's **Needs-you** lane / Inbox with an **Approve** button. Approve = one click; the
  deploy then runs itself and comments "Deployed — commit X is live."
- An agent files one via `POST /companies/:id/approvals` with
  `{ type: "request_board_approval", payload: { kind: "deploy", title: "Deploy … to production", note: "…" } }`.
- Poller state: processed approval ids in `.deployed-approvals`; logs in `deploy-poller.log`.
- Timer control: `systemctl status paperclip-deploy-poller.timer`; disable with
  `systemctl disable --now paperclip-deploy-poller.timer` to require manual `deploy-prod.sh` again.

## Back up data

```bash
cd /root/paperclip
docker run --rm -v paperclip-data:/d -v "$PWD":/b alpine tar czf /b/paperclip-data.tgz -C /d .
```

Adding a client instance later (Phase 2 scale-out): same recipe on a new box with its own tailnet
hostname in `.env`; register it in the **Mission Control** plugin with a board API key.
