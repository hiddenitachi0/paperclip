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
  company's Files, sent to Fal's FLUX Kontext model as data URIs, or uploaded to Sogni's
  storage, so no Paperclip address leaves the box), and `look` (a saved look: style words,
  picture service, model, fixed seed, reference pictures).
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
| `sogni` | a Sogni key (as a Paperclip **secret ref** set in settings) | durable workflow at `https://api.sogni.ai` — see below |
| `comfyui` | a `comfyUrl` (over Tailscale) | self-hosted, swappable GPU endpoint |

## Using Sogni

1. Create an API key at [dashboard.sogni.ai/api-key](https://dashboard.sogni.ai/api-key) and save it in the
   company's **Secrets**.
2. In Media Studio's settings pick **sogni** as the picture service (or keep Fal.ai and use Sogni only when asked),
   pick the key under **Sogni API key**, and leave **Sogni model** at `z-turbo` (fast, good everyday pictures) unless
   you want another. **Sogni payment** `auto` spends Spark first, then SOGNI; an Unlimited plan is used first anyway.
3. Agents can ask for either service per picture (`provider: "fal"` or `"sogni"`), a looks page entry can be set to
   Fal.ai or Sogni, and a model name picks its own service (`fal-ai/...` is Fal, `z-turbo`, `krea-2-turbo`,
   `qwen-2512-lightning`, ... are Sogni).

How it works: the picture is one `generate_image` step of a Sogni creative workflow (with the seed, so every picture's
seed is known and reusable), polled every 2 seconds; after 120 seconds it is cancelled on Sogni. The finished picture is
downloaded from Sogni's storage (only `https://<bucket>.s3-accelerate.amazonaws.com` addresses are fetched) and saved
exactly like a Fal picture. Reference pictures are uploaded to Sogni's own storage and used with Sogni's
picture-editing model (`qwen-lightning`, up to 3 pictures); Sogni takes no seed for those, and says so. Sizes use Fal's
names (`landscape_4_3` by default) or `1280x720`-style sizes.

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
