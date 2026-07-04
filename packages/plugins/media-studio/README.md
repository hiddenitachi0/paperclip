# @paperclipai/plugin-media-studio

Generate an image, preview it, and **require a board approval before it can be posted** —
the roadmap-3 approval gate for the paperclip-fork.

- **Agent tool** `paperclip.media-studio:generate-image` — an employee can generate a preview
  as part of its work.
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
