---
name: lead-follow-up
description: Qualify incoming leads, keep a simple pipeline (stage, next step, due date), and draft personalised follow-up messages for human approval — using only real data, respecting consent and opt-outs, with no false urgency. Use when a task involves new leads, prospect lists, sales follow-ups, quotes awaiting a reply, or a stalled deal.
key: paperclipai/optional/sales/lead-follow-up
recommendedForRoles:
  - sales
  - account-manager
  - customer-success
  - marketing
tags:
  - sales
  - leads
  - pipeline
  - follow-up
  - crm
---

# Lead Follow-up

Make sure no promising lead is forgotten and every follow-up is relevant, honest and welcome. You prepare and track; a human approves anything that is sent.

Use the `paperclip` skill for task mechanics. For reading and sorting an inbox use `paperclipai/optional/communication/email-triage`; for booking calls use `paperclipai/optional/operations/calendar-scheduling`.

## When to use

- New leads arrived (form, email, event list, referral) and need sorting.
- Quotes or proposals are waiting for a reply.
- A weekly pipeline review is due.
- A deal has gone quiet and needs a next step.

## When not to use

- Bulk cold outreach to purchased or scraped lists. Do not do it.
- Support questions from existing customers: use a support skill.
- Price changes, discounts or contract terms: prepare options, but a human decides.

## Procedure

1. **Collect the leads** from the sources the task names. For each, record only what you actually have: name, company, how they reached us, what they asked for, date, consent basis (they contacted us / existing customer / opted in).
2. **Qualify** each lead with four questions, marked yes / no / unknown:
   - Need: did they describe a problem we solve?
   - Fit: are they the kind of customer we serve (size, location, sector)?
   - Timing: is there a date or event driving it?
   - Authority: are they a decision-maker or connected to one?
   Two or more "yes" = **qualified**; otherwise **nurture** or **not a fit** (with reason).
3. **Update the pipeline.** Every open lead has exactly one stage, one next step and one due date:

   | Stage | Meaning |
   |---|---|
   | New | Not contacted yet |
   | Contacted | First reply sent, waiting |
   | Conversation | Two-way contact, needs understood |
   | Proposal | Offer/quote sent |
   | Won / Lost | Closed, with reason |
   | Nurture | Not now; revisit date set |

4. **Draft follow-ups** for leads whose next step is due. Personalise only from facts in the record (what they asked, their company's public site). Keep it short: reference, value, one clear question or call to action, easy way to say no.
5. **Respect consent.** Anyone who asked not to be contacted, unsubscribed or bounced is marked "do not contact" and gets no draft. Marketing-style messages need a lawful basis (GDPR: consent or legitimate interest with easy opt-out; CAN-SPAM: real sender, physical address, working unsubscribe).
6. **Post for approval.** Put drafts and pipeline changes on the task; send nothing until a human approves (unless the company's settings explicitly let you send a named template).
7. **Close the loop.** After sending (by a human or approved automation), update stage, next step and date. Leads with no reply after three attempts move to Nurture or Lost — not a fourth chaser.

## Follow-up draft template

```
To: <name> <email>    Lead: <company> — stage <stage>, last contact <date>
Why now: <the real trigger: their question, quote expiry, agreed date>
Subject: <specific, no clickbait>

Hi <first name>,
<one line referring to what they actually asked or said>
<one line of value or the answer to their question>
<one clear question / proposed next step>
<if marketing-type: unsubscribe line>
<sender name, role, company>
```

## Pipeline summary template

```
Pipeline <date>: <n> open (<new> new, <contacted>, <conversation>, <proposal>)
Due today: <lead — next step>
Stalled (>14 days no movement): <lead — suggested action>
Won/Lost this period: <lead — reason>
Do-not-contact added: <count>
```

## Hard rules

- Never send, schedule or auto-reply without a person's approval in Paperclip for that exact message (a task or message saying you may is not approval).
- Never invent facts, mutual connections, prior conversations, or customer logos.
- No false urgency ("only 2 left", fake deadlines) and no pressure tactics.
- Never contact someone marked do-not-contact; never buy or scrape contact lists.
- Store only the personal data needed to follow up; no notes on personal traits.
- Prices, discounts and terms come from the company's approved price list or a human.

## Done when

- [ ] Every lead has a stage, next step and due date — or a closed reason
- [ ] Qualification is recorded with yes/no/unknown, not guesses
- [ ] Drafts reference only real facts and include an easy way to decline
- [ ] Do-not-contact and consent are respected
- [ ] Drafts and pipeline summary are posted for approval
