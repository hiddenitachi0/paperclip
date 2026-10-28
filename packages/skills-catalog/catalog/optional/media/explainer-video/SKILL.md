---
name: explainer-video
description: Make a short infographic, chart, title or explainer video drawn entirely by code (HTML, CSS and SVG) with Paperclip's render worker — brief, scenes, check, contact sheet, render, deliver. Use when a task asks for a video of numbers, a chart that moves, an animated title card or a step-by-step explainer. Never use an image or video model to draw figures.
key: paperclipai/optional/media/explainer-video
recommendedForRoles:
  - content
  - marketing
  - designer
  - analyst
tags:
  - video
  - infographic
  - explainer
  - chart
  - media
---

# Explainer Video (code-drawn)

Turn facts into a short video where every frame is drawn by code: charts from real numbers, titles, labels, step-by-step explainers. Code-drawn frames are exact (a 42 is a 42), cost no AI money, and render the same way every time. Paperclip renders them on its own server with Hyperframes in a locked-down container.

Use the `paperclip` skill for API mechanics (auth header, run id header, task comments, attachments).

## When to use

- A task asks for a chart, a number, a ranking or a timeline as video.
- A task asks for an animated title, lower third, end card or "how it works" explainer.
- A longer film needs code-drawn segments (intro title, a chart between shots, credits).

## When not to use

- People, products, places or anything photographic: use `paperclipai/optional/media/media-studio-generation`.
- A launch video built from a project's code or website: use `paperclipai/optional/content/brag-video` (only when a person asked).

## The rhythm (do not skip steps)

1. **Brief.** One short paragraph on the task: who watches, the one thing they should remember, length, format. Get the numbers from Paperclip data (the task, a report, a document), never invent them. Write down where each number came from.
2. **Scenes.** Plan 3–6 scenes of 3–8 seconds. One idea per scene. Big text (at least 48 px at 1080p), at most about 12 words on screen at once.
3. **Write the composition** (rules below): one `index.html`, plus CSS/JS/SVG files if you want them.
4. **Check** (`kind: "check"`). Fix every error and re-check until `passed` is `true`. Read the warnings; fix the ones that are about readability (contrast, text running off the frame).
5. **Contact sheet** (`kind: "snapshot"`). Look at the picture. If a frame looks wrong, fix and go back to 4.
6. **Render** (`kind: "render"`), with `durationSeconds` equal to the composition's length.
7. **Deliver.** Comment on the task with the video (it is attached to the task when you pass `issueId`) and one line per number saying where it came from.

## Composition rules

- Size by format: landscape 1920×1080, vertical 1080×1920, square 1080×1080. Set the same size on `html, body` and the root element.
- The root element carries the timing:
  `<div id="root" data-composition-id="main" data-start="0" data-duration="20" data-width="1920" data-height="1080" data-no-timeline>`
- Each timed part is a child with `id`, `class="clip"`, `data-start`, `data-duration` and `data-track-index`.
- Animate with **CSS animations** (`@keyframes`, `animation-delay` for timing) or the Web Animations API. Keep `data-no-timeline` on the root when you do; without it every render waits 45 seconds.
- **Nothing from the internet.** No CDN scripts, no web fonts, no remote pictures. The renderer has no network and refuses a composition that names an `http(s)://` address. GSAP from jsDelivr only works if the operator built the renderer with GSAP; do not rely on it.
- **Fonts on the renderer:** Inter, Liberation Sans/Serif/Mono, DejaVu, Noto (with emoji). Use `font-family: Inter, sans-serif`.
- **Pictures, logos, music:** send them with the job as `assets`, using their id in the company's Files (Media Studio results are there). Refer to them by the path you give them, e.g. `<img src="assets/logo.png">`. Only pictures, video, sound and fonts can be sent.
- **Draw data as SVG or HTML from the numbers.** Compute bar heights and positions in your composition from a small data array; label every bar with its value.
- **Deterministic only:** no `Date.now()`, no `Math.random()`, no `fetch`. The same composition must render the same video twice.
- Good contrast (light text on dark or the reverse) and a 5% safe margin at every edge.

## API

All under `/api/companies/{companyId}/code-renders`. Send your run id header like every mutating call.

| Call | Purpose |
|---|---|
| `POST /` | Submit a job: `{ kind: "check" \| "snapshot" \| "render", title, files: [{ path, content } or { path, contentBase64 }], assets?: [{ fileId, path }], entry?, durationSeconds (render), fps?, quality? ("draft" \| "standard" \| "high"), frames? (snapshot), issueId? }`. Text goes in `content`; a small binary file (a sound effect, an icon) may go inline as `contentBase64`; the whole request must stay under 10 MB. Answers `202` with the job. |
| `GET /{jobId}` | The job: `status` (`queued`, `running`, `saving`, `done`, `failed`, `cancelled`), `progressPct`, `passed` and `report` (check), `resultFileId` (snapshot/render), `error`. Poll every 10–20 seconds. |
| `GET /` | Recent jobs of the company. |
| `GET /usage` | The limits and today's use. |
| `POST /{jobId}/cancel` | Stop a waiting or running job. |

A finished file is in the company's Files (`resultFileId`), or attached to the task when you passed `issueId`. Download it with `GET /api/attachments/{resultFileId}/content`.

Example (check):

```json
{
  "kind": "check",
  "title": "Q3 orders infographic",
  "files": [{ "path": "index.html", "content": "<!doctype html>..." }],
  "issueId": "<task id>"
}
```

## Limits: stop and ask

Rendering uses the server's own computer, so there are limits on video minutes, not on money:

- one render may be at most 10 minutes long (unless the operator changed it);
- `durationSeconds` must match the composition: a render whose `data-start`/`data-duration` run longer than it asks for is refused (`duration_mismatch`), and a video that comes out longer is not saved;
- each agent may use a set number of minutes per day, and the company a set number in total. A finished video counts its length, or the time the renderer spent on it if that was longer (a slow video uses up more); a check, a contact sheet and a failed or cancelled job count the time the renderer spent on it, so a failing job still uses up minutes;
- only two jobs per company may wait or run at once.

When a call answers `429` or `422` with a limit reason (`too_long`, `duration_mismatch`, `too_many_at_once`, `agent_daily_cap`, `company_daily_cap`, `budget_paused`, `budget_hard_stop`), **stop**. Do not retry in a loop and do not split the work to get around the limit. Wait for a running job to finish (`too_many_at_once`), or tell the person on the task in one plain sentence what limit was reached and ask how to go on. If the answer is `503`, the renderer is not set up on this server: say so on the task and stop.

## Done means

- `check` passed with no errors, you looked at the contact sheet, and the render is `done`.
- The video is on the task, with where each number came from.
- No number in the video that is not in Paperclip data.
