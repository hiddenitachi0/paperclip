---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Real-money crypto lock

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_CRYPTO_REAL_MONEY` | (unset = forbidden) | Server-wide lock on real-money ("main network") crypto. Only the exact value `allowed` permits real money; unset, empty, or any other value (`true`, `1`, `Allowed`) forbids it. Leave it unset unless the operator has decided real money may ever be used on this server. |

While real money is forbidden the server refuses, with a 403 and a plain message: creating or importing a main-network wallet, turning on a company's real-money setting (even for an owner who types `REAL MONEY`), and every main-network signature (Bitcoin, Ethereum and Solana sends; Hyperliquid orders and withdrawals). The check is made at the signing layer and on every request, so flipping `company_crypto_settings.mainnet_enabled` in the database does not get around it. Existing main-network wallets and settings are treated as frozen without being changed (no wallet status is written), so removing the variable's restriction later needs no clean-up. Test-network wallets are unaffected.

The server logs one warning at boot stating the lock state (never any secret), and instance administrators see a banner while the lock is on. Changing the variable takes effect after a server restart. Lifting the lock also brings back any company whose real-money setting was already stored as on: those companies can use main-network wallets again immediately, so check `company_crypto_settings.mainnet_enabled` before setting `allowed`.

The variable is read from the server's real process environment (the deploy settings) only. A `PAPERCLIP_CRYPTO_REAL_MONEY` line in the instance `.env` or the working-directory `.env` is ignored (the name is logged, never a value), because agents can write those files. This holds for every way of starting Paperclip, including `paperclipai run` and onboard installs, which use the same refusal list. Do not add it to the host-actions `envFiles` key list (`doc/operator-actions.md`) either.

Before first deploying a version with this lock, check that no main-network wallets exist; see the pre-deploy check on the ship-plan card.

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_REQUIRE_ENV_KEY` | `false` | Set to `true` or `1` to make the `local_encrypted` provider use only `PAPERCLIP_SECRETS_MASTER_KEY`. It never reads, chmods or creates a key file, and fails with a clear error when the key is missing |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
