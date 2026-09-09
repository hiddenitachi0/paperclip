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

## Database credentials (company isolation cutover)

See [the cutover runbook](../rls-cutover-runbook.md) for the order to change these in. All default to "same as `DATABASE_URL`", so an unset value changes nothing.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_BYPASS_URL` | `DATABASE_URL` | Connection string for the pool that background schedulers and instance-wide operations use. Point it at a login that holds `paperclip_app_bypass` (`paperclip_app_bypass_login` from migration 0164). When it differs from `DATABASE_URL`, every cross-company operation in the app is served from this pool. |
| `DATABASE_MIGRATION_URL` | `DATABASE_URL` | Connection string used to run schema migrations and database backups. Must be the table owner. Required once `DATABASE_URL` is no longer the owner. |
| `PAPERCLIP_DB_ROLE_PREFLIGHT` | `warn` | `strict` makes the server refuse to start when the database logins cannot work together (e.g. a scoped `DATABASE_URL` with no bypass pool). The default only logs the problem. |
| `PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS` | (off) | `1`/`true` logs, once per table, every query that reaches a company-scoped table without declaring a company. Diagnostic for the runbook's gate check; costs a little per query, so switch it off afterwards. |
| `PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED` | `true` | Hourly sweep that deletes old rows from the `cross_company_access_log` audit table. `false` keeps every row. |
| `PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS` | `30` | How many days of audit rows to keep. |
| `PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_INTERVAL_MINUTES` | `60` | How often the sweep runs. |
| `PAPERCLIP_SCHEDULER_BYPASS_AUDIT_COALESCE_MINUTES` | `60` | Each background scheduler chain writes its audit row at most once per this many minutes instead of on every tick. `0` writes one row per tick (debugging only). |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
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
