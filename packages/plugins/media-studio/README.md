# @paperclipai/plugin-media-studio

Generate an image, preview it, and **require a board approval before it can be posted** —
the roadmap-3 approval gate for the paperclip-fork.

- **Agent tool** `paperclip.media-studio:generate-image` — an employee can generate a preview
  as part of its work. With `issueId` the picture is attached to that task (same rules as
  before); without it, it is saved as a company file with no task (Files page, "No task"
  group), authored by the calling agent. A quick agent's chat (web and Telegram) shows the
  picture. The agent's daily picture limit applies either way.
- **Consistency** — `seed` (reused for close variations; the seed actually used is always
  reported and stored with the file), `referenceFileIds` (up to 4 pictures from the same
  company's Files, sent to Fal's FLUX Kontext model as data URIs so no Paperclip address
  leaves the box), and `look` (a saved look: style words, model, fixed seed, reference
  pictures).
- **Agent tool** `paperclip.media-studio:list-looks` — read-only list of the company's looks.
- **Company settings → Media Studio looks** — owners/admins add, edit and delete looks; looks
  are stored per company in plugin state (scope `company`).
- **Issue "Media Studio" tab** — a human generates, submits for approval, and then
  approves / requests changes / regenerates / posts. Only an **approved** image can be posted.

Generation runs behind a `GenerationProvider` interface, selected in the plugin's settings:

| provider | needs | notes |
|---|---|---|
| `mock` (default) | nothing | keyless SVG placeholder — for testing the whole flow |
| `fal` | a Fal.ai key (as a Paperclip **secret ref** set in settings) | `POST https://fal.run/{model}` |
| `comfyui` | a `comfyUrl` (over Tailscale) | self-hosted, swappable GPU endpoint |

The approval it files is a normal `request_board_approval`, so it also shows up in the
**Now view → Needs you** lane.

## How it fits together (zero core edits)

The plugin uses only existing Paperclip REST routes from its UI (running under the user
session): `POST /issues/:id/work-products`, `POST /companies/:id/approvals` (with `issueIds`
to link), `POST /approvals/:id/approve|request-revision`, `PATCH /work-products/:id`, and
`POST /issues/:id/comments`. Nothing in `packages/`, `server/`, `ui/`, or `cli/` core is
modified.

> Fully-autonomous filing (the agent itself creating the work-product + approval, not just
> generating) would need a small additive plugin-SDK RPC surface for work-products/approvals.
> That is intentionally deferred to keep core edits at zero; see FORK.md.

## Build & install (dev)

```bash
pnpm --filter @paperclipai/plugin-media-studio build
paperclipai plugin install ./packages/plugins/media-studio     # absolute path also works
paperclipai plugin list
```

Then open any task → **Media Studio** tab. Switch the provider to `fal` and set the Fal.ai
key secret ref in the plugin settings when you're ready to generate for real.
