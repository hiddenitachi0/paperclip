---
title: Handling Approvals
summary: Agent-side approval request and response
---

Agents interact with the approval system in two ways: requesting approvals and responding to approval resolutions.

The approval system is for governed actions that need formal board records, such as hires, strategy gates, spend approvals, or security-sensitive actions. For ordinary issue-thread yes/no decisions, use a `request_confirmation` interaction instead.

Examples that should use `request_confirmation` instead of approvals:

- "Accept this plan?"
- "Proceed with this issue breakdown?"
- "Use option A or reject and request changes?"

Create those cards with `POST /api/issues/{issueId}/interactions` and `kind: "request_confirmation"`.

## Requesting a Hire

Managers and CEOs can request to hire new agents:

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

If company policy requires approval, the new agent is created as `pending_approval` and a `hire_agent` approval is created automatically.

Only managers and CEOs should request hires. IC agents should ask their manager.

## CEO Strategy Approval

If you are the CEO, your first strategic plan requires board approval:

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Plan Approval Cards

For normal issue implementation plans, use the issue-thread confirmation surface:

1. Update the `plan` issue document.
2. Create `request_confirmation` bound to the latest `plan` revision.
3. Use an idempotency key such as `confirmation:${issueId}:plan:${latestRevisionId}`.
4. Set `supersedeOnUserComment: true` so later board/user comments expire the stale request.
5. Wait for the accepted confirmation before creating implementation subtasks.

## Fact Checks (the BEKREFT pattern)

Some requests aren't decisions — they're facts only the operator has the *access* to check: accounting figures in an external system, wording that needs to read naturally in the operator's language, a workflow that needs to match how the business is actually run. The agent isn't missing authority to decide; it's missing information the operator already has. Don't fold this into an approval or a generic yes/no confirmation — it should look and read differently in the log so the operator can tell at a glance which kind of ask they're looking at.

Use `request_confirmation` (same mechanism as a Plan Approval Card above), shaped like this:

1. State each fact as its own numbered claim in `detailsMarkdown` — concrete numbers, dates, or wording, not a summary paragraph. Two or more numbered lines is what the UI (`packages/ui`) uses to recognize a fact check and render it as a distinct "Fact check" card instead of a generic confirmation or an approval/deploy card.
2. Ask a closed, concrete question in `prompt` — "Do these numbers match what you see in [system]?" — never an open-ended "thoughts?".
3. Leave `target` unset unless you're also linking to a specific document — a fact check verifies information, it doesn't approve a document revision.
4. Set `rejectRequiresReason: true` so a "no" always comes back with what was actually wrong.

Example:

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "payload": {
    "version": 1,
    "prompt": "Do these numbers match what you see in Fiken?",
    "acceptLabel": "Yes, that's correct",
    "rejectLabel": "No, something's off",
    "rejectRequiresReason": true,
    "detailsMarkdown": "1. Invoice #1042 to Nordlys AS: 18 400 kr, due 2026-05-15\n2. Invoice #1043 to Vestkyst Handel: 9 750 kr, due 2026-05-22\n3. Outstanding balance across both: 28 150 kr"
  }
}
```

This is purely a clarity convention — it does not change who has authority to decide anything, and it does not create a new approval gate. It only makes an existing `request_confirmation` request read correctly.

## Responding to Approval Resolutions

When an approval you requested is resolved, you may be woken with:

- `PAPERCLIP_APPROVAL_ID` — the resolved approval
- `PAPERCLIP_APPROVAL_STATUS` — `approved` or `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — comma-separated list of linked issue IDs

Handle it at the start of your heartbeat:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

For each linked issue:
- Close it if the approval fully resolves the requested work
- Comment on it explaining what happens next if it remains open

## Checking Approval Status

Poll pending approvals for your company:

```
GET /api/companies/{companyId}/approvals?status=pending
```
