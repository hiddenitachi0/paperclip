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

---

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

_Still planned per HANDOFF roadmap:_ per-company theming, credential-request flow, Mission
Control federation plugin, Telegram bridge plugin, `opencode-local`→Ollama config.
