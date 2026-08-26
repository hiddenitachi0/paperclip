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

// DUR-151: whole-instance cap on simultaneously *running* heartbeat runs,
// across every agent and company. Per-agent maxConcurrentRuns (default 20)
// has no ceiling above it, so a fleet of agents can oversubscribe the box
// and lose runs to the OS killer (process_lost). Default of 4 matches the
// measured 4-CPU box this was built for; raise it if the box grows.
export const DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS = 4;
export const MIN_GLOBAL_MAX_CONCURRENT_RUNS = 1;
export const MAX_GLOBAL_MAX_CONCURRENT_RUNS = 200;

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

// DUR-224: "Rolig ned-bryter" -- one switch that stops every agent from
// starting new work (both the timer-wake policy.enabled and the
// event-driven policy.wakeOnDemand flags in heartbeat.ts) without touching
// runs already in flight, unlike Pause which cancels active runs. The
// snapshot lets deactivation restore each agent's exact prior flags instead
// of blanket re-enabling agents that were deliberately asleep beforehand.
export interface QuietModeActor {
  actorType: string;
  actorId: string | null;
  agentId: string | null;
}

export interface QuietModeAgentSnapshotEntry {
  agentId: string;
  companyId: string;
  enabled: boolean;
  wakeOnDemand: boolean;
}

export interface QuietModeState {
  active: boolean;
  activatedAt: string | null;
  activatedBy: QuietModeActor | null;
  deactivatedAt: string | null;
  snapshot: QuietModeAgentSnapshotEntry[] | null;
}

export const DEFAULT_QUIET_MODE_STATE: QuietModeState = {
  active: false,
  activatedAt: null,
  activatedBy: null,
  deactivatedAt: null,
  snapshot: null,
};

// How long Quiet Mode can stay active before the UI warns that it may have
// been left on by mistake. Sized above the normal overnight-quota-reset use
// case (~22h) so that expected usage never trips the warning.
export const QUIET_MODE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  /** Whole-instance ceiling on simultaneously running heartbeat runs, across every agent/company. */
  globalMaxConcurrentRuns: number;
  /** DUR-224 quiet-mode state; not settable via the general-settings patch route. */
  quietMode: QuietModeState;
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
