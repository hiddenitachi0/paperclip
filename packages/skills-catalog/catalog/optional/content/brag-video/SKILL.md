---
name: brag-video
description: Get a short launch video ("brag video") made for a project through Paperclip's Brag pipeline — pick the source, estimate the cost, plan scenes, get every scene approved, render, and deliver with share copy. Use when a task asks for a launch video, a "show what we built" clip, or a 10–60 second product teaser from a project's code or website.
key: paperclipai/optional/content/brag-video
recommendedForRoles:
  - content
  - marketing
  - devrel
  - product
tags:
  - video
  - launch
  - brag
  - marketing
  - approval
---

# Brag Video

Produce a short, honest launch video for a project and hand it over for approval. Paperclip has a built-in Brag pipeline (plan → one picture per scene → human approval → render → MP4 + poster saved to Files). This skill tells you how to drive it, what you may do yourself, and when to hand off to the full `/brag` skill instead.

Use the `paperclip` skill for API mechanics (auth, task comments, attachments).

## When to use

- A task asks for a launch / release / "look what we shipped" video for a project.
- A 8–60 second teaser built from a project's own code or its public https website.
- Re-doing a brag video after a scene was rejected.

## When not to use

- Freeform marketing videos with people, stories or several locations: use `paperclipai/optional/media/media-studio-generation` (video storylines).
- A written announcement only: use `paperclipai/optional/content/release-announcement`.
- The project has nothing user-visible yet. A brag video of an empty app hurts more than it helps — say so.

## Two ways to make it

| Path | What it is | Who runs it |
|---|---|---|
| **Brag pipeline** (default) | Server pipeline, metered cheaply (planning call per scene; capture and stitching are local and free), budget-checked, scene-by-scene approval built in | A **board user** (the routes refuse agent keys). You prepare everything and ask the board to press the buttons, or the board runs it from the project's Brag screen |
| **Full `/brag` skill** (`paperclipai/optional/content/brag`) | Richer motion design built on the agent's own machine with local tools | You, when the task explicitly asks for a polished/custom video and you hold that skill. Its slim path (`slim.md`) is the one Paperclip supports |

Prefer the pipeline. Hand off to `/brag` only when the task asks for something the pipeline cannot do (custom motion, specific shots) — and note on the task that it takes longer and runs on the agent's machine.

## Pipeline routes (board-only, for reference and for your instructions to the board)

All under `/api/companies/{companyId}`:

| Method + path | Purpose |
|---|---|
| `POST /brag/estimate` `{ lengthSeconds (8–60, default 20), music }` | Scene count and estimated cost in cents |
| `POST /brag/jobs` `{ projectId, issueId?, sourceUrl? (https only), tone?, format?, lengthSeconds?, music?, note? }` | Create a draft video. No `sourceUrl` = read the project's own code workspace |
| `GET /projects/{projectId}/brag/jobs` | List this project's brag videos |
| `GET /brag/jobs/{jobId}` | The job plus its scenes |
| `POST /brag/jobs/{jobId}/plan` | Gather material, write one scene per ~4 seconds (max 15), capture a still each; status becomes `awaiting_approval` |
| `PATCH /brag/jobs/{jobId}/scenes/{sceneId}` `{ action: "approve" \| "edit" \| "leave_out", description? }` | Approve, rewrite (needs `description`, re-captures the still) or drop a scene |
| `GET /brag/jobs/{jobId}/scenes/{sceneId}/still/content` | The scene's picture |
| `POST /brag/jobs/{jobId}/render` | Refused until every kept scene is approved; renders, stitches, saves `brag.mp4` + poster (attached to `issueId` if given) |
| `POST /brag/jobs/{jobId}/cancel` | Cancel a job that is not finished |

Values: `tone` is one of `hype`, `calm`, `playful`, `serious`, `technical`; `format` is `landscape` (default), `vertical` or `square`. Status runs `draft → planning → awaiting_approval → rendering → completed` (or `failed` / `cancelled`). A render stops itself if spend passes twice the estimate. Budget policies on the company and project are checked before planning and before rendering.

## Procedure

1. **Pin the facts.** From the task and the project: what shipped, who it is for, the one thing a viewer should remember, where it will be shared (decides `format`: vertical for stories/reels, square for feeds, landscape for web/YouTube) and length (20 s is a good default).
2. **Pick the source.** The project's code workspace (default) or its public https site. Never point at a staging URL with test data or a page behind a login.
3. **Check for secrets and private data.** Scene text is masked for secrets automatically, but you still check: no customer names, internal URLs, prices that are not public, or unreleased features the task did not clear.
4. **Prepare the brief on the task** using the template below, including the estimate (`POST /brag/estimate` — or the numbers: about 10¢ + 2¢ per scene, plus Media Studio's audio price if music is on).
5. **Ask the board to create and plan the job** (or create it yourself if your caller is a board session). Include the exact body for `POST /brag/jobs`.
6. **Review the scenes** once planned: for each scene say approve / edit (with new wording, ≤500 chars) / leave out, and why. Wording must be true and specific — "Exports to CSV in one click", not "Revolutionary data experience".
7. **Render only after every kept scene is approved by a human.** Then deliver: video + poster on the task, plus share copy for each channel (one line, no hashtag spam), and a note of the final cost.

## Music policy

No music ships with Paperclip and you must never download or copy music. Music is either off (the default), a track generated in Media Studio for this job, or a track a person provides with a stated licence. If the task wants music and none of those applies, deliver without music and say so.

## Brief template (task comment)

```
Brag video — proposal
Project: <name>    Source: <code workspace | https://...>
Audience / channel: <who, where>    Format: <landscape|vertical|square>, <n> s, tone <tone>
Key message: <one sentence>
Proposed scenes:
  1. <what it shows, true claim>
  2. ...
Music: <off | Media Studio track | licensed track: name + licence>
Estimate: <cents> (planning <x>, music <y>)
Board action needed: create + plan with body { ... }, then approve scenes
```

## Hard rules

- Never claim features, numbers or customers the project does not have.
- Never render or share before every kept scene has a human approval.
- Never post the video outside Paperclip yourself; delivery is to the task.
- Never use bundled, downloaded or "found" music.
- If planning fails with "found nothing screen-worthy", fix the source (better page, README) instead of retrying blindly.

## Done when

- [ ] Brief with audience, format, length, key message and estimate is on the task
- [ ] Every kept scene was approved by a human before render
- [ ] Video and poster are attached to the task, with share copy per channel
- [ ] Music source and licence (or "no music") are stated
- [ ] Final cost is reported
