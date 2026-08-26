import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
  MAX_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
  MIN_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
  DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
  MIN_GLOBAL_MAX_CONCURRENT_RUNS,
  MAX_GLOBAL_MAX_CONCURRENT_RUNS,
  DEFAULT_QUIET_MODE_STATE,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const quietModeActorSchema = z.object({
  actorType: z.string(),
  actorId: z.string().nullable(),
  agentId: z.string().nullable(),
}).strict();

export const quietModeAgentSnapshotEntrySchema = z.object({
  agentId: z.string(),
  companyId: z.string(),
  enabled: z.boolean(),
  wakeOnDemand: z.boolean(),
}).strict();

export const quietModeStateSchema = z.object({
  active: z.boolean().default(false),
  activatedAt: z.string().nullable().default(null),
  activatedBy: quietModeActorSchema.nullable().default(null),
  deactivatedAt: z.string().nullable().default(null),
  snapshot: z.array(quietModeAgentSnapshotEntrySchema).nullable().default(null),
}).strict();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  // Execution policy. Absent/"any" = unrestricted; "kubernetes" forces the
  // Kubernetes sandbox provider and denies local/ssh execution (cloud_tenant).
  executionMode: z.enum(["kubernetes", "any"]).optional(),
  instructionsStalenessThresholdDays: z
    .number()
    .int()
    .min(MIN_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS)
    .max(MAX_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS)
    .default(DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS),
  // Whole-instance ceiling on simultaneously running heartbeat runs, across
  // every agent/company. Distinct from (and enforced in addition to) each
  // agent's own maxConcurrentRuns.
  globalMaxConcurrentRuns: z
    .number()
    .int()
    .min(MIN_GLOBAL_MAX_CONCURRENT_RUNS)
    .max(MAX_GLOBAL_MAX_CONCURRENT_RUNS)
    .default(DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS),
  // DUR-224. Managed exclusively by the quiet-mode activate/deactivate
  // service functions (they need to read+write the `agents` table
  // atomically with the flip), not by the generic general-settings patch --
  // see patchInstanceGeneralSettingsSchema below, which omits it.
  quietMode: quietModeStateSchema.default(DEFAULT_QUIET_MODE_STATE),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.omit({ quietMode: true }).partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enablePipelines: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableTaskWatchdogs: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableCloudSync: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().uuid().nullable().optional(),
}).strict();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type PatchInstanceSettings = z.infer<typeof patchInstanceSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;

export const instanceSettingsSchema = z.object({
  id: z.string().uuid(),
  defaultEnvironmentId: z.string().uuid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();
