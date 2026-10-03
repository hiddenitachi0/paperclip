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
export const MODEL_DIRECTORY_NOTE_MAX_LENGTH = 500;

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
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
