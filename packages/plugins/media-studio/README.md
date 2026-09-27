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

### Looks with a Sogni model and LoRAs

Under **Company settings → Media Studio looks**, an owner or admin can make a look for one specific Sogni model:

- **Picture service: Sogni** opens a searchable list of Sogni's picture models, read live from Sogni's public
  catalog (`GET https://api.sogni.ai/v1/model-catalog?mediaType=image&include=parameters`, no key, kept for 10
  minutes). Each model shows how many of Sogni's workers are online for it, whether it has LoRAs, and its tags; the
  chosen model shows its picture size, steps and guidance ranges. Mac and smaller builds of a model are hidden unless
  asked for. For example "Dark Beast Z-Image Turbo v9" is `dark_beast_z_image_turbo_v9_bf16`.
- **LoRAs**: the LoRAs Sogni has for the chosen model (`GET /v1/loras/comfy`, public), plus the account's own
  imported LoRAs when the Sogni account has an Unlimited plan (`GET /v1/loras/personal/catalog` with the key). Add up
  to 8; they are used in the listed order. Each has a strength slider bounded by that LoRA's own range, starting at its
  default, with the maker's recommended range and a link to the LoRA's page. **Sogni does not add a LoRA's trigger
  words**: if the LoRA's page names one, put it in the look's style words. Not every model has LoRAs (in September
  2026 only the Krea 2 family had public ones; Dark Beast Z-Image Turbo v9 had none).
- **Model settings** the model allows: guidance (only where the model lets it change), "things to keep out of the
  picture" (only models that use it), and the picture size (inside the model's width and height range). Steps cannot
  be set: Sogni's workflow step has no steps setting.
- **Sensitive content filter**: on by default. Some models, for example the Dark Beast models, only work with it off,
  and the page says so when such a model is picked. Pictures made with the filter off can be explicit. Only an owner
  or admin can save a look with it off (the look records who did), agents cannot turn it off in any way, and Sogni
  also checks that the account may make such pictures (a subscription, Premium Spark, or paying with SOGNI).

Everything in a look is checked again in the worker when it is saved and before every picture: the model must be in
Sogni's catalog, each LoRA must work with that model at a strength inside its range, at most 8, and a LoRA Sogni marks
as needing the filter off needs a look with the filter off. A problem is reported in a plain sentence before the
agent's daily picture limit is touched. When Sogni's catalog cannot be reached, a look keeps working with the model and
LoRAs it was saved with, but new models cannot be picked.

Agents: an agent can ask for any model in Sogni's catalog by id (`model`), but LoRAs, model settings and the filter
only come from a saved look. The **List saved looks** tool says each look's model name, LoRAs with strengths, and
whether its filter is off. A look's LoRAs and settings are left out (and the agent is told) when the agent asks for a
different model, or when reference pictures are used with a model that cannot edit pictures (then Sogni's
picture-editing model `qwen-lightning` makes the picture). Pick an editing model, for example Krea 2 Identity Edit,
to use LoRAs with reference pictures.

On the wire: a known model is sent by its tool key (`dark-beast-z-turbo`) and any other catalog model by its id; LoRAs
go in the step's `loras` and `loraStrengths` arguments (paired lists, on `generate_image` and `edit_image`), guidance
and things-to-avoid in `guidance` and `negativePrompt` (`generate_image` only), and the filter is the workflow's
`safe_content_filter` (always sent: `true` unless the look turned it off).

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
