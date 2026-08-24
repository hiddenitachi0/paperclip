import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

// DUR-69/DUR-109: how many days an agent's instructions can go without
// review before they're flagged stale. One instance-wide number, not
// per-agent, per Filip's ruling -- changeable later.
export const DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS = 60;
export const MIN_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS = 1;
export const MAX_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS = 3650;

// DUR-151: hard ceiling on how many heartbeat runs may be `running` across
// the WHOLE instance at once, regardless of how many agents want to run or
// what their individual `maxConcurrentRuns` allows. Per-agent caps alone
// don't prevent the box from being oversubscribed once enough agents are
// active at the same time. Default of 4 matches this fork's own 4-CPU box;
// operators on different hardware should tune it.
export const DEFAULT_INSTANCE_CONCURRENCY_CAP = 4;
export const MIN_INSTANCE_CONCURRENCY_CAP = 1;
export const MAX_INSTANCE_CONCURRENCY_CAP = 50;

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
  /** Days since `agents.instructionsReviewedAt` before an agent is flagged stale. */
  instructionsStalenessThresholdDays: number;
  /**
   * Hard ceiling on `running` heartbeat runs across the whole instance,
   * independent of any agent's own `maxConcurrentRuns`. Runs that can't
   * start because this cap is full stay `queued` (see
   * `heartbeatRuns.capacityWaitSince`) instead of being spawned and lost.
   */
  instanceConcurrencyCap: number;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  enableStreamlinedLeftNavigation: boolean;
  enablePipelines: boolean;
  enableConferenceRoomChat: boolean;
  enableTaskWatchdogs: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableCloudSync: boolean;
  enableExternalObjects: boolean;
  enableServerInfoDebugView: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
