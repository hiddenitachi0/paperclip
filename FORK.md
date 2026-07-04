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

_None yet._ Planned per HANDOFF roadmap: Cowork→Paperclip importer (external tool),
image/video approval-gate plugin, per-company theming, credential-request flow,
Mission Control federation plugin, Telegram bridge plugin, `opencode-local`→Ollama config.
