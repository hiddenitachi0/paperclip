import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { sogniToolDeclarations } from "./sogni-tools.js";

export const PLUGIN_ID = "paperclip.media-studio";
const PLUGIN_VERSION = "0.1.0";

export const TOOL_GENERATE = "generate-image";
export const TOOL_LIST_LOOKS = "list-looks";
export const TOOL_QUICK_PICTURE = "quick-picture";
export const ACTION_GENERATE = "generate";
export const ACTION_LOOKS_LIST = "looks.list";
export const ACTION_LOOKS_SAVE = "looks.save";
export const ACTION_LOOKS_DELETE = "looks.delete";
/** The company's agents and each one's default look, for the looks page. */
export const ACTION_LOOK_DEFAULTS_LIST = "looks.defaults.list";
/** Set (or clear) one agent's default look. Owner/admin only. */
export const ACTION_LOOK_DEFAULTS_SET = "looks.defaults.set";
/** Automatic looks (look rules): the people and jobs, their rules and default looks. */
export const ACTION_LOOK_RULES_LIST = "lookRules.list";
/** Save one person's (or job's) whole rule list. Owner/admin only. */
export const ACTION_LOOK_RULES_SAVE = "lookRules.save";
/** The exact prompt a look would send for a sample request (the looks page's "Preview prompt"). */
export const ACTION_LOOK_PROMPT_PREVIEW = "looks.previewPrompt";
/** "Right now this would pick: ..." with a test message. */
export const ACTION_LOOK_RULES_PREVIEW = "lookRules.preview";
/** Sogni's live list of picture models, for the looks page's model picker. */
export const ACTION_SOGNI_MODELS = "sogni.models";
/** The LoRAs that work with one Sogni model, for the looks page. */
export const ACTION_SOGNI_LORAS = "sogni.loras";
/** Which AI edit services (Sogni/Fal) are configured, for the Edit tab. */
export const ACTION_EDIT_CAPABILITIES = "edit.capabilities";
/** Run one Sogni picture tool on a picture the person is editing (no daily cap: not an agent call). */
export const ACTION_EDIT_SOGNI = "edit.sogni";
/** Run a Fal.ai prompt edit ("make variations" / "edit with a prompt") on a picture the person is editing. */
export const ACTION_EDIT_FAL = "edit.fal";
export const ISSUE_TAB_SLOT = "media-studio-issue-tab";
export const ISSUE_TAB_EXPORT = "MediaStudioIssueTab";
export const LOOKS_PAGE_EXPORT = "MediaStudioLooksPage";
/** Old route (Company settings -> Media Studio looks); kept only as a redirect target. */
export const LOOKS_PAGE_ROUTE = "media-studio-looks";
export const SIDEBAR_LINK_EXPORT = "SidebarLink";
export const MAIN_PAGE_SLOT = "media-studio-page";
export const MAIN_PAGE_EXPORT = "MediaStudioPage";
export const MAIN_PAGE_ROUTE = "media-studio";
/** At most this many reference pictures per image (Fal's Kontext models take a handful; Sogni's edit models 2-16). */
export const MAX_REFERENCE_FILES = 4;

/**
 * The generate-image tool's input. One copy, used by the manifest and by the
 * worker's registration, so the two cannot drift apart.
 */
export const GENERATE_IMAGE_DESCRIPTION =
  "Make a picture from a text description. Without a task it is saved to the company's Files (not tied to any task) and shown in the chat; with issueId it is attached to that task instead. " +
  "When the person names a saved look (\"in our catalogue look\"), pass it as look. " +
  "When no look is named, an automatic look is used if one fits (an owner or admin can set looks by time of day and by keywords in the person's message), else your default look (if you have one); a look named in the request wins over both. The result says which look was used and why. " +
  "To make a close variation of an earlier picture (\"same as the last one but with a blue sofa\"), pass the seed that earlier picture reported. " +
  "To keep the same person, product or style as existing pictures, pass their file ids as referenceFileIds (up to 4). " +
  "Pictures are made by the picture service chosen in Media Studio settings; pass provider (\"fal\" or \"sogni\") only when the person asks for a specific one. " +
  "If the agent has a daily picture limit, this stops working once the limit is reached for the day (it resets at midnight UTC). " +
  "Use this for a real picture the person asked for; for a small mood picture to go along with your own message, use quick-picture instead.";

export const GENERATE_IMAGE_PARAMETERS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What the picture should show." },
    issueId: {
      type: "string",
      description:
        "Optional. The task to attach the picture to; only use a task the person named or that is assigned to you. Leave it out to save the picture to the company's Files without a task.",
    },
    look: {
      type: "string",
      description:
        "Optional. The name of a saved look to use (its style, model, LoRAs, seed and reference pictures). Use list-looks to see the names. Leave it out to use an automatic look or your default look, if you have one.",
    },
    seed: {
      type: "integer",
      minimum: 0,
      maximum: 4294967295,
      description: "Optional. Reuse the seed an earlier picture reported to get a close variation of it.",
    },
    referenceFileIds: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REFERENCE_FILES,
      description: "Optional. Up to 4 file ids of pictures in this company's Files to keep the same person, product or style.",
    },
    imageSize: {
      type: "string",
      description:
        "Optional picture shape: square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3 (the usual) or landscape_16_9. With Sogni a size like 1280x720 also works.",
    },
    model: {
      type: "string",
      description:
        "Optional. A specific model, only when the person names one. Fal models look like fal-ai/flux/schnell; Sogni models look like z-turbo or dark_beast_z_image_turbo_v9_bf16 (any model in Sogni's model list). A model picks its own service. Better: use a saved look, which can also carry the model's LoRAs.",
    },
    provider: {
      type: "string",
      enum: ["fal", "sogni"],
      description: "Optional. Which picture service to use for this one picture: fal (Fal.ai) or sogni (Sogni). Leave it out to use the one in Media Studio settings.",
    },
  },
  required: ["prompt"],
} as const;

/** The quick-picture tool: a small, fast, cheap picture to go along with a message. */
export const QUICK_PICTURE_DESCRIPTION =
  "Make a quick, small picture (about 512 pixels, few details, made in a few seconds) to go along with your message: a mood picture that sets the scene, not a finished picture. " +
  "Use it when a picture would simply make your reply nicer (\"good morning\" with a sunrise, a cosy autumn feeling). " +
  "When the person asks for a real picture (a product shot, a picture of a person or a specific look, anything they will use), use generate-image instead. " +
  "It uses the fastest model of the picture service, with no reference pictures and no LoRAs. A saved look is only used when you name it as look (its style words, character sheet and content filter; not its model, LoRAs or reference pictures). " +
  "It is saved to the company's Files and shown with your reply; with issueId it is attached to that task instead. It counts toward the daily picture limit, and it gives up after 30 seconds.";

export const QUICK_PICTURE_PARAMETERS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What the picture should show, in a sentence or two." },
    shape: {
      type: "string",
      enum: ["square", "landscape", "portrait"],
      description: "Optional. square (the usual), landscape or portrait.",
    },
    look: {
      type: "string",
      description: "Optional. The name of a saved look, only when the person names one. Leave it out otherwise: quick pictures do not use default or automatic looks.",
    },
    issueId: {
      type: "string",
      description: "Optional. The task to attach the picture to; only a task the person named or that is assigned to you. Leave it out to save it to the company's Files.",
    },
  },
  required: ["prompt"],
} as const;

export const LIST_LOOKS_DESCRIPTION =
  "List the company's saved picture looks (name, style, picture service, model name, LoRAs, and whether each has a fixed seed, reference pictures or the content filter off), which one is your default look (used when no look is named), and your automatic looks (which look is used at which times of day or for which keywords). Use it when the person asks which looks exist, or before using a look you are unsure of.";

/**
 * Media Studio — generate an image, preview it, gate it behind a board
 * approval, and only post once approved. Generation runs behind a provider
 * interface (mock / fal / sogni / comfyui) selected by operator config.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Media Studio",
  description:
    "Generate images (Fal.ai, Sogni or ComfyUI), keep them consistent with saved looks, seeds and reference pictures, work on existing pictures with Sogni (upscale, remove background, restore, change angle, apply a style, select objects), and require a board approval before posting.",
  author: "Durkan Agency (paperclip-fork)",
  categories: ["ui", "automation"],
  capabilities: [
    "agent.tools.register",
    "ui.detailTab.register",
    "http.outbound",
    "secrets.read-ref",
    "issue.attachments.create",
    "company.files.create",
    "company.files.read",
    // The looks page lists the company's agents to pick each one's default look.
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "ui.sidebar.register",
    "ui.page.register",
    "personas.generation_cap.enforce",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: TOOL_GENERATE,
      displayName: "Generate image",
      description: GENERATE_IMAGE_DESCRIPTION,
      parametersSchema: GENERATE_IMAGE_PARAMETERS as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_QUICK_PICTURE,
      displayName: "Quick picture",
      description: QUICK_PICTURE_DESCRIPTION,
      parametersSchema: QUICK_PICTURE_PARAMETERS as unknown as Record<string, unknown>,
    },
    {
      name: TOOL_LIST_LOOKS,
      displayName: "List saved looks",
      description: LIST_LOOKS_DESCRIPTION,
      parametersSchema: { type: "object", properties: {} },
    },
    // Upscale, remove background, restore, change angle, apply style, select
    // objects and improve prompt: one tool each, so an operator can tick them
    // per agent. Their parameters come from Sogni's own vendored schemas.
    ...sogniToolDeclarations(),
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: ISSUE_TAB_SLOT,
        displayName: "Media Studio",
        exportName: ISSUE_TAB_EXPORT,
        entityTypes: ["issue"],
      },
      {
        type: "sidebar",
        id: "media-studio-sidebar",
        displayName: "Media Studio",
        exportName: SIDEBAR_LINK_EXPORT,
        order: 30,
      },
      {
        type: "page",
        id: MAIN_PAGE_SLOT,
        displayName: "Media Studio",
        exportName: MAIN_PAGE_EXPORT,
        routePath: MAIN_PAGE_ROUTE,
      },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        title: "Picture service",
        description:
          "Which service makes the pictures: mock (a free placeholder picture, for trying things out), fal (Fal.ai), sogni (Sogni), or comfyui (your own ComfyUI server).",
        enum: ["mock", "fal", "sogni", "comfyui"],
        default: "mock",
      },
      falKeySecretRef: {
        type: "string",
        title: "Fal.ai API key (secret ref)",
        description: "A Paperclip secret reference resolved at call time to the FAL key.",
        format: "secret-ref",
        default: "",
      },
      falModel: {
        type: "string",
        title: "Fal.ai model",
        default: "fal-ai/flux/schnell",
      },
      sogniKeySecretRef: {
        type: "string",
        title: "Sogni API key",
        description:
          "Pick the Sogni key from the company's Secrets (create the key at dashboard.sogni.ai/api-key and save it as a secret first). It is looked up each time a picture is made and never shown here.",
        format: "secret-ref",
        default: "",
      },
      sogniModel: {
        type: "string",
        title: "Sogni model",
        description:
          "The Sogni model for normal pictures. z-turbo is fast and good for everyday pictures. Others: qwen-2512-lightning, krea-2-turbo, chroma-v46-flash, z-image, qwen-2512, chroma1-hd, and the paid gpt-image-2 models (need Premium Spark). For a specific model with its LoRAs, save a look instead (Company settings, Media Studio looks): its model list comes live from Sogni. Pictures made from reference pictures use Sogni's picture-editing model qwen-lightning.",
        default: "z-turbo",
      },
      sogniTokenType: {
        type: "string",
        title: "Sogni payment",
        description:
          "Which Sogni balance pays: auto (Spark first, then SOGNI; the usual choice), spark, or sogni. An active Sogni Unlimited plan is used first either way.",
        enum: ["auto", "spark", "sogni"],
        default: "auto",
      },
      comfyUrl: {
        type: "string",
        title: "ComfyUI base URL",
        description: "e.g. http://comfyui.tailnet:8188 (over Tailscale).",
        default: "",
      },
    },
  },
};

export default manifest;
