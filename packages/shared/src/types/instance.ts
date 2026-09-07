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

// DUR-3940 item 2 / run cap: the watchdog's limits for runs of adapters that
// run a local child process (claude_local, codex_local, ...). Every run that
// ever passed 120 minutes in production ended failed or cancelled (12 of 12),
// and a child that is alive but has printed nothing for a long time is
// almost always stuck (waiting on input, a hung tool, a dead MCP pipe) while
// it holds its agent's only run slot. Both limits apply instance-wide and
// can be overridden per agent in adapterConfig (maxRunDurationMinutes /
// silentRunTimeoutMinutes; 0 there switches that limit off for the agent).
export const DEFAULT_MAX_RUN_DURATION_MINUTES = 150;
export const MIN_MAX_RUN_DURATION_MINUTES = 10;
export const MAX_MAX_RUN_DURATION_MINUTES = 24 * 60;
export const DEFAULT_SILENT_RUN_TIMEOUT_MINUTES = 45;
export const MIN_SILENT_RUN_TIMEOUT_MINUTES = 5;
export const MAX_SILENT_RUN_TIMEOUT_MINUTES = 12 * 60;

// DUR-3943 item 4: every turn of a run re-sends the whole standing context,
// so the turn ceiling is the single biggest multiplier on what a run can
// cost. Instance-wide default for Claude-style local agents; an agent's own
// adapterConfig.maxTurnsPerRun (when set, > 0) takes precedence. A run that
// hits the cap ends with a plain note and the work continues in a fresh run
// through the existing max-turn continuation; after three cap hits in a row
// on the same task the operator is told instead.
export const DEFAULT_MAX_TURNS_PER_RUN = 60;
export const MIN_MAX_TURNS_PER_RUN = 1;
export const MAX_MAX_TURNS_PER_RUN = 1000;

// DUR-3943 item 5: a saved (resumable) session used to be resumed forever,
// so its transcript grew without bound and every later turn paid for it.
// Instance-wide reset policy for sessioned local agents: the saved session
// is dropped after this many runs on the same task, or once it is older
// than this many hours, and the next run starts fresh with the full task
// block. 0 = never reset on that criterion. Per-agent override:
// runtimeConfig.heartbeat.sessionCompaction.{maxSessionRuns,maxSessionAgeHours}.
export const DEFAULT_SESSION_RESET_AFTER_RUNS = 8;
export const MIN_SESSION_RESET_AFTER_RUNS = 0;
export const MAX_SESSION_RESET_AFTER_RUNS = 1000;
export const DEFAULT_SESSION_RESET_AFTER_HOURS = 24;
export const MIN_SESSION_RESET_AFTER_HOURS = 0;
export const MAX_SESSION_RESET_AFTER_HOURS = 24 * 30;

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

/**
 * Done-gate quality check ("critic"): when an AGENT tries to move a task to
 * done, a second, cheap model call compares the task's description and
 * acceptance criteria against the agent's final comment (and the change
 * summary when a merge was involved) and answers pass / needs work.
 *
 * - "off": nothing happens (the default -- ships dormant).
 * - "dry_run": the check runs and its verdict is posted as a comment, but the
 *   task is never held back. Use this to see what the critic would say.
 * - "enforce": a "needs work" verdict sends the task back to in progress with
 *   the findings as a comment. After `maxRounds` such rounds the platform
 *   stops looping and asks the operator instead.
 *
 * A board/human actor is never gated, whatever the mode.
 */
export type DoneGateMode = "off" | "dry_run" | "enforce";

export const DONE_GATE_MODES: readonly DoneGateMode[] = ["off", "dry_run", "enforce"];
export const DEFAULT_DONE_GATE_MODE: DoneGateMode = "off";
export const DEFAULT_DONE_GATE_MAX_ROUNDS = 2;
export const MIN_DONE_GATE_MAX_ROUNDS = 1;
export const MAX_DONE_GATE_MAX_ROUNDS = 5;

export interface DoneGateCompanyOverride {
  mode?: DoneGateMode;
  maxRounds?: number;
}

export interface DoneGateSettings {
  mode: DoneGateMode;
  /** How many "needs work" rounds an agent gets before the operator is asked. */
  maxRounds: number;
  /** Per-company override keyed by company id; absent keys fall back to the instance default. */
  companyOverrides: Record<string, DoneGateCompanyOverride>;
}

export const DEFAULT_DONE_GATE_SETTINGS: DoneGateSettings = {
  mode: DEFAULT_DONE_GATE_MODE,
  maxRounds: DEFAULT_DONE_GATE_MAX_ROUNDS,
  companyOverrides: {},
};

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
  /**
   * DUR-3940 item 2: a run of a local child-process adapter that has been
   * going this long without finishing is stopped by the watchdog, marked
   * failed and retried once. Per-agent override: adapterConfig.maxRunDurationMinutes.
   */
  maxRunDurationMinutes: number;
  /**
   * DUR-3940 item 2: a run whose child process is alive but has produced no
   * output for this long is stopped the same way. Per-agent override:
   * adapterConfig.silentRunTimeoutMinutes.
   */
  silentRunTimeoutMinutes: number;
  /**
   * DUR-3943 item 4: turn ceiling for one run of a Claude-style local agent.
   * Per-agent override: adapterConfig.maxTurnsPerRun (> 0 wins).
   */
  maxTurnsPerRun: number;
  /**
   * DUR-3943 item 5: drop an agent's saved session after this many runs on
   * the same task (0 = never on this criterion). Per-agent override:
   * runtimeConfig.heartbeat.sessionCompaction.maxSessionRuns.
   */
  sessionResetAfterRuns: number;
  /**
   * DUR-3943 item 5: drop an agent's saved session once it is older than
   * this many hours (0 = never on this criterion). Per-agent override:
   * runtimeConfig.heartbeat.sessionCompaction.maxSessionAgeHours.
   */
  sessionResetAfterHours: number;
  /** DUR-224 quiet-mode state; not settable via the general-settings patch route. */
  quietMode: QuietModeState;
  /**
   * DUR-299 point 6 / DUR-314: live kill switch for the delegated
   * merge_pr-approval automation. Defaults to false -- ships dormant, an
   * operator opts in via a normal general-settings PATCH.
   */
  mergePrAutomationEnabled: boolean;
  /**
   * DUR-411: when true, the reassuring "fact check" card is only shown for
   * confirmations that are positively recognised as a fact check (on top of
   * the existing decision-verb denylist). Defaults to false = current
   * behaviour; turning it on can only make the UI stricter.
   */
  factCheckCardStrictAllowlist: boolean;
  /**
   * Done-gate quality check (see DoneGateSettings). Defaults to mode "off"
   * with 2 rounds -- ships dormant; an operator opts in per instance and can
   * override per company.
   */
  doneGate: DoneGateSettings;
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
  /** DUR-62: run the weekly check-up for every active company on a schedule. */
  enableWeeklyCheckup: boolean;
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
