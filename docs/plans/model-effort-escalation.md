# Task model/effort: escalation and goal-loop (slices 3–4, plan only)

Status: plan for later. Slices 1–2 (per-task selector with "Agent default (…)",
one effort list per adapter in `packages/shared/src/model-effort.ts`, a server-side
typo guard, and sub-task flow-down with the company switch "Sub-tasks inherit
model/effort") shipped on branch `task-model-effort`.

## What already exists (checked 10 Oct 2026)

Most of "escalate on request" was built earlier as DUR-31/DUR-32. Build on it;
don't start over.

| Piece | Where | What it does |
|---|---|---|
| Boost ask | approval `request_board_approval`, payload `kind: "model_boost"` (`packages/shared/src/validators/approval.ts`) | The agent asks for a model and/or effort for its **current** task, with `reason`, `estimatedExtraCostCents`, `maxSpendCents`, `durationMinutes` (default 4h, max 24h). |
| Boss first | `server/src/services/model-boost-boss-review.ts`, `POST /api/approvals/:id/boss-review` | Goes up `reportsTo`. The boss gets 30 min to decline or forward it. The operator is only pinged once the boss has answered or the time is up. |
| Grant | table `escalation_grants` (issue + agent + approval, granted model/effort, `maxSpendCents`, `expiresAt`, status) | Created on approval and applied at dispatch (`mergeModelProfileAdapterConfig` in heartbeat.ts). Ends on time-out or once spend reaches the cap (`evaluateCostEvent`), with a plain note on the task. |
| Wording | `packages/shared/src/model-boost.ts` | "Backend Engineer asks to use Opus at high effort for this task, up to $20, for the next 4 hours". The same words on the card, in Telegram and in the activity log. |
| Task display | IssueProperties "Boost" row | Shows the granted model/effort, spend against the cap, and when it expires. |
| Goal loop | `server/src/services/goal-condition-judge.ts` (DUR-32), `executionPolicy.monitor` kind `goal_condition` | A separate judge checks a plain-English finish line after each round. Capped by `maxAttempts` and `timeoutAt`. |

## Gaps to close

### 1. Approval flow (Telegram, one tap)

- Check from start to finish that a forwarded boost ask reaches the operator's
  Telegram bot as **one message with Approve / Decline buttons** and the
  plain-language line. The bridge is a separate service and deploys don't
  restart it, so test it live. If it can only link to the card today, add the
  inline buttons and route them to the existing approve/reject endpoints.
- The reply must state the cap and expiry: "Approved: Opus at high effort, up
  to $20, until 18:40".
- A decline lets the agent keep working on its normal setting. This is
  already how it works; keep it.

### 2. Money caps (company level)

The cap on a single ask exists (`maxSpendCents`). There is no ceiling across
asks. Add per-company settings, either as columns on `company_payment_settings`
or as a new `company_boost_settings` row (one row per company):

| Column | Default | Meaning |
|---|---|---|
| `boost_enabled` | true | Off means agents can't ask at all; the API says so in plain words. |
| `boost_max_per_ask_cents` | 2000 | Asks above this are refused when filed, with the limit in the message. |
| `boost_monthly_budget_cents` | 10000 | The sum of `maxSpendCents` over grants this calendar month. Asks that would go over it are refused. |
| `boost_auto_approve_under_cents` | null | Optional: small asks are approved without the operator (still logged and announced on Telegram). Off by default. |

Enforce these in `escalationGrantService.assertRequestAllowed`. Show
"$X of $Y boost budget used this month" on the card.

### 3. Boosts and sub-tasks

A grant covers one (issue, agent) pair and does **not** flow down today.
Decision needed: should a boosted task's sub-tasks get the boost? Proposal:
no by default, because money caps don't add up cleanly across sub-tasks. Offer
an explicit "also for sub-tasks" option on the approval card. If chosen,
sub-tasks share the parent grant's cap (spend is counted over the parent and
its children). Explicit sub-task settings still win, the same as flow-down.

### 4. Asking from inside a run

Agents ask by filing an approval through the API (documented in
`skills/paperclip/SKILL.md`). Possible later addition: a `request_boost` tool for
quick (Lane A) agents, so a chat-style agent can ask without composing the
JSON. It should use the same server path and the same limits.

### 5. Model-agnostic goal loop

The judge currently runs on whatever its agent is configured with. Planned
changes:
- Add a `judgeModel`/`judgeEffort` field on the goal-condition monitor,
  checked with the same typo guard (`validateModelAgainstList`). Default is
  the cheap profile of the judging agent.
- Optional "escalate on stall": after N rounds marked "not met" with no
  progress, file a boost ask automatically (same approval flow and caps)
  instead of looping on the same model. Off by default.
- Hard stop when `maxAttempts`, `timeoutAt` or the task's budget is hit.
  This exists already; keep the plain note.

## Order of work

1. Telegram one-tap check and fix (small, can be seen right away).
2. Company boost caps (new settings row, enforced at filing, budget line on the card).
3. Judge model/effort on the goal loop.
4. Boost for sub-tasks (needs Filip's decision on point 3).
5. `request_boost` tool for quick agents.

Each step is one PR with route tests (refusals in plain words) and a UI test
for the card text.
