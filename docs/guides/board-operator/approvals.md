---
title: Approvals
summary: Governance flows for hiring and strategy
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent (typically a manager or CEO) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### CEO Strategy

The CEO's initial strategic plan requires board approval before the CEO can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

### Deploy

When an agent finishes work destined for a live site or environment, it files a `kind:"deploy"` approval before the deploy actually runs. Each project has its own deploy policy, set from the project's Settings panel (deploy transport, mode, and ask-first categories):

- **`preview_only`** — live deploys (both Git push and SFTP) are refused server-side before a card is even created. Agents can still run the project's preview command; there is no way to reach a live deploy target while this mode is set.
- **`approval_every_time`** — every deploy request creates a card in your queue. This is the default if no mode is set.
- **`auto_after_review`** — reserved for a future automation path and currently behaves identically to `approval_every_time`. Turning deploy approvals fully automatic is a deliberately separate, board-gated change (mirroring how `merge_pr` automation works) and has not shipped yet.

**Ask-first categories** (`askFirstActions`) are an allowlist of change categories (e.g. schema/data changes, dependency changes) that always force a card, regardless of the mode above — including under a future automated `auto_after_review`. The server enforces this from the project's own stored policy only; it never trusts anything an agent supplies about the deploy itself, so an unrecognized or ambiguous change still fails closed to "show me a card" rather than silently skipping one.

Both `deployPolicy` fields and the SFTP connection fields (host, credential binding, upload allowlist) are board-only to edit — no agent role can change what triggers its own approval gate.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
