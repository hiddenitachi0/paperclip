// DUR-3939/DUR-3940/DUR-272/DUR-98: the fleet-health signal carried on
// /api/health (full-details responses only). Shared between the server,
// which computes it from live state on every request -- never from a cached
// "last known good" -- and the UI, which renders it on the Now page so an
// operator can tell "scheduler broken" from "every run slot is taken" from
// "server overloaded" without reading the database.

export type FleetHealthLevel = "ok" | "warning" | "critical";

export interface FleetRunCounts {
  /** Window the *InWindow counts cover, in minutes. */
  windowMinutes: number;
  startedInWindow: number;
  succeededInWindow: number;
  /** failed + timed_out. */
  failedInWindow: number;
  cancelledInWindow: number;
  running: number;
  queued: number;
  /**
   * Queued runs whose agent has no run in progress right now. Agents run one
   * at a time, so a run queued behind its own agent's running run is waiting
   * on that agent, not on the fleet; only this subset says anything about
   * whether the queue as a whole is moving.
   */
  queuedWithNoRunningAgent: number;
  /** How long the oldest queued run has been waiting, in ms (null when nothing is queued). */
  oldestQueuedWaitMs: number | null;
  /**
   * Running rows that have shown no sign of progress (output, process start,
   * run start) for at least `zombieSilenceMinutes`. Candidates, not
   * verdicts: the watchdog only ends a run once its process is confirmed gone.
   */
  zombieCandidates: number;
  zombieSilenceMinutes: number;
}

export interface FleetSlotUsage {
  /** Instance-wide ceiling (Settings > Instance settings > General > "Max concurrent runs (whole instance)"). */
  max: number;
  used: number;
  available: number;
  saturated: boolean;
}

/**
 * Who is in error and since when. Deliberately no error text: this signal
 * is instance-wide, and the free-text reason belongs on the agent's own
 * (company-scoped) page.
 */
export interface FleetAgentInErrorSample {
  id: string;
  name: string;
  companyId: string;
  errorAt: string | null;
}

export interface FleetAgentCounts {
  inError: number;
  /** Up to a handful of the agents in error, oldest episode first. */
  inErrorSample: FleetAgentInErrorSample[];
}

export interface FleetSchedulerStatus {
  enabled: boolean;
  intervalMs: number | null;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickResult: { checked: number; enqueued: number; skipped: number } | null;
  lastTickError: string | null;
  sinceLastTickMs: number | null;
  stale: boolean;
}

export interface FleetRequestLoad {
  /** Requests still waiting to answer (the ones that can pile up). */
  inFlight: number;
  /** Responses that have started and are streaming (board chat, log tails); never an alarm. */
  streaming: number;
  peakInFlight: number;
  peakInFlightAt: string | null;
  longestInFlightMs: number;
  slowInFlight: number;
  slowThresholdMs: number;
  overloadThreshold: number;
  overloaded: boolean;
  totalStarted: number;
  totalFinished: number;
}

export interface FleetDatabaseLoad {
  available: boolean;
  /** Size of this process's request-serving connection pool. */
  poolMax: number | null;
  /** Client connections open against this database (all pools, all processes). */
  connections: number | null;
  active: number | null;
  idleInTransaction: number | null;
  waitingOnLocks: number | null;
}

/**
 * DUR-3965: quiet mode freezes every agent in every company. A deploy that
 * fails while switching it on can leave it on with nothing on screen saying
 * so -- 27 minutes of complete silence on 2026-09-10. This is the part of the
 * fleet signal that makes that state impossible to mistake for "quiet night".
 */
export interface FleetQuietMode {
  active: boolean;
  activatedAt: string | null;
  /** How long it has been on, in ms (null when it is off or the time is unknown). */
  activeForMs: number | null;
  /** How long quiet mode may stay on before it is reported as stuck. */
  stuckAfterMinutes: number;
  /** Active for longer than `stuckAfterMinutes`: reported as a critical finding. */
  stuck: boolean;
  /** True when the platform can tell it was switched on as part of a deploy. */
  activatedForDeploy: boolean;
}

export interface FleetHealthSummary {
  level: FleetHealthLevel;
  /** One plain-language sentence for the strip. */
  headline: string;
  /** Further plain-language findings, most severe first. */
  notes: string[];
}

export interface FleetHealthSnapshot {
  available: true;
  computedAt: string;
  runs: FleetRunCounts;
  slots: FleetSlotUsage;
  agents: FleetAgentCounts;
  scheduler: FleetSchedulerStatus;
  requests: FleetRequestLoad;
  database: FleetDatabaseLoad;
  quietMode: FleetQuietMode;
  summary: FleetHealthSummary;
}

export interface FleetHealthUnavailable {
  available: false;
  /** Why it could not be computed -- shown to the operator, never hidden as "ok". */
  reason: string;
}

export type FleetHealth = FleetHealthSnapshot | FleetHealthUnavailable;
