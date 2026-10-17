---
name: hiring-pipeline
description: Support hiring for human roles — write the job description, structured interview questions with a scoring rubric, fair candidate summaries, and scheduling hand-offs — while protecting candidates' privacy and leaving every decision to a human. Use when a task asks to open a role, screen applications, prepare interviews, or summarise candidates.
key: paperclipai/optional/people/hiring-pipeline
recommendedForRoles:
  - hr
  - recruiter
  - people-ops
  - manager
tags:
  - hiring
  - recruiting
  - interviews
  - hr
  - fairness
---

# Hiring Pipeline

Help a company hire people fairly and quickly: clear job descriptions, the same structured questions for every candidate, evidence-based summaries, and tidy scheduling. You organise and summarise; humans decide who moves forward and who is hired.

This skill is about hiring **people**. To create new AI agents in Paperclip use `paperclip-create-agent` instead. Use the `paperclip` skill for task mechanics, `paperclipai/optional/operations/calendar-scheduling` for booking interviews, and `paperclipai/optional/communication/email-triage` for the applications inbox.

## When to use

- Opening a new role: job description and where to post it.
- Screening applications against the role's requirements.
- Preparing interview questions and a scoring sheet.
- Summarising interview notes for the hiring manager.

## When not to use

- Making or communicating a hiring or rejection decision on your own.
- Background checks, references or salary negotiation — prepare questions only; a human does these.
- Assessing anything about a candidate that is not job-related.

## Procedure

1. **Define the role** with the hiring manager's input from the task: purpose, 4–6 outcomes for the first year, must-have skills (few), nice-to-haves, location/remote, salary range if the company publishes one.
2. **Write the job description**: plain language, outcomes before requirements, no jargon or "rockstar/ninja", gender-neutral wording, only requirements that are truly needed (each extra one shrinks the pool). Include how to apply and what the process looks like.
3. **Build the scorecard**: 4–6 competencies from the must-haves, each with a 1–4 scale and what a 1 and a 4 look like.
4. **Write structured questions**: for each competency, one past-behaviour question ("Tell me about a time…") and one situational question, with follow-up prompts. Every candidate gets the same core questions.
5. **Screen applications** against must-haves only. For each: meets / partly / does not meet, with the line from their application as evidence. Do not rank by school, employer brand, gaps in employment or anything not tied to the must-haves.
6. **Hand off scheduling**: list who to invite, panel, length, and time windows; use the calendar-scheduling skill to propose slots. Never confirm on a human's behalf without approval.
7. **Summarise interviews** from the interviewers' notes: score per competency with quoted evidence, open questions, and any disagreement between interviewers. No overall "hire / no hire" from you — the manager decides.

## Fairness and privacy rules

- Never use, infer or record protected characteristics: age, gender, ethnicity, religion, disability, health, pregnancy, family status, sexual orientation, nationality (except legal right-to-work if the task asks), or photos.
- Remove such details from summaries if a candidate volunteered them.
- Same questions, same scale, same evidence standard for everyone.
- Keep only what is needed: name, contact, application documents, notes and scores. Do not search candidates' private social media.
- State retention: candidate data is deleted or anonymised after the company's retention period (ask if unknown); never reuse it for other roles without consent.

## Output templates

Candidate summary:
```
Candidate: <name>    Role: <role>    Stage: <screen|interview n>
Must-haves: <skill> — meets/partly/no — evidence: "<quote>" (source)
Scores: <competency> <1-4> — evidence: "<quote>" (interviewer)
Open questions for next round: <...>
Interviewer disagreement: <...>
Decision: for the hiring manager
```

Pipeline status:
```
Role <role>: <n> applied, <n> screened (meets <n> / partly <n> / no <n>), <n> interviews booked, <n> awaiting decision
Waiting on a human: <who, what, since when>
```

## Hard rules

- A human makes every advance/reject/offer decision and sends every decision message.
- No protected characteristics in any note, score or summary.
- Never invent experience, scores or references; quote the source.
- Never share candidate data outside the hiring task and its named people.

## Done when

- [ ] Job description is outcome-led, plain and neutral
- [ ] Scorecard and structured questions exist before the first interview
- [ ] Every screen and score has quoted evidence
- [ ] No protected characteristics appear anywhere
- [ ] Scheduling is handed off and every decision is left to a human
