import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.media-studio";
const PLUGIN_VERSION = "0.1.0";

export const TOOL_GENERATE = "generate-image";
export const TOOL_LIST_LOOKS = "list-looks";
export const ACTION_GENERATE = "generate";
export const ACTION_LOOKS_LIST = "looks.list";
export const ACTION_LOOKS_SAVE = "looks.save";
export const ACTION_LOOKS_DELETE = "looks.delete";
export const ISSUE_TAB_SLOT = "media-studio-issue-tab";
export const ISSUE_TAB_EXPORT = "MediaStudioIssueTab";
export const LOOKS_PAGE_SLOT = "media-studio-looks";
export const LOOKS_PAGE_EXPORT = "MediaStudioLooksPage";
export const LOOKS_PAGE_ROUTE = "media-studio-looks";
/** At most this many reference pictures per image (Fal's Kontext models take a handful). */
export const MAX_REFERENCE_FILES = 4;

/**
 * The generate-image tool's input. One copy, used by the manifest and by the
 * worker's registration, so the two cannot drift apart.
 */
export const GENERATE_IMAGE_DESCRIPTION =
  "Make a picture from a text description. Without a task it is saved to the company's Files (not tied to any task) and shown in the chat; with issueId it is attached to that task instead. " +
  "When the person names a saved look (\"in our catalogue look\"), pass it as look. " +
  "To make a close variation of an earlier picture (\"same as the last one but with a blue sofa\"), pass the seed that earlier picture reported. " +
  "To keep the same person, product or style as existing pictures, pass their file ids as referenceFileIds (up to 4). " +
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
      description: "Optional. The name of a saved look to use (its style, model, seed and reference pictures). Use list-looks to see the names.",
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
    imageSize: { type: "string", description: "Provider size hint, e.g. landscape_4_3." },
    model: { type: "string", description: "Optional provider model override." },
  },
  required: ["prompt"],
} as const;

export const LIST_LOOKS_DESCRIPTION =
  "List the company's saved picture looks (name, style, and whether each has a fixed seed or reference pictures). Use it when the person asks which looks exist, or before using a look you are unsure of.";

/**
 * Media Studio — generate an image, preview it, gate it behind a board
 * approval, and only post once approved. Generation runs behind a provider
 * interface (mock / fal / comfyui) selected by operator config.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Media Studio",
  description:
    "Generate images (Fal.ai or ComfyUI), keep them consistent with saved looks, seeds and reference pictures, and require a board approval before posting.",
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
        title: "Generation provider",
        description: "mock (keyless placeholder), fal (Fal.ai), or comfyui (self-hosted).",
        enum: ["mock", "fal", "comfyui"],
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
