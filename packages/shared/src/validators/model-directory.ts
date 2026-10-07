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
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// DUR-4418: ready-made starter setups. Local models are the ones in the
// DUR-4357 Ollama runbook, reached over Tailscale (never "localhost", which
// for Paperclip is the server itself). No key is part of a starter.

export const MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS = "http://100.124.232.68:11434/v1";
const HUGGINGFACE_NOTE = "Tool-capable on the DeepInfra host. Needs a Hugging Face token on the agent.";
const LOCAL_NOTE = "Needs your PC switched on, with Ollama and Tailscale running.";

export interface ModelDirectoryStarter {
  /** Stable slug, used to pick which starters to add. */
  id: string;
  name: string;
  provider: (typeof LANE_A_PROVIDERS)[number];
  model: string;
  baseUrl: string | null;
  defaultThinking: (typeof LANE_A_THINKING_MODES)[number] | null;
  note: string;
}

export const MODEL_DIRECTORY_STARTERS: readonly ModelDirectoryStarter[] = [
  {
    id: "local-forgotten-safeword-12b",
    name: "Local: Forgotten-Safeword 12B",
    provider: "local",
    model: "hf.co/mradermacher/Forgotten-Safeword-12B-v4.0-i1-GGUF:Q4_K_M",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    defaultThinking: null,
    note: `${LOCAL_NOTE} Uncensored: use it for a separate persona, not for company work.`,
  },
  {
    id: "local-satyr-4b",
    name: "Local: Satyr 4B",
    provider: "local",
    model: "hf.co/PantheonUnbound/Satyr-V0.1-4B:Q8_0",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    defaultThinking: "off",
    note: `${LOCAL_NOTE} A thinking model, so Thinking starts switched off. Uncensored.`,
  },
  {
    id: "local-deepseek-r1-8b",
    name: "Local: DeepSeek R1 8B",
    provider: "local",
    model: "deepseek-r1:8b",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    defaultThinking: null,
    note: LOCAL_NOTE,
  },
  {
    id: "local-llama-3-2",
    name: "Local: Llama 3.2",
    provider: "local",
    model: "llama3.2",
    baseUrl: MODEL_DIRECTORY_LOCAL_STARTER_ADDRESS,
    defaultThinking: null,
    note: LOCAL_NOTE,
  },
  {
    id: "openrouter-mistral-small-3-2",
    name: "Mistral Small 3.2 (OpenRouter)",
    provider: "openrouter",
    model: "mistralai/mistral-small-3.2-24b-instruct",
    baseUrl: null,
    defaultThinking: null,
    note: "A good cloud backup for local models. Needs an OpenRouter key on the agent.",
  },
  {
    id: "huggingface-qwen3-14b",
    name: "Qwen3 14B (Hugging Face)",
    provider: "huggingface",
    model: "Qwen/Qwen3-14B:deepinfra",
    baseUrl: null,
    defaultThinking: null,
    note: HUGGINGFACE_NOTE,
  },
  {
    id: "huggingface-gemma-3-27b",
    name: "Gemma 3 27B (Hugging Face)",
    provider: "huggingface",
    model: "google/gemma-3-27b-it:deepinfra",
    baseUrl: null,
    defaultThinking: null,
    note: HUGGINGFACE_NOTE,
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
