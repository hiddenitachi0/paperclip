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
  DEFAULT_MAX_RUN_DURATION_MINUTES,
  MIN_MAX_RUN_DURATION_MINUTES,
  MAX_MAX_RUN_DURATION_MINUTES,
  DEFAULT_SILENT_RUN_TIMEOUT_MINUTES,
  MIN_SILENT_RUN_TIMEOUT_MINUTES,
  MAX_SILENT_RUN_TIMEOUT_MINUTES,
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
  // DUR-3940 item 2 / run cap: watchdog limits for local child-process runs.
  // A run going longer than this without finishing is stopped, marked failed
  // and retried once; per agent it can be overridden (or switched off with
  // 0) via adapterConfig.maxRunDurationMinutes.
  maxRunDurationMinutes: z
    .number()
    .int()
    .min(MIN_MAX_RUN_DURATION_MINUTES)
    .max(MAX_MAX_RUN_DURATION_MINUTES)
    .default(DEFAULT_MAX_RUN_DURATION_MINUTES),
  // Same for a run whose process is alive but has printed nothing for this
  // long; per-agent override adapterConfig.silentRunTimeoutMinutes.
  silentRunTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_SILENT_RUN_TIMEOUT_MINUTES)
    .max(MAX_SILENT_RUN_TIMEOUT_MINUTES)
    .default(DEFAULT_SILENT_RUN_TIMEOUT_MINUTES),
  // DUR-224. Managed exclusively by the quiet-mode activate/deactivate
  // service functions (they need to read+write the `agents` table
  // atomically with the flip), not by the generic general-settings patch --
  // see patchInstanceGeneralSettingsSchema below, which omits it.
  quietMode: quietModeStateSchema.default(DEFAULT_QUIET_MODE_STATE),
  // DUR-299 point 6 / DUR-314: live kill switch for the delegated
  // merge_pr-approval automation (server/src/services/merge-pr-automation.ts).
  // Defaults to false -- the automation ships dormant and an operator must
  // explicitly opt in via a normal PATCH here (no redeploy needed either way
  // to turn it on or back off).
  mergePrAutomationEnabled: z.boolean().default(false),
  // DUR-411: opt-in stricter gate for the low-scrutiny "fact check" card
  // (ui/src/components/IssueThreadInteractionCard.tsx). Off = today's
  // denylist-only heuristic; on = the card must ALSO be positively
  // recognised as a fact check (question phrased as a check, every numbered
  // line a plain statement, no "unless you object"-style consent traps).
  // Strictly more conservative than off, never less.
  factCheckCardStrictAllowlist: z.boolean().default(false),
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
