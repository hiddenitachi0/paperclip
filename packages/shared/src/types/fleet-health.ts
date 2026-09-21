// DUR-3939/DUR-3940/DUR-272/DUR-98: the fleet-health signal carried on
// /api/health (full-details responses only). Shared between the server,
// which computes it from live state on every request -- never from a cached
// "last known good" -- and the UI, which renders it on the Now page so an
// operator can tell "scheduler broken" from "every run slot is taken" from
// "server overloaded" without reading the database.

import type { AssigneeUnavailableReason } from "../assignee-pickup.js";

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

/**
 * DUR-3991: which step of the scheduler is currently stuck, in words the
 * operator can act on. Deliberately carries no internal chain name -- the
 * server resolves the label before this ever leaves it.
 */
export interface FleetSchedulerStuckChain {
  /** Plain language, e.g. "waking agents on their timers". */
  label: string;
  /** How long that step has been running without returning. */
  runningMs: number;
  /**
   * true once the server has already given up on one copy of this step and
   * started a fresh one, and that one is stuck too -- at which point only a
   * restart will clear it.
   */
  freshAttemptAlreadyTried: boolean;
  /** How long the server waits before starting a fresh attempt by itself. */
  freshAttemptAfterMs: number;
  /**
   * DUR-3991: true when the server will NOT start another fresh attempt by
   * itself (its bounded rescue budget is spent), so only a restart clears it.
   * Absent from older servers: fall back to freshAttemptAlreadyTried.
   */
  restartNeeded?: boolean;
}

/** DUR-3991: one timed step of a scheduler tick. */
export interface FleetSchedulerPhaseTiming {
  /** Internal step name, for diagnosis (e.g. "loadAgents"). */
  phase: string;
  /** The same step in plain words, for the operator. */
  label: string;
  /** Total ms spent in that step. */
  ms: number;
}

/**
 * DUR-3991: the most recent time the scheduler watchdog gave up on a stuck
 * step and started it again -- and where that step was stuck, read from inside
 * it at the moment it was abandoned.
 */
export interface FleetSchedulerRescue {
  at: string;
  /** Plain-language name of the scheduler step that got stuck. */
  label: string;
  /** How long it had been running when it was given up on. */
  runningMs: number;
  /** false when this step does not time its phases at all. */
  phasesMeasured: boolean;
  /** Internal name of the phase it was stuck in, or null when none was measured. */
  stuckPhase: string | null;
  /** That phase in plain words. */
  stuckPhaseLabel: string;
  /** How long it had been in that phase. */
  stuckPhaseMs: number | null;
  /** Phases that had finished before it got stuck, slowest first. */
  completedPhases: FleetSchedulerPhaseTiming[];
  /** Phases still in progress when it was abandoned, outermost first. */
  openPhases: FleetSchedulerPhaseTiming[];
}

/** DUR-3991: the scheduler watchdog's bounded automatic restarts. */
export interface FleetSchedulerRescues {
  last: FleetSchedulerRescue | null;
  /** Automatic restarts since the server started. */
  total: number;
  /** Given-up-on runs that have still not returned (each may hold a database connection). */
  abandonedStillRunning: number;
  /** The most of those the server tolerates before it stops restarting anything. */
  maxAbandonedStillRunning: number;
  /** How many automatic restarts one step may get per hour. */
  maxPerStepPerHour: number;
  /**
   * Plain-language names of steps that are stuck right now and will not be
   * restarted automatically again: a server restart is needed.
   */
  restartNeededFor: string[];
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
  /** DUR-3991: the step that is holding the scheduler up, when one is. */
  stuckChain?: FleetSchedulerStuckChain | null;
  /** DUR-3991: the slowest step of the last completed timer tick. */
  lastTickSlowestPhase?: FleetSchedulerPhaseTiming | null;
  /** DUR-3991: the watchdog's automatic restarts, and the last one. */
  rescues?: FleetSchedulerRescues | null;
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
  /**
   * Why it was switched on, as recorded at activation time ("deploy",
   * "manual", ...). Null for state written before the reason was recorded.
   */
  activatedReason: string | null;
  /**
   * How long THIS quiet mode may stay on before it is surfaced -- half an
   * hour for a deploy's drain (nobody chose that silence), the full 24h
   * convention for one a person switched on deliberately.
   */
  stuckAfterMinutes: number;
  /** On for longer than `stuckAfterMinutes`. */
  stuck: boolean;
  /**
   * True when a DEPLOY switched it on. Decides both the wording and the
   * severity: a deploy that never lifted its own drain is a critical
   * incident, a person's quiet mode is at most a warning.
   */
  activatedForDeploy: boolean;
}

/** One agent that cannot pick up its assigned work, and how much is waiting on it. */
export interface FleetUnavailableAgentSample {
  id: string;
  name: string;
  companyId: string;
  /** Open (todo / in progress) tasks assigned to it. */
  tasks: number;
  reason: AssigneeUnavailableReason;
}

/**
 * DUR-3973: open tasks assigned to agents that cannot pick them up (paused,
 * switched off, terminated, ...), counted live. The at-a-glance answer to
 * "is anything just sitting there?" -- one line instead of one alarm per
 * task. Quiet mode and paused/archived companies are not counted: they have
 * their own signals.
 */
export interface FleetWaitingOnUnavailableAgents {
  tasks: number;
  /** Agents that cannot pick up work AND have at least one open task. */
  agents: number;
  /** The agents with the most waiting tasks first, a handful at most. */
  sample: FleetUnavailableAgentSample[];
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
  waitingOnUnavailableAgents: FleetWaitingOnUnavailableAgents;
  summary: FleetHealthSummary;
}

export interface FleetHealthUnavailable {
  available: false;
  /** Why it could not be computed -- shown to the operator, never hidden as "ok". */
  reason: string;
}

export type FleetHealth = FleetHealthSnapshot | FleetHealthUnavailable;
