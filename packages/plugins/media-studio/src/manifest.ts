import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { sogniToolDeclarations } from "./sogni-tools.js";

export const PLUGIN_ID = "paperclip.media-studio";
const PLUGIN_VERSION = "0.1.0";

export const TOOL_GENERATE = "generate-image";
export const TOOL_LIST_LOOKS = "list-looks";
export const ACTION_GENERATE = "generate";
export const ACTION_LOOKS_LIST = "looks.list";
export const ACTION_LOOKS_SAVE = "looks.save";
export const ACTION_LOOKS_DELETE = "looks.delete";
/** The company's agents and each one's default look, for the looks page. */
export const ACTION_LOOK_DEFAULTS_LIST = "looks.defaults.list";
/** Set (or clear) one agent's default look. Owner/admin only. */
export const ACTION_LOOK_DEFAULTS_SET = "looks.defaults.set";
/** Sogni's live list of picture models, for the looks page's model picker. */
export const ACTION_SOGNI_MODELS = "sogni.models";
/** The LoRAs that work with one Sogni model, for the looks page. */
export const ACTION_SOGNI_LORAS = "sogni.loras";
export const ISSUE_TAB_SLOT = "media-studio-issue-tab";
export const ISSUE_TAB_EXPORT = "MediaStudioIssueTab";
export const LOOKS_PAGE_SLOT = "media-studio-looks";
export const LOOKS_PAGE_EXPORT = "MediaStudioLooksPage";
export const LOOKS_PAGE_ROUTE = "media-studio-looks";
/** At most this many reference pictures per image (Fal's Kontext models take a handful; Sogni's edit models 2-16). */
export const MAX_REFERENCE_FILES = 4;

/**
 * The generate-image tool's input. One copy, used by the manifest and by the
 * worker's registration, so the two cannot drift apart.
 */
export const GENERATE_IMAGE_DESCRIPTION =
  "Make a picture from a text description. Without a task it is saved to the company's Files (not tied to any task) and shown in the chat; with issueId it is attached to that task instead. " +
  "When the person names a saved look (\"in our catalogue look\"), pass it as look. " +
  "When no look is named, your default look is used (if an owner or admin gave you one); a look named in the request wins over it. The result says which look was used and why. " +
  "To make a close variation of an earlier picture (\"same as the last one but with a blue sofa\"), pass the seed that earlier picture reported. " +
  "To keep the same person, product or style as existing pictures, pass their file ids as referenceFileIds (up to 4). " +
  "Pictures are made by the picture service chosen in Media Studio settings; pass provider (\"fal\" or \"sogni\") only when the person asks for a specific one. " +
  "If the agent has a daily picture limit, this stops working once the limit is reached for the day (it resets at midnight UTC).";

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
        "Optional. The name of a saved look to use (its style, model, LoRAs, seed and reference pictures). Use list-looks to see the names. Leave it out to use your default look, if you have one.",
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

export const LIST_LOOKS_DESCRIPTION =
  "List the company's saved picture looks (name, style, picture service, model name, LoRAs, and whether each has a fixed seed, reference pictures or the content filter off), and which one is your default look (used when no look is named). Use it when the person asks which looks exist, or before using a look you are unsure of.";

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
    "instance.settings.register",
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
        type: "companySettingsPage",
        id: LOOKS_PAGE_SLOT,
        displayName: "Media Studio looks",
        exportName: LOOKS_PAGE_EXPORT,
        routePath: LOOKS_PAGE_ROUTE,
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
