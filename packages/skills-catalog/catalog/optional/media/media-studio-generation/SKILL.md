---
name: media-studio-generation
description: Make pictures, short videos, music and multi-shot video storylines with Paperclip's Media Studio — brief, prompt, generate, review, deliver — while keeping cost, consent and brand rules. Use when a task asks for an image, a product shot, a social visual, a short clip, a voice-over or a storyboarded video.
key: paperclipai/optional/media/media-studio-generation
recommendedForRoles:
  - designer
  - marketing
  - content
  - social-media
tags:
  - media
  - image-generation
  - video
  - storyline
  - creative
---

# Media Studio Generation

Turn a request into finished pictures or video that the person can use, at the lowest cost that does the job, attached to the task that asked for it. Every generation costs real money and some cannot be undone once published, so this skill is as much about restraint and review as about prompting.

Use the `paperclip` skill for API mechanics (auth headers, run id header, posting task comments, attaching files). This skill covers what to call and in what order.

## When to use

- A task asks for a picture: product shot, social post visual, banner, illustration, mood picture.
- A task asks for a short video clip (one shot) or a voice-over / music bed.
- A task asks for a longer video with several scenes — use a **video storyline** (storyboard first, paid render last).

## When not to use

- A launch video built from a project's code or website: use `paperclipai/optional/content/brag-video`.
- A UI mock-up or wireframe: use a design/wireframe skill; generated pictures are not specs.
- Charts or numbers: build the chart from data; never let an image model draw figures. For a chart, title or explainer as video, use `paperclipai/optional/media/explainer-video` (drawn by code).

## What you can call

Media Studio is a plugin. When it is enabled for the company, its tools appear in your run's tool list. If they do not appear, the company has not turned Media Studio on — say so on the task and stop; do not look for a workaround.

| Tool (plugin `paperclip.media-studio`) | Use for | Key inputs |
|---|---|---|
| `list-looks` | See the company's saved looks (style, model, reference pictures) | — |
| `generate-image` | A real picture someone will use | `prompt` (required), `issueId`, `look`, `seed`, `referenceFileIds` (max 4), `imageSize`, `provider`, `model` |
| `quick-picture` | A small mood picture to go with your own message — never a deliverable | `prompt`, `imageSize`, `look`, `issueId` |
| `generate-video` | One short clip (text-to-video or from a picture) | `prompt`, `issueId`, `startImageFileId` (picture to start from), `aspectRatio`, `durationSeconds`, `provider`, `model`, `seed` |
| `generate-audio` | Music bed (`mode: "music"`) or speech (`mode: "speech"`) | `prompt`, `mode`, `voice`, `durationSeconds`, `issueId` |
| `check-media-job` | Follow a video/audio job that is still running | `jobId` |

If your runtime cannot call plugin tools directly, the same tools run through `POST /api/plugins/tools/execute` with body `{ "tool": "paperclip.media-studio:generate-image", "parameters": {...}, "runContext": { "agentId", "runId", "companyId", "projectId" } }`.

Video storylines (multi-shot videos) are plain API routes, all under `/api/companies/{companyId}/video-storylines`:

| Method + path | Purpose |
|---|---|
| `GET /script-instructions` | The script format and an example — read this before writing a script |
| `POST /import` `{ script, title?, budgetCapCents?, dryRun }` | Create a storyline with all scenes and shots from one script. Run with `dryRun: true` first to get counts and estimated cost |
| `POST /` `{ title, projectId?, budgetCapCents?, aspect? }` | Create an empty storyline (then add scenes/shots by hand) |
| `POST /{id}/scenes` `{ title?, notes?, orderIndex }` | Add a scene |
| `POST /{id}/shots` `{ sceneId, orderIndex, prompt, cameraNotes?, durationSeconds?, lookReferenceAssetIds? }` | Add a shot |
| `GET /{id}/storyboard` | Shots with their storyboard picture and approval state |
| `POST /{id}/shots/{shotId}/still` `{}` | Make the cheap storyboard picture for one shot |
| `POST /{id}/estimate` | Cost of the full render |
| `POST /{id}/render/start` `{ confirmBudgetCapCents? }` | Paid render of every approved shot |
| `GET /{id}/progress` | Render status per shot |
| `GET /{id}/final/content` | The finished video file |

Storylines must be turned on for the company (an owner/admin setting). A 403/404 on these routes means "not enabled" — report it, do not retry.

## Procedure

1. **Read the brief.** From the task, write down: what it is for (channel, size, audience), what must be in it, what must not be in it, deadline, and any named look or brand rules. If the purpose or the subject is unclear, ask on the task before generating anything.
2. **Check looks.** Call `list-looks`. If the company has a look that fits (brand style, product sheet), use it rather than describing the style yourself.
3. **Write the prompt.** One subject, setting, light, composition, style, shape. Concrete nouns beat adjectives. Name the shape (`imageSize`/`aspectRatio`) from the channel (square for feeds, 9:16 for stories/reels, 16:9 for web/video).
4. **Generate small first.** One or two pictures, not ten. For variations, reuse the `seed` the first result reported and change one thing. For product/person consistency pass up to 4 `referenceFileIds`.
5. **Review honestly.** Look at the result against the brief: wrong hands/text/logos, off-brand colours, anything that could embarrass the company. Regenerate at most twice; after that, report what is not working instead of burning money.
6. **For a storyline:** read `script-instructions`, write the script, `import` with `dryRun: true`, post the counts and estimated cost on the task, then import for real. Make storyboard stills, and ask a human to approve shots (approval before the paid render is the point of the storyboard). Only call `render/start` after shots are approved and the cost is accepted.
7. **Deliver.** Pass `issueId` so the result lands on the task, then comment with: what you made, the look/seed used (so it can be reproduced), the cost if shown, and what you would change next.

## Cost rules

- Check the estimate before any video or storyline render, and before more than 4 pictures in one go.
- Ask on the task before spending on a video render, a storyline render, or anything the task did not explicitly ask for. Pictures for an explicit picture request do not need a second ask.
- Use `quick-picture` only for decoration of your own messages; it still counts toward the daily limit.
- If a daily picture limit or budget stop is hit, stop and report — never switch provider to get around a limit.
- Never pick a `model` or `provider` the person did not name; the company's Media Studio settings decide.

## Consent, likeness and brand rules

- No real, identifiable people (customers, staff, public figures) unless the task gives their picture as a reference **and** says they agreed. Never make someone appear to say or do something they did not.
- No copyrighted characters, other companies' logos or trademarks, or "in the style of" a living artist.
- Product shots must not invent features the product does not have; mark a picture as "illustrative" when it is not the real product.
- No generated text inside images for anything that must be read accurately (prices, legal text) — add text afterwards in a design tool.
- Follow any brand guide linked from the task or the company's looks.

## Output template (task comment)

```
Made: <n> picture(s) / <length>s video — attached above.
For: <channel / purpose>, shape <size>.
How: look "<name or none>", seed <seed>, references <file ids or none>.
Cost: <estimate or "shown in Media Studio history">.
Check before use: <anything a human must confirm, e.g. product colour>.
Next option: <one concrete variation you'd try>.
```

## Hard rules

- Never publish or post generated media anywhere outside Paperclip yourself; delivery is to the task.
- Never start a paid video/storyline render without a human OK on the task when the task did not ask for that exact render.
- Never approve your own storyboard shots unless the task explicitly delegates that approval to you.
- Never paste provider keys or ask for them; keys live in company secrets.

## Done when

- [ ] The brief (purpose, shape, must/must-not) is written on the task
- [ ] Results are attached to the task, not just to Files
- [ ] Look, seed and references are recorded so the result can be reproduced
- [ ] Cost was checked before any video/storyline render
- [ ] Consent/brand rules were checked and anything doubtful is flagged for a human
