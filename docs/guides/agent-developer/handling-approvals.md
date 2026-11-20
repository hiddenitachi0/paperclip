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

## Fact-Check Confirmations (BEKREFT)

Some `request_confirmation` cards are not asking the board/user to authorize an action — they are asking the board/user to verify a fact that only they can check (numbers in an external system like accounting software, whether phrasing reads naturally, whether a described workflow matches how the business is actually run). This is the BEKREFT pattern: it grants no new authority and settles no permission gate, it only surfaces something the agent cannot verify on its own.

Set `payload.factCheck: true` explicitly on these cards so the UI renders them as visually distinct from an ordinary accept/reject decision card:

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "payload": {
    "version": 1,
    "prompt": "Do these figures match your records?",
    "detailsMarkdown": "1. orders_2024 has 40,201 rows.\n2. orders_2024_backup has 40,201 rows.",
    "factCheck": true
  }
}
```

Do not try to signal this through `prompt` or `detailsMarkdown` wording (e.g. a numbered list of claims) and rely on the UI to infer it — that inference was spoofable and has been replaced by this explicit field. Omit `factCheck` (or set it `false`) for a normal decision-ask; it defaults to `false`.

The flag is necessary but not sufficient. The UI still refuses the fact-check styling when any of `prompt`, `detailsMarkdown`, `title` or `summary` reads like a decision or action request (money movement, outbound communication, deploy/merge/delete, "should I ...", and so on), and it needs at least two numbered lines in `detailsMarkdown`. Phrase fact checks so they pass on their own merits:

- Make the ask a verification question: "Do these figures match your records?", "Is this correct?", "Stemmer disse tallene?" — not a topic label like "Vendor account status".
- Make every numbered line a plain statement of a checkable fact ("Invoice #1042 is 18 400 kr, due 2026-05-15"), never an instruction ("Release the funds") or a pending event ("The money goes out at 17:00").
- Never attach consequences to silence or to the confirmation itself ("unless you object", "if I don't hear back", "will proceed", "once you confirm"). A fact check settles no action; if an action depends on the answer, file it as a normal decision-ask instead.

An instance can additionally enable **Stricter fact-check cards** (instance settings, General). With that on, a confirmation only gets the fact-check styling when it positively matches the shape above; anything else falls back to the ordinary decision card. Writing fact checks as described keeps them rendering the same way in both modes.

## One Deploy Card Per Day

A project has at most one open deploy card. Filing a second one is refused with HTTP 409, code `deploy_card_open` and `existingApprovalId`. Add your finished work to the open card instead:

```sh
paperclipai approval deploy-add <approvalId> --commit <full-sha> \
  --item "Fixes the sign-in error" --issue NOR-123 \
  --item "Adds the weekly report email" --issue NOR-124
```

(`POST /api/approvals/:id/deploy-items` with `{commit, items[], issueIds[]}`.) `--commit` is the day's combined commit; every deploy check runs again against it. Each item is one plain-language line (1–300 characters, at most 50 per card) and is shown on the card. Only a deploy card that is still waiting accepts items, and it needs the right to ask for a deploy. Only the agent that filed the card, or a board user, may add items, and never to a card a person filed. Every deploy card carries a revision number (`payload.cardRevision`: 1 when filed, up by one each time items are added or the card is resubmitted) that the card shows. Approving sends the revision the person saw (`expectedCardRevision`; `paperclipai approval approve <id> --card-revision <n>`), and a card that changed after that is refused with a 409: "This card changed after you opened it. Look at it again before approving." A card that was never changed (revision 1) can still be approved without sending one. If the checks on the build are still running, the runner waits up to 4 hours before closing the card.

## Deploy Cards Wait for Green Checks

A deploy card is refused (HTTP 422) while the checks of the version it ships are still running (`deploy_ci_pending`: "This version's checks are still running. File the card when they are green.") or have failed (`deploy_ci_failed`, naming the failed checks). This applies when filing, resubmitting and adding items. A version with no checks at all, or one GitHub cannot be asked about, goes through, like at the deploy runner. A board user may file anyway with `payload.allowUnfinishedChecks: true`; the card then carries `payload.checksOverride` with what the checks looked like. A board rollback (`allowBackwardDeploy`) never waits for checks. Agents can never set `allowUnfinishedChecks`.

To wait for green from a box without GitHub access, ask the server:

```sh
paperclipai ci status --project <projectId> --sha <sha> -C <companyId>
```

It prints `green`, `pending (2 checks still running: ...)` or `failed: <check names>`. Exit code 0 is green (or no checks), 2 pending, 1 failed, 3 GitHub could not be asked, 4 the request to the server itself failed (restart, 502, network). A wait loop should keep waiting on 2, 3 and 4, and give up only on 1. (`GET /api/companies/:companyId/projects/:projectId/ci-status?sha=<7-40 hex>`.)

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
