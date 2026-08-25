import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.media-studio";
const PLUGIN_VERSION = "0.1.0";

export const TOOL_GENERATE = "generate-image";
export const ACTION_GENERATE = "generate";
export const ISSUE_TAB_SLOT = "media-studio-issue-tab";
export const ISSUE_TAB_EXPORT = "MediaStudioIssueTab";

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
    "Generate images (Fal.ai or ComfyUI), preview them, and require a board approval before posting.",
  author: "Durkan Agency (paperclip-fork)",
  categories: ["ui", "automation"],
  capabilities: [
    "agent.tools.register",
    "ui.detailTab.register",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: TOOL_GENERATE,
      displayName: "Generate image",
      description:
        "Generate an image from a text prompt using the configured provider. Returns a preview URL; a human still approves before it is posted.",
      parametersSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to generate." },
          imageSize: { type: "string", description: "Provider size hint, e.g. landscape_4_3." },
          model: { type: "string", description: "Optional provider model override." },
        },
        required: ["prompt"],
      },
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
