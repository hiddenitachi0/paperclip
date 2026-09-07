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
  /** Instance-wide ceiling (Settings > "Max concurrent runs"). */
  max: number;
  used: number;
  available: number;
  saturated: boolean;
}

export interface FleetAgentInErrorSample {
  id: string;
  name: string;
  companyId: string;
  errorReason: string | null;
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
  inFlight: number;
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
  summary: FleetHealthSummary;
}

export interface FleetHealthUnavailable {
  available: false;
  /** Why it could not be computed -- shown to the operator, never hidden as "ok". */
  reason: string;
}

export type FleetHealth = FleetHealthSnapshot | FleetHealthUnavailable;
