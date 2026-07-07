# FORK.md — customizations in this fork

This fork of [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) stays
upstream-mergeable. Prefer **out-of-tree** plugins / adapters / skills; keep **core edits
surgical** and list every touched core file here so rebases onto upstream stay trivial.

Branch model: `master` mirrors upstream (sync only, never commit). `custom` = deployable
integration branch. Features on `feature/*` → merge to `custom`. Rebase `custom` onto
`master` to take upstream updates.

---

## Core edits (conflict risk on rebase — review these first)

### Feature 1 — "Now" view (live glanceable ops board)

A top-level, glanceable live page with four lanes: **Needs you** (runs whose
`livenessState === "needs_followup"` + actionable approvals) / **Working now** (running) /
**Queued** / **Just finished**. Built on the existing
`heartbeatsApi.liveRunsForCompany()` and `approvalsApi.list()`; dense rows instead of the
320px chat cards used by `ActiveAgentsPanel`. Elevates the buried `/dashboard/live` route.

| File | Change | Type |
|---|---|---|
| `ui/src/pages/DashboardNow.tsx` | The Now view page + lane/row components | **New file** (no conflict) |
| `ui/src/App.tsx` | Added route `dashboard/now` → `<DashboardNow />` | Surgical edit |
| `ui/src/components/Sidebar.tsx` | Added "Now" nav item under the top group | Surgical edit |

New files never conflict on rebase. The two edits are additive single-line insertions;
if upstream reworks `App.tsx` routing or `Sidebar.tsx` nav, re-apply the two inserts.

**Live-activity enhancement (dogfood-driven, `c5c01e97e`):** the Working-now lane shows each
agent's *real current action* (from the live run transcript) instead of the opaque runtime
status, with a "Watch live" cue. Adds `ui/src/lib/run-activity.ts` (`describeRunActivity`,
unit-tested in `run-activity.test.ts`) and edits `DashboardNow.tsx` only.

**Needs-you tasks enhancement (dogfood-driven, `94538e07e`):** the Needs-you lane also surfaces
blocked tasks that are waiting on the *user* (not just run followups + approvals) — e.g. a task
an agent set to `blocked` pending a human decision. Adds `ui/src/lib/task-waiting.ts`
(`classifyTaskWaiting`, unit-tested) which uses Paperclip's blocked-inbox owner/reason where
available and defaults ambiguous/stalled tasks to "waiting on you"; edits `DashboardNow.tsx`.

---

### Feature 4 — Per-company theming (brandColor → whole-UI theme + default-skin toggle)

`Company.brandColor` already existed (it tinted only the company icon). Now it also drives the
app's primary theme tokens per selected company, with a per-company "use default Paperclip skin"
opt-out (localStorage, no schema change) for matching docs/screenshots.

| File | Change | Type |
|---|---|---|
| `ui/src/lib/company-branding.ts` | hex→CSS-var overrides + default-skin preference store | **New file** |
| `ui/src/hooks/useApplyCompanyBranding.ts` | applies the selected company's brandColor as theme vars | **New file** |
| `ui/src/components/Layout.tsx` | one import + one hook call | Surgical edit |
| `ui/src/pages/CompanySettings.tsx` | default-skin `ToggleField` + brand-color hint copy | Surgical edit |

Overrides only the `--primary` family (`--primary`, `--ring`, `--sidebar-primary`, their
foregrounds) on `<html>`, so a brand color tints buttons/rings/accents without harming
background/text contrast. Verified live: `--primary` follows the company's brandColor and the
default-skin toggle reverts it to stock.

---

### Feature 5 — Credential-request flow

An agent files a **named + explained credential request**; it surfaces in the user's inbox and
the Now → Needs-you lane; the user provides the value inline; the secret is created and the
approval resolved (which wakes the requesting agent). Implemented as a new **approval type**
`credential_request` (agents already POST approvals; it auto-counts in the inbox badge with no
plumbing change) plus a fill-secret form on the approval detail.

| File | Change | Type |
|---|---|---|
| `packages/shared/src/constants.ts` | add `credential_request` to `APPROVAL_TYPES` (Zod + free-text DB pick it up automatically) | 1-line edit |
| `ui/src/components/ApprovalPayload.tsx` | label + `KeyRound` icon + payload renderer + `credentialRequestFields` helper | Surgical edit |
| `ui/src/pages/ApprovalDetail.tsx` | "enter secret value → submit" form; `secretsApi.create` then `approve` (wakes agent) | Surgical edit |
| `ui/src/pages/Inbox.tsx` | suppress generic Approve/Reject for `credential_request` | 1-line edit |
| `ui/src/pages/DashboardNow.tsx` | Now-view row shows "Provide credential" (own fork file) | Additive |

No DB migration. Verified live end-to-end: an agent-filed request surfaces in Now/Inbox, the
fill form creates the encrypted secret (name/description preserved) and resolves the approval.
Agent-filing path: `POST /companies/:id/approvals` with `type:"credential_request"`,
`payload:{name, envKey, description}`, `issueIds:[...]` — the same route agents already use.

### Feature 7 — Private-repo managed workspace clones (GITHUB_TOKEN auth)

Managed project-workspace checkouts (`ensureManagedProjectWorkspace` in
`heartbeat.ts`) did a bare `git clone <repoUrl>` with a sanitized env and **no
credentials**, so a project workspace pointed at a **private** GitHub repo could
never materialize — the clone hung on the username prompt, the workspace stayed
un-cloned, and every project-scoped run got blocked with `workspace_validation_failed`
(Paperclip refuses to launch git-sensitive adapters from the agent fallback cwd).
This surfaced standing up the Nordstrand dashboard (private repo).

Now, when the repo is a `github.com` https URL, the clone authenticates with the
company's `GITHUB_TOKEN` / `GH_TOKEN` / `PAPERCLIP_GITHUB_TOKEN` secret (same
names + resolver semantics as the GitHub external-object provider). The token is
passed via the environment and read by an inline `credential.helper`, so it never
appears in the process argv, the cloned repo's `.git/config`, or any error message
(the `repoUrl` in errors stays clean). No token bound → clone proceeds
unauthenticated exactly as before (public repos unaffected).

| File | Change | Type |
|---|---|---|
| `server/src/services/heartbeat.ts` | `resolveManagedCloneGitHubToken` + `isGitHubHttpsRepoUrl` helpers; `ensureManagedProjectWorkspace` takes an optional `resolveGitHubToken` and injects a credential helper into the clone; primary-workspace call site wires the resolver | Surgical edit (hot path) |

Rebase note: `heartbeat.ts` is large and churns upstream — re-apply the three edits
(two new helpers before `ensureManagedProjectWorkspace`, the clone-block auth
injection, and the `resolveGitHubToken` arg at the primary call site) if they
conflict. Behaviour is additive/opt-in, so a clean re-apply is low-risk.

### Feature 8 — Self-serve integration tokens (canonical-key dropdown + auto-bind)

Adding a tool token used to be two fiddly manual steps for a non-expert: create a
company secret, then separately open an agent's config editor and hand-type the
exact env-var name to bind it. Now the Secrets page has an **"Add integration
token"** dialog: pick a **known env key from a dropdown** (or custom), paste the
value, choose **who gets it** (a specific agent, or all agents) → it creates the
secret *and* writes the env binding on each target agent in one action. Different
agents can hold different values for the **same** key (e.g. a write `GITHUB_TOKEN`
for a lead, read-only for the rest) — because binding is per-agent.

Built entirely on existing, proven plumbing (no schema change, no run hot-path
change): the dialog composes `secretsApi.create` + a **read-modify-write** of each
agent's `adapterConfig.env` (never a bare overwrite — existing bindings like
`CLAUDE_CODE_OAUTH_TOKEN` are preserved), and the server's existing
`syncEnvBindingsForTarget` derives the binding rows on save.

| File | Change | Type |
|---|---|---|
| `packages/shared/src/integration-keys.ts` | Canonical catalog `KNOWN_INTEGRATION_ENV_KEYS` + `GITHUB_TOKEN_SECRET_NAMES` + `PUSH_CAPABILITY_ENV_KEYS` (single source of truth) | **New file** |
| `packages/shared/src/index.ts` | Re-export the catalog | Surgical edit |
| `server/src/services/github-external-object-provider.ts` | `DEFAULT_GITHUB_TOKEN_SECRET_NAMES` now = shared `GITHUB_TOKEN_SECRET_NAMES` | 1-line dedupe |
| `server/src/services/heartbeat.ts` | `PUSH_CAPABILITY_ENV_KEYS` + managed-clone token names now sourced from shared catalog | 2-line dedupe |
| `ui/src/components/AddIntegrationTokenDialog.tsx` | The dialog (dropdown + value + agent target → create secret + bind) | **New file** |
| `ui/src/pages/Secrets.tsx` | "Add integration token" button + dialog wiring | Surgical edit |

Deliberately deferred (Phase 2): a true **company-default env layer** so brand-new
agents auto-inherit a token without re-applying. That one genuinely needs a schema
migration (`companies.env` + a `"company"` binding target type) and a new merge
layer in `resolveExecutionRunAdapterConfig` — out of scope here since per-agent
binding (incl. an "all agents" one-click) already covers the stated need.

### Infra — `uv` in the runtime image (Python-app workspaces)

The base image ships `python3` but no `pip`/`ensurepip`, so agent worktrees can't bootstrap a
Python project (needed for the Nordstrand Django dashboard). Added `uv` to the production stage
so `uv venv` / `uv pip install -r requirements.txt` / `uv sync` work in agent worktrees.

| File | Change | Type |
|---|---|---|
| `Dockerfile` | `COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/` in the `production` stage | Additive 1-line (+comment) |

Additive; low rebase-conflict risk. Pin the uv image tag if reproducible builds become required.

## Out-of-tree work (near-zero conflict risk)

### Feature 2 — Cowork/Claude Code → Paperclip importer

`tools/cowork-importer/` — a standalone, dependency-free Node CLI (`convert.mjs`) that turns a
Claude Code / Cowork project (`CLAUDE.md` + `.claude/agents/*.md` + `.claude/skills/*/SKILL.md`)
into an `agentcompanies/v1` package and imports it via the official `POST /companies/import`
API. Single-task project → one agent; broader project → lead + subagents (org hierarchy) +
skills. **Zero core edits** — lives outside the pnpm workspace (`tools/` is not a workspace
glob), touches no `packages/`, `server/`, `ui/`, or `cli/` code. See its README for usage.

### Feature 3 — Image/video approval gate (Media Studio plugin)

`packages/plugins/media-studio/` — a Paperclip plugin (worker + `detailTab` UI) that generates
an image, previews it, files a **board approval** + a work-product in `ready_for_review`, and
only posts once approved (approve / request-changes / regenerate). Generation is behind a
`GenerationProvider` interface with **mock** (keyless), **fal** (Fal.ai), and **comfyui**
(swappable GPU endpoint) implementations, chosen in plugin settings. The approval it files is a
normal `request_board_approval`, so it also surfaces in **Feature 1's Now → Needs-you lane**.

**Zero edits to existing core files.** The plugin uses only existing REST routes from its UI
(`/issues/:id/work-products`, `/companies/:id/approvals`, `/approvals/:id/approve|request-revision`,
`/work-products/:id`, `/issues/:id/comments`). It IS a new workspace package under
`packages/plugins/*`, so `pnpm-lock.yaml` gains its dev deps (same pattern as the repo's example
plugins) — no existing source touched.

> Deliberately deferred: fully-autonomous filing (the agent itself creating the work-product +
> approval, not just generating the preview) would need a small additive plugin-SDK RPC surface
> for work-products/approvals (the worker host-client has no such method today). Kept out to
> hold core edits at zero; it's a clean future addition if we want agent-side filing.

### Feature 6 — Mission Control v1 (federation)

`packages/plugins/mission-control/` — a plugin (sidebar link + `page` slot) giving a **portfolio
view across remote Paperclip instances**. Register remotes (URL + board API key); per remote
company it shows live runs / queued / needs-you / cost / agents / tasks with a deep link into
the remote's Now view. The worker stores remotes in plugin state and aggregates each remote's
public REST API (`/api/health`, `/api/companies`, `/api/companies/stats`, `/live-runs`,
`/approvals`) with the board key as `Authorization: Bearer`. Board keys stay server-side (never
returned to the browser).

**Zero core edits** (new `packages/plugins/*` package). Verified on one box: builds/installs/
loads, page+sidebar render, add/remove/refresh registry persists, board-key auth works, and the
aggregation logic returns correct per-company stats + deep links against the live API. Note:
`ctx.http.fetch` SSRF-blocks private/loopback IPs, so single-box **localhost self-federation is
blocked by design** (shown as "unreachable"); Tailscale's `100.64/10` range is NOT blocked, so
real remotes work — full multi-server verification lands with Phase 2.

_Still planned per HANDOFF roadmap:_ Productize-a-project (item 7), Telegram bridge plugin,
`opencode-local`→Ollama config.
