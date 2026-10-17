---
name: meeting-notes
description: Turn a meeting transcript, recording summary or rough notes into clear minutes with decisions, action items (owner and due date) and open questions, and propose Paperclip tasks for the actions. Use when a task hands you meeting notes or a transcript and asks for minutes, a summary or follow-ups.
key: paperclipai/optional/communication/meeting-notes
recommendedForRoles:
  - assistant
  - secretary
  - project-manager
  - hr
tags:
  - meetings
  - minutes
  - action-items
  - summary
  - communication
---

# Meeting Notes

Turn what was said into what was decided and who does what next. Someone who missed the meeting should understand the outcome in one minute, and every action should have an owner and a date.

## When to use

- A task contains a transcript, a recording summary, chat log or rough notes from a meeting.
- Someone asks for "minutes", "a summary of the call", "action items" or "follow-up email".
- A recurring meeting needs its notes filed in the same format every time.

## When not to use

- There is no source material (no transcript or notes). Do not reconstruct a meeting from memory or guesses; ask for the notes and set the task to `blocked`.
- The request is to schedule the next meeting. Write the minutes here, then use `paperclipai/optional/operations/calendar-scheduling`.

## Hard rules

- **Only what was actually said.** Every decision and action must be traceable to the source. If a point is unclear, write it under "Open questions", never as a decision.
- **Decisions are not discussions.** "We talked about raising prices" is a discussion. "Prices go up 5% from 1 March" is a decision. Only record the second kind as a decision.
- **No owner, no action.** If nobody took an action, list it as "Owner needed" so the organiser can assign it. Never pick an owner yourself.
- **Dates as stated.** Use the due date that was said. If none was said, write "no date set" — do not invent one.
- **Sensitive content stays out.** Leave out personal remarks, health, salary or HR details unless the task explicitly asks for them; write "(private discussion, not minuted)".
- **Sending is the owner's call.** If a follow-up email to attendees is wanted, draft it and ask for approval before it goes out (see the `paperclip` skill for approvals).

## Procedure

1. **Read the whole source once** before writing. Note the meeting title, date, time zone and attendees (and who was absent, if stated).
2. **Extract decisions.** Look for agreement phrases ("let's go with", "agreed", "we'll do", "final answer"). Write each as one clear sentence.
3. **Extract action items.** For each: what, owner, due date, and the decision it supports. Merge duplicates.
4. **Extract open questions and risks** — things raised but not settled.
5. **Write a 3–5 line summary** at the top: purpose, the main outcome, the most important next step.
6. **Propose tasks.** For each action item owned by an agent or a person who uses Paperclip, propose a Paperclip task (title, description, owner, due date). Create them only if the task says you may; otherwise list them for the organiser to approve.
7. **Post the minutes** as a document on the task, and a short comment linking to it.

## Output template

```md
# <Meeting title> — <date>, <time zone>

**Attendees:** <names> · **Absent:** <names or "not recorded">
**Source:** <transcript / notes from whom>

## Summary
<3–5 lines.>

## Decisions
1. <Decision, one sentence.> (<who decided / when in the meeting, if useful>)

## Action items
| # | Action | Owner | Due | Linked decision |
|---|--------|-------|-----|-----------------|
| A1 | <action> | <name or "Owner needed"> | <date or "no date set"> | D1 |

## Open questions
- <question> — raised by <name>

## Proposed Paperclip tasks
- **<title>** — assign to <owner>, due <date>. <one-line description>

## Draft follow-up email (needs your approval before sending)
> <short email: summary, decisions, action table, next meeting if known>
```

## Done when

- [ ] Every decision and action can be found in the source.
- [ ] Every action has an owner (or says "Owner needed") and a date (or "no date set").
- [ ] Open questions are separated from decisions.
- [ ] Proposed tasks are listed; nothing was sent without approval.
