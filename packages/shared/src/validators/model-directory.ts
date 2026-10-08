import { z } from "zod";
import {
  LANE_A_BACKUP_MODELS_MAX,
  LANE_A_MAX_MAX_OUTPUT_TOKENS,
  LANE_A_MAX_TEMPERATURE,
  LANE_A_MIN_MAX_OUTPUT_TOKENS,
  LANE_A_MIN_TEMPERATURE,
  LANE_A_PROVIDERS,
  LANE_A_THINKING_MODES,
  laneABackupModelEntryIssue,
  normalizeLaneAProvider,
} from "../lane-a-models.js";
import { laneABaseUrlValueSchema, laneAProviderRoutingSchema } from "./agent.js";

// DUR-4379: the company model directory -- saved model setups. These shapes
// mirror the agents.lane_a_* fields so applying an entry to an agent is a
// straight copy. No key is part of any shape here: keys stay in company
// secrets and are bound to the agent, never to a directory entry.

export const MODEL_DIRECTORY_NAME_MAX_LENGTH = 80;
export const MODEL_DIRECTORY_NOTE_MAX_LENGTH = 2000;
export const MODEL_DIRECTORY_MAKER_MAX_LENGTH = 60;
export const MODEL_DIRECTORY_BASE_MODEL_MAX_LENGTH = 80;
export const MODEL_DIRECTORY_TAG_MAX_LENGTH = 32;
export const MODEL_DIRECTORY_TAGS_MAX = 12;
/** How many entries one catalogue import may carry. */
export const MODEL_DIRECTORY_IMPORT_MAX = 200;

// Catalogue fields: what a model is good for and whether it is ready to use.
// None of them change how an agent calls the model.
export const MODEL_DIRECTORY_LANES = ["quick", "full", "both"] as const;
export type ModelDirectoryLane = (typeof MODEL_DIRECTORY_LANES)[number];
export const MODEL_DIRECTORY_AVAILABILITY = ["installed", "downloading", "planned", "cloud"] as const;
export type ModelDirectoryAvailability = (typeof MODEL_DIRECTORY_AVAILABILITY)[number];

const optionalLabel = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Facts that help pick a model. Every field is optional and informational:
 * Paperclip does not enforce any of them.
 */
export const modelDirectorySpecsSchema = z
  .object({
    /** Parameter count in words, e.g. "27B" or "26B (4B active)". */
    params: optionalLabel(40),
    /** Quantisation of the local file, e.g. "Q4_K_M". */
    quant: optionalLabel(40),
    /** Download size in GB. */
    sizeGb: z.number().min(0).max(2000).nullable().optional(),
    /** Context window in tokens. */
    contextTokens: z.number().int().min(0).max(10_000_000).nullable().optional(),
    /** Whether it fits on the owner's graphics card. */
    fitsLocalGpu: z.enum(["yes", "tight", "no"]).nullable().optional(),
    /** Whether tool calling works with it. */
    tools: z.enum(["yes", "partial", "no"]).nullable().optional(),
    vision: z.boolean().nullable().optional(),
    thinking: z.enum(["yes", "no", "toggle"]).nullable().optional(),
    license: optionalLabel(80),
    /** Where the model is described (model page). */
    sourceUrl: z.string().trim().url().max(500).nullable().optional(),
    /** The command that installs it on a local model server, e.g. "ollama pull qwen3:14b". */
    pullCommand: optionalLabel(300),
  })
  .strict();
export type ModelDirectorySpecs = z.infer<typeof modelDirectorySpecsSchema>;

// Catalogue v2: the owner's own test scores, one per criterion they choose
// ("Tool calling", "Responsiveness", "Long conversations", "Coding", ...).
export const MODEL_DIRECTORY_RATINGS_MAX = 20;
export const modelDirectoryRatingSchema = z
  .object({
    criterion: z.string().trim().min(1).max(40),
    score: z.number().int().min(0).max(10),
    note: z.string().trim().max(300).nullable().optional(),
    updatedAt: z.string().max(40).optional(),
  })
  .strict();
export type ModelDirectoryRating = z.infer<typeof modelDirectoryRatingSchema>;

const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(MODEL_DIRECTORY_TAG_MAX_LENGTH))
  .max(MODEL_DIRECTORY_TAGS_MAX)
  .transform((tags) => Array.from(new Set(tags)));

const nameSchema = z.string().trim().min(1, "Give this model setup a name.").max(MODEL_DIRECTORY_NAME_MAX_LENGTH);

const modelDirectoryFieldShape = {
  name: nameSchema,
  provider: z.enum(LANE_A_PROVIDERS),
  model: z.string().trim().min(1),
  baseUrl: laneABaseUrlValueSchema.nullable().optional(),
  providerRouting: laneAProviderRoutingSchema.nullable().optional(),
  defaultThinking: z.enum(LANE_A_THINKING_MODES).nullable().optional(),
  defaultTemperature: z.number().min(LANE_A_MIN_TEMPERATURE).max(LANE_A_MAX_TEMPERATURE).nullable().optional(),
  defaultMaxOutputTokens: z
    .number()
    .int()
    .min(LANE_A_MIN_MAX_OUTPUT_TOKENS)
    .max(LANE_A_MAX_MAX_OUTPUT_TOKENS)
    .nullable()
    .optional(),
  backupEntryIds: z.array(z.string().uuid()).max(LANE_A_BACKUP_MODELS_MAX).optional(),
  note: z.string().trim().max(MODEL_DIRECTORY_NOTE_MAX_LENGTH).nullable().optional(),
  maker: optionalLabel(MODEL_DIRECTORY_MAKER_MAX_LENGTH),
  baseModel: optionalLabel(MODEL_DIRECTORY_BASE_MODEL_MAX_LENGTH),
  lane: z.enum(MODEL_DIRECTORY_LANES).nullable().optional(),
  availability: z.enum(MODEL_DIRECTORY_AVAILABILITY).nullable().optional(),
  tags: tagsSchema.optional(),
  specs: modelDirectorySpecsSchema.nullable().optional(),
  favorite: z.boolean().optional(),
  family: optionalLabel(MODEL_DIRECTORY_BASE_MODEL_MAX_LENGTH),
  variant: optionalLabel(40),
  ratings: z.array(modelDirectoryRatingSchema).max(MODEL_DIRECTORY_RATINGS_MAX).optional(),
};

/**
 * Why this combination cannot be saved, in plain words, or null. Same fit
 * rules as a backup-pool entry (model belongs to provider, a free-form
 * provider needs an address) plus: host routing is OpenRouter only, and an
 * entry cannot name itself as a backup. Shared so create (schema) and update
 * (service, on the merged row) enforce the same thing.
 */
export function modelDirectoryEntryIssue(entry: {
  id?: string | null;
  provider: unknown;
  model: unknown;
  baseUrl?: string | null;
  providerRouting?: unknown;
  backupEntryIds?: readonly string[] | null;
}): string | null {
  const fit = laneABackupModelEntryIssue(entry);
  if (fit) return fit;
  if (entry.providerRouting && normalizeLaneAProvider(entry.provider) !== "openrouter") {
    return "Model host restrictions only apply to OpenRouter.";
  }
  const backups = entry.backupEntryIds ?? [];
  if (new Set(backups).size !== backups.length) return "A backup model is listed twice.";
  if (entry.id && backups.includes(entry.id)) return "A model setup cannot be its own backup.";
  return null;
}

export const createModelDirectoryEntrySchema = z
  .object(modelDirectoryFieldShape)
  .strict()
  .superRefine((value, ctx) => {
    const issue = modelDirectoryEntryIssue(value);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });
export type CreateModelDirectoryEntry = z.infer<typeof createModelDirectoryEntrySchema>;

export const updateModelDirectoryEntrySchema = z
  .object({
    name: modelDirectoryFieldShape.name.optional(),
    provider: modelDirectoryFieldShape.provider.optional(),
    model: modelDirectoryFieldShape.model.optional(),
    baseUrl: modelDirectoryFieldShape.baseUrl,
    providerRouting: modelDirectoryFieldShape.providerRouting,
    defaultThinking: modelDirectoryFieldShape.defaultThinking,
    defaultTemperature: modelDirectoryFieldShape.defaultTemperature,
    defaultMaxOutputTokens: modelDirectoryFieldShape.defaultMaxOutputTokens,
    backupEntryIds: modelDirectoryFieldShape.backupEntryIds,
    note: modelDirectoryFieldShape.note,
    maker: modelDirectoryFieldShape.maker,
    baseModel: modelDirectoryFieldShape.baseModel,
    lane: modelDirectoryFieldShape.lane,
    availability: modelDirectoryFieldShape.availability,
    tags: modelDirectoryFieldShape.tags,
    specs: modelDirectoryFieldShape.specs,
    favorite: modelDirectoryFieldShape.favorite,
    family: modelDirectoryFieldShape.family,
    variant: modelDirectoryFieldShape.variant,
    ratings: modelDirectoryFieldShape.ratings,
    /** true hides the entry from agent pickers (kept, restorable); false brings it back. */
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateModelDirectoryEntry = z.infer<typeof updateModelDirectoryEntrySchema>;

/** Optional new name for a duplicate; defaults to "<name> (copy)". */
export const duplicateModelDirectoryEntrySchema = z.object({ name: nameSchema.optional() }).strict();
export type DuplicateModelDirectoryEntry = z.infer<typeof duplicateModelDirectoryEntrySchema>;

/** What the API returns for one entry. Never carries a key. */
export interface ModelDirectoryEntry {
  id: string;
  companyId: string;
  name: string;
  provider: (typeof LANE_A_PROVIDERS)[number];
  model: string;
  baseUrl: string | null;
  providerRouting: z.infer<typeof laneAProviderRoutingSchema> | null;
  defaultThinking: (typeof LANE_A_THINKING_MODES)[number] | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
  backupEntryIds: string[];
  note: string | null;
  maker: string | null;
  baseModel: string | null;
  lane: ModelDirectoryLane | null;
  availability: ModelDirectoryAvailability | null;
  tags: string[];
  specs: ModelDirectorySpecs | null;
  favorite: boolean;
  /** Set when archived: hidden from agent pickers, kept in Settings > Models. */
  archivedAt: string | null;
  /** Model family, e.g. "Llama 3.2" (falls back to baseModel on older rows). */
  family: string | null;
  /** Size or variant within the family, e.g. "3B" or "14B uncensored". */
  variant: string | null;
  ratings: ModelDirectoryRating[];
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// DUR-4418: ready-made starter setups, replaced 8 Oct 2026 by the curated
// catalogue from the model-library research (local models for a 12 GB card,
// their bigger tool-capable cloud versions, OpenRouter hosts checked for tool
// support). Local models reached over Tailscale (never "localhost", which
// for Paperclip is the server itself). No key is part of a starter.

export const MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS = "http://100.124.232.68:11434/v1";

export interface ModelDirectoryStarter {
  /** Stable slug, used to pick which starters to add. */
  id: string;
  name: string;
  provider: (typeof LANE_A_PROVIDERS)[number];
  model: string;
  baseUrl: string | null;
  providerRouting: { only?: string[]; ignore?: string[] } | null;
  defaultThinking: (typeof LANE_A_THINKING_MODES)[number] | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
  maker: string;
  baseModel: string;
  lane: ModelDirectoryLane;
  availability: ModelDirectoryAvailability;
  tags: string[];
  specs: ModelDirectorySpecs | null;
  note: string;
}

export const MODEL_DIRECTORY_STARTERS: readonly ModelDirectoryStarter[] = [
  {
    id: "local-llama-3-2-3b",
    name: "Llama 3.2 3B",
    provider: "local",
    model: "llama3.2:latest",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: null,
    defaultTemperature: 0.3,
    defaultMaxOutputTokens: 1024,
    maker: "Meta",
    baseModel: "Llama 3.2 3B",
    lane: "quick",
    availability: "installed",
    tags: ["small", "fast", "tools", "fallback", "censored", "private"],
    specs: {"params": "3B", "quant": "Q4_K_M", "sizeGb": 2.0, "fitsLocalGpu": "yes", "tools": "partial", "vision": false, "thinking": "no", "pullCommand": "ollama pull llama3.2"},
    note: "Tiny and quick. Good as a backup or a simple router, but it gets facts wrong and its Norwegian is weak.",
  },
  {
    id: "local-qwen3-14b",
    name: "Qwen3 14B",
    provider: "local",
    model: "qwen3:14b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3 14B",
    lane: "quick",
    availability: "downloading",
    tags: ["tools", "private", "norwegian-ok", "default-local", "censored"],
    specs: {"params": "14B", "quant": "Q4_K_M", "sizeGb": 9.3, "fitsLocalGpu": "tight", "tools": "yes", "vision": false, "thinking": "toggle", "pullCommand": "ollama pull qwen3:14b"},
    note: "Best local model for a normal assistant: the most reliable tool use that fits your PC. Use this for company-facing quick agents.",
  },
  {
    id: "local-qwen3-14b-uncensored",
    name: "Qwen3 14B uncensored",
    provider: "local",
    model: "huihui_ai/qwen3-abliterated:14b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3 14B",
    lane: "quick",
    availability: "installed",
    tags: ["uncensored", "persona", "private", "tools-untested"],
    specs: {"params": "14B", "quant": "Q4_K_M", "sizeGb": 9.0, "fitsLocalGpu": "tight", "tools": "yes", "vision": false, "thinking": "toggle", "pullCommand": "ollama pull huihui_ai/qwen3-abliterated:14b"},
    note: "Same 14B with refusals removed. Only for a separate private persona; never on agents that touch company data. Test tools once first.",
  },
  {
    id: "local-qwen3-8b-uncensored",
    name: "Qwen3 8B uncensored",
    provider: "local",
    model: "huihui_ai/qwen3-abliterated:8b-v2",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3 8B",
    lane: "quick",
    availability: "downloading",
    tags: ["uncensored", "persona", "private", "fast", "tools-untested"],
    specs: {"params": "8B", "quant": "Q4_K_M", "sizeGb": 5.0, "fitsLocalGpu": "yes", "tools": "yes", "vision": false, "thinking": "toggle", "pullCommand": "ollama pull huihui_ai/qwen3-abliterated:8b-v2"},
    note: "Lighter, faster uncensored Qwen with room for long chats. Same rule: separate persona only.",
  },
  {
    id: "local-qwen3-8-27b-uncensored-2-bit-local",
    name: "Qwen3.8 27B uncensored (2-bit, local)",
    provider: "local",
    model: "qwen38-27b-unc-8k",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 1536,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3.8 27B",
    lane: "quick",
    availability: "planned",
    tags: ["uncensored", "persona", "vision", "experimental", "private"],
    specs: {"params": "27B", "quant": "IQ2_XXS", "sizeGb": 9.8, "contextTokens": 8192, "fitsLocalGpu": "tight", "tools": "yes", "vision": true, "thinking": "toggle", "pullCommand": "ollama pull orcarouter/Qwen3.8-27B-Uncensored:iq2_xxs"},
    note: "Strongest uncensored model that fits your PC, but heavily shrunk with short memory. Pull orcarouter/Qwen3.8-27B-Uncensored:iq2_xxs and create this name with num_ctx 8192.",
  },
  {
    id: "openrouter-qwen3-8-27b-cloud",
    name: "Qwen3.8 27B (cloud)",
    provider: "openrouter",
    model: "qwen/qwen3.8-27b",
    baseUrl: null,
    providerRouting: {"only": ["deepinfra", "parasail", "novita"]},
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 4096,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3.8 27B",
    lane: "both",
    availability: "cloud",
    tags: ["tools", "vision", "coding", "agent", "default-cloud"],
    specs: {"params": "27B", "contextTokens": 262144, "tools": "yes", "vision": true, "thinking": "toggle"},
    note: "Full-quality 27B with reliable tools; an agent already uses it. About $0.15 in / $1.88 out per million tokens on DeepInfra.",
  },
  {
    id: "openrouter-qwen3-8-flash-cloud",
    name: "Qwen3.8 Flash (cloud)",
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
    baseUrl: null,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3.8 Flash",
    lane: "both",
    availability: "cloud",
    tags: ["cheap", "fast", "tools", "vision", "long-context"],
    specs: {"params": "~180B MoE (6B active)", "contextTokens": 1000000, "tools": "yes", "vision": true, "thinking": "toggle"},
    note: "Very cheap, fast big model from the same family. Only one host (Alibaba), so give agents a backup such as Qwen3.8 27B.",
  },
  {
    id: "local-gemma-4-12b",
    name: "Gemma 4 12B",
    provider: "local",
    model: "gemma4:12b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Google",
    baseModel: "Gemma 4 12B",
    lane: "quick",
    availability: "planned",
    tags: ["tools", "vision", "private", "norwegian-ok", "censored"],
    specs: {"params": "12B", "quant": "Q4_K_M", "sizeGb": 8.0, "fitsLocalGpu": "yes", "tools": "yes", "vision": true, "thinking": "toggle", "pullCommand": "ollama pull gemma4:12b"},
    note: "Google's 12B: good tools, reads pictures, decent Norwegian. Replaces Gemma 3 12B. Needs Ollama 0.30.9 or newer.",
  },
  {
    id: "local-gemma-4-12b-uncensored",
    name: "Gemma 4 12B uncensored",
    provider: "local",
    model: "huihui_ai/gemma-4-abliterated:12b-qat",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Google",
    baseModel: "Gemma 4 12B",
    lane: "quick",
    availability: "planned",
    tags: ["uncensored", "persona", "vision", "private", "tools-untested"],
    specs: {"params": "12B", "quant": "QAT Q4", "sizeGb": 7.6, "fitsLocalGpu": "yes", "tools": "yes", "vision": true, "thinking": "toggle", "pullCommand": "ollama pull huihui_ai/gemma-4-abliterated:12b-qat"},
    note: "Uncensored Gemma 12B. Pull this :12b-qat tag instead of the :12b you started: same size, better quality. Separate persona only.",
  },
  {
    id: "local-gemma-4-e4b-small",
    name: "Gemma 4 E4B (small)",
    provider: "local",
    model: "gemma4:e4b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 1024,
    maker: "Google",
    baseModel: "Gemma 4 E4B",
    lane: "quick",
    availability: "downloading",
    tags: ["small", "fast", "vision", "audio", "private", "censored"],
    specs: {"params": "4.5B effective", "quant": "Q4_K_M", "sizeGb": 6.6, "fitsLocalGpu": "yes", "tools": "yes", "vision": true, "thinking": "toggle", "pullCommand": "ollama pull gemma4:e4b"},
    note: "What 'ollama pull gemma4' actually gives you: a small, fast model that reads pictures and audio. Fine for one simple tool call, weak at more.",
  },
  {
    id: "openrouter-gemma-4-31b-cloud",
    name: "Gemma 4 31B (cloud)",
    provider: "openrouter",
    model: "google/gemma-4-31b-it",
    baseUrl: null,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 4096,
    maker: "Google",
    baseModel: "Gemma 4 31B",
    lane: "both",
    availability: "cloud",
    tags: ["tools", "vision", "norwegian-best", "writing", "cheap"],
    specs: {"params": "31B", "tools": "yes", "vision": true, "thinking": "toggle"},
    note: "Best Norwegian writer here and cheap (about $0.09-0.14 in / $0.34-0.40 out per million tokens). Every host supports tools.",
  },
  {
    id: "openrouter-gemma-4-26b-a4b-cloud",
    name: "Gemma 4 26B A4B (cloud)",
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it",
    baseUrl: null,
    providerRouting: {"only": ["deepinfra", "novita", "google-vertex", "cloudflare"]},
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Google",
    baseModel: "Gemma 4 26B A4B",
    lane: "quick",
    availability: "cloud",
    tags: ["cheap", "fast", "tools", "vision"],
    specs: {"params": "26B MoE (3.8B active)", "tools": "yes", "vision": true, "thinking": "toggle"},
    note: "Very cheap, fast cloud model for quick replies. Locked to hosts that support tools (three hosts do not).",
  },
  {
    id: "local-hermes-3-8b",
    name: "Hermes 3 8B",
    provider: "local",
    model: "hermes3:8b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    providerRouting: null,
    defaultThinking: null,
    defaultTemperature: 0.6,
    defaultMaxOutputTokens: 1536,
    maker: "Nous Research",
    baseModel: "Llama 3.1 8B",
    lane: "quick",
    availability: "downloading",
    tags: ["persona", "roleplay", "private", "tools-fragile"],
    specs: {"params": "8B", "quant": "Q4_0", "sizeGb": 4.7, "fitsLocalGpu": "yes", "tools": "partial", "vision": false, "thinking": "no", "pullCommand": "ollama pull hermes3:8b"},
    note: "Good at staying in character. Tool calls can break when many tools are offered, so test first. Weak Norwegian. Better copy: hermes3:8b-llama3.1-q6_K.",
  },
  {
    id: "openrouter-llama-4-maverick-cloud",
    name: "Llama 4 Maverick (cloud)",
    provider: "openrouter",
    model: "meta-llama/llama-4-maverick",
    baseUrl: null,
    providerRouting: {"only": ["digitalocean", "parasail", "google-vertex"]},
    defaultThinking: null,
    defaultTemperature: 0.4,
    defaultMaxOutputTokens: 2048,
    maker: "Meta",
    baseModel: "Llama 4 Maverick",
    lane: "quick",
    availability: "cloud",
    tags: ["cheap", "vision", "tools"],
    specs: {"params": "400B MoE (17B active)", "tools": "yes", "vision": true, "thinking": "no"},
    note: "The Llama 4 you asked about, run in the cloud (far too big for your PC). Cheap, reads images, fine for single tool calls; weak at long tasks and Norwegian.",
  },
  {
    id: "openrouter-deepseek-v4-flash-cloud",
    name: "DeepSeek V4 Flash (cloud)",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    baseUrl: null,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 4096,
    maker: "DeepSeek",
    baseModel: "DeepSeek V4 Flash",
    lane: "both",
    availability: "cloud",
    tags: ["cheap", "tools", "agent", "coding", "long-context"],
    specs: {"tools": "yes", "vision": false, "thinking": "toggle"},
    note: "Cheap, strong all-rounder with tools on every host. Good cheap Full-task worker. Replaces the DeepSeek R1 8B, which cannot use tools.",
  },
  {
    id: "huggingface-qwen3-14b-uncensored-cloud",
    name: "Qwen3 14B uncensored (cloud)",
    provider: "huggingface",
    model: "huihui-ai/Huihui-Qwen3-14B-abliterated-v2:featherless-ai",
    baseUrl: null,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3 14B",
    lane: "quick",
    availability: "planned",
    tags: ["uncensored", "persona", "cloud", "tools-untested"],
    specs: {"params": "14B", "contextTokens": 32768, "thinking": "toggle"},
    note: "Cloud copy of your installed uncensored 14B, for when the PC is off. Needs Hugging Face set up; about $0.48 in / $0.96 out per million tokens. Test tools first.",
  },
  {
    id: "huggingface-qwen3-8-27b-uncensored-cloud",
    name: "Qwen3.8 27B uncensored (cloud)",
    provider: "huggingface",
    model: "darkc0de/Qwen3.8-27B-heretic:featherless-ai",
    baseUrl: null,
    providerRouting: null,
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Alibaba Qwen",
    baseModel: "Qwen3.8 27B",
    lane: "quick",
    availability: "planned",
    tags: ["uncensored", "persona", "cloud", "expensive", "tools-untested"],
    specs: {"params": "27B", "contextTokens": 32768, "thinking": "toggle"},
    note: "Full-quality uncensored 27B. Needs Hugging Face set up. Pricey (likely about $1.60 in / $12 out per million tokens), short memory (32k), tools untested.",
  },
  {
    id: "openrouter-mistral-small-3-2-cloud",
    name: "Mistral Small 3.2 (cloud)",
    provider: "openrouter",
    model: "mistralai/mistral-small-3.2-24b-instruct",
    baseUrl: null,
    providerRouting: {"only": ["deepinfra"]},
    defaultThinking: null,
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 2048,
    maker: "Mistral AI",
    baseModel: "Mistral Small 3.2 24B",
    lane: "quick",
    availability: "cloud",
    tags: ["tools", "cheap", "eu-host-available"],
    specs: {"params": "24B", "tools": "yes", "vision": true, "thinking": "no"},
    note: "A good cloud model for quick agents. DeepInfra supports its tools.",
  },
];

export const addModelDirectoryStartersSchema = z
  .object({ starterIds: z.array(z.string().min(1)).max(MODEL_DIRECTORY_STARTERS.length).optional() })
  .strict();
export type AddModelDirectoryStarters = z.infer<typeof addModelDirectoryStartersSchema>;

/** One starter as listed by the API: whether this company already has it. */
export interface ModelDirectoryStarterStatus extends ModelDirectoryStarter {
  alreadyAdded: boolean;
}

export interface ModelDirectoryImportResult {
  /** Entries created by this run. */
  created: ModelDirectoryEntry[];
  /** How many agents now point at an entry (new or pre-existing identical one). */
  agentsLinked: number;
  /** Agents whose current setup could not be saved, with a plain-English reason. */
  skipped: { agentId: string; agentName: string; reason: string }[];
}

// Catalogue export / import (Settings > Models). An export is a plain JSON
// file of setups -- never a key -- that can be imported into this or another
// company. Backups are written as entry NAMES (ids differ between companies).

export const MODEL_DIRECTORY_EXPORT_VERSION = 1;

const catalogueEntryShape = {
  ...modelDirectoryFieldShape,
  backupEntryIds: z.never().optional(),
  /** Names of other entries in the same file or company, in order. */
  backupNames: z.array(nameSchema).max(LANE_A_BACKUP_MODELS_MAX).optional(),
  archived: z.boolean().optional(),
};

export const modelDirectoryCatalogueEntrySchema = z
  .object(catalogueEntryShape)
  .strict()
  .superRefine((value, ctx) => {
    const issue = modelDirectoryEntryIssue({ ...value, backupEntryIds: [] });
    if (issue) ctx.addIssue({ code: "custom", message: `${value.name}: ${issue}` });
  });
export type ModelDirectoryCatalogueEntry = z.infer<typeof modelDirectoryCatalogueEntrySchema>;

export const importModelDirectoryCatalogueSchema = z
  .object({
    version: z.literal(MODEL_DIRECTORY_EXPORT_VERSION).optional(),
    /** Written by an export; accepted (and ignored) so an exported file imports as-is. */
    exportedAt: z.string().max(64).optional(),
    entries: z.array(modelDirectoryCatalogueEntrySchema).min(1).max(MODEL_DIRECTORY_IMPORT_MAX),
    /** What to do when a setup with the same name already exists. Default: skip it. */
    onExisting: z.enum(["skip", "update"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const entry of value.entries) {
      const key = entry.name.trim().toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `"${entry.name}" is listed twice in the file.` });
      seen.add(key);
    }
  });
export type ImportModelDirectoryCatalogue = z.infer<typeof importModelDirectoryCatalogueSchema>;

export interface ModelDirectoryCatalogueExport {
  version: typeof MODEL_DIRECTORY_EXPORT_VERSION;
  exportedAt: string;
  entries: ModelDirectoryCatalogueEntry[];
}

export interface ModelDirectoryCatalogueImportResult {
  created: string[];
  updated: string[];
  skipped: { name: string; reason: string }[];
}

// ─── Catalogue v2: settings, local Ollama resync ─────────────────────────────

export const updateModelDirectorySettingsSchema = z
  .object({ localGpuVramGb: z.number().min(0).max(1024).nullable() })
  .strict();
export type UpdateModelDirectorySettings = z.infer<typeof updateModelDirectorySettingsSchema>;

export interface ModelDirectorySettings {
  localGpuVramGb: number | null;
}

/**
 * Ask a local Ollama which models are installed. The address must be one this
 * company already uses (a saved local model's address or a quick agent's), so
 * the server never calls an arbitrary host on someone's say-so.
 */
export const syncLocalModelsSchema = z.object({ baseUrl: z.string().trim().url().max(500) }).strict();
export type SyncLocalModels = z.infer<typeof syncLocalModelsSchema>;

export interface LocalInstalledModel {
  /** Ollama tag, e.g. "llama3.2:latest". */
  name: string;
  sizeGb: number | null;
  /** From Ollama's details, e.g. "3.2B". */
  parameterSize: string | null;
  /** From Ollama's details, e.g. "Q4_K_M". */
  quantization: string | null;
  /** From Ollama's details, e.g. "llama". */
  family: string | null;
  /** Saved entries (this address) that run this tag. */
  entryIds: string[];
}

export interface LocalModelsSyncResult {
  baseUrl: string;
  checkedAt: string;
  installed: LocalInstalledModel[];
  /** Saved local entries at this address whose tag is no longer installed (now marked "planned"). */
  missingEntryIds: string[];
  /** Saved local entries marked "installed" by this sync. */
  markedInstalledEntryIds: string[];
}
