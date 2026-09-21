// DUR-385 (finding 3 of the DUR-382 security review of PR #210): stop a slow
// scheduler tick chain from being started a second time while the first one is
// still running.
//
// The problem
// -----------
// Every chain in the heartbeat scheduler loop (server/src/index.ts) is
// dispatched fire-and-forget: `void runInCompanyScopeBypass(...)`, never
// awaited before the next `setInterval` fire. Since DUR-352 each of those
// chains reserves ONE physical connection from the dedicated `bypassDb` pool
// (postgres.js `sql.reserve()`) and holds it for the whole chain -- including
// the periodic recovery pipeline, which is an eight-step sequence under a
// single reservation.
//
// Nothing gated re-entry. If a chain ran longer than one tick interval
// (`config.heartbeatSchedulerIntervalMs`, 10s floor / 30s default), the next
// tick started the SAME chain again and reserved a SECOND connection while the
// first was still held. The pool cap is 10 (packages/db/src/client.ts,
// `DEFAULT_APP_POOL_MAX`), and postgres.js's `reserve()` awaits a promise with
// no timeout when the pool is exhausted -- it does not fail, it hangs forever.
// So one slow chain could, by repeating, take every connection in the bypass
// pool and stall acquisition for every other independent chain sharing it.
//
// What this does
// --------------
// One flag per chain. A tick whose previous invocation of the SAME chain has
// not settled is skipped -- never queued, so skipped work simply happens on
// the next tick instead of piling up. Chains are completely independent of
// each other: a wedged chain can never delay a different one.
//
// FAIL-SAFE, on purpose: the flag is cleared in a `finally`, so a chain that
// throws (or rejects) is running again on the very next tick. The alternative
// failure mode -- one exception silencing a chain until the next restart --
// would be far worse than the overlap this guard prevents. `run()` itself
// never rejects, so `void guard.run(...)` cannot produce an unhandled
// rejection.
//
// Skips are visible but never spammy: the first skip of a chain is always
// logged, and after that at most one line per minute per chain, carrying how
// long the in-flight run has been going and how many skips that line covers.
//
// DUR-3991: the watchdog
// ----------------------
// On 2026-09-17 `tickTimers` did not return, and because the guard above only
// ever skips, it skipped for as long as the operator left it -- 150 seconds and
// climbing, with the Now page saying the scheduler had never completed a tick
// and no agent being woken by anything. A restart cleared it. "Skip forever"
// is the wrong end state: a guard that protects the connection pool by leaving
// the whole fleet asleep has traded a survivable problem for a fatal one.
//
// So: once a chain has been in flight for WEDGED_AFTER_MS, the next tick starts
// a fresh copy anyway and abandons the old one. That deliberately breaks the
// DUR-385 invariant -- for a while, two copies of that chain exist. Why that is
// the lesser evil past the limit:
//   * The thing DUR-385 prevents is UNBOUNDED overlap: a chain slower than the
//     tick interval starting a new copy every 30s until the bypass pool (cap 10)
//     is gone. This override is bounded (see the follow-up note below for the
//     exact bounds), and the fresh copy holds the flag from the moment it
//     starts, so the normal skip rules apply again immediately.
//   * Five minutes is ten missed ticks. A chain that has not returned in ten
//     ticks is not "slow this time"; the overlap risk of one extra copy is
//     smaller than the certainty of a fleet that wakes nobody.
//   * Once a bound refuses another rescue, the guard goes back to skipping and
//     says loudly, in the log and on the Now page, that the server needs
//     restarting. Budget frees up again if an abandoned run ever does return.
// The override is logged once per wedge, at error level, as a wedged chain --
// never as one of the routine skip lines.
//
// DUR-3991 (follow-up): more than one rescue, but bounded
// ---------------------------------------------------------
// The first version allowed exactly ONE rescue per chain until an abandoned run
// settled. On production that single rescue was spent on 2026-09-18 and never
// given back (the abandoned tick never returned), so a second hang would have
// silently stopped every scheduled wake-up until someone restarted the server.
// A cap of one per server life is too tight; no cap at all would be wrong too.
// What an abandoned run can still be holding, established from the code:
//   * ONE reserved connection from the bypass pool (runInCompanyScopeBypass in
//     packages/db/src/company-scope.ts reserves it before the chain's work and
//     only releases it in its `finally` -- which a promise that never settles
//     never reaches). Possibly with a BEGIN/SAVEPOINT open on it, so possibly
//     row locks too. This is the resource that matters. If the run is hung in
//     `reserve()` itself it holds no connection yet, just a place in the
//     pool's wait queue, and will run to completion once it gets one.
//   * Company-scope turn bookkeeping (reserved-scope-turns.ts): per reserved
//     connection, keyed by that connection's scopedDb, so it cannot block any
//     other chain, and every turn wait gives up after 60s anyway.
//   * Nothing else process-wide: no global lock, no run slot, no timer that
//     keeps firing (the phase deadlines are unref'd one-shots).
// So the bound is on abandoned-and-still-unsettled runs ACROSS ALL CHAINS,
// because they all share one bypass pool: see maxAbandonedInFlightFor(). On top
// of that, a per-chain rate limit (MAX_RESCUES_PER_CHAIN_PER_WINDOW in any
// RESCUE_WINDOW_MS) so a chain that wedges on every run is called what it is --
// systemic -- instead of being quietly restarted every five minutes forever,
// each time leaving another transaction's locks behind for minutes. When either
// bound refuses a rescue the guard goes back to skipping, logs loudly, and
// fleet health says plainly that the server needs a restart.
//
// Every rescue also records WHERE the abandoned run was stuck: the chain runs
// with a TickPhaseProbe (scheduler-tick-phases.ts), so the in-flight tick's
// current phase and its phase timings so far are read at the moment it is
// abandoned, logged in one line, and kept as `lastRescue` for fleet health.
// Before this, step timings were only ever reported when a tick COMPLETED --
// and a hung tick never completes, so the stuck step had never been named.

import type {
  FleetSchedulerPhaseTiming,
  FleetSchedulerRescues,
  FleetSchedulerStuckChain,
} from "@paperclipai/shared";
import { getAppPoolMax } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  createTickPhaseProbe,
  describeTickPhase,
  describeTickPhases,
  runWithTickPhaseProbe,
  type OpenTickPhase,
  type TickPhaseProbe,
  type TickPhaseTiming,
} from "./scheduler-tick-phases.js";

/**
 * Every fire-and-forget tick chain in server/src/index.ts, in one place.
 *
 * DUR-327 ("two lists that must agree, with nothing enforcing it, is the
 * recurring bug"): this list and the real call sites are held together by
 * server/src/__tests__/scheduler-tick-guard-coverage.test.ts, which reads
 * index.ts and fails if a chain is added, renamed or removed without being
 * guarded here. The names match the `heartbeat-scheduler:<name>` route each
 * call site already declares.
 */
export const SCHEDULER_TICK_CHAINS = [
  "tickTimers",
  "tickScheduledTriggers",
  "mergeDeployVisibility",
  "deployApprovalFeedback",
  "deployCarriedIssues",
  "mergePrAutomation",
  "agentErrorAlerts",
  "quietModeAlerts",
  "untrackedWriteAlerts",
  "personaPublisherSweep",
  "issueThreadInteractionsAbandonment",
  "modelBoostBossReviewTimeouts",
  "environmentCustomImagesCleanup",
  "periodicRecoveryPipeline",
  "organizationCheckups",
  "adminAuthCheck",
  "claudeAuthCheck",
] as const;

export type SchedulerTickChain = (typeof SCHEDULER_TICK_CHAINS)[number];

/** Named accessor so call sites read `SCHEDULER_TICK_CHAIN.tickTimers`, not a bare string. */
export const SCHEDULER_TICK_CHAIN = Object.fromEntries(
  SCHEDULER_TICK_CHAINS.map((chain) => [chain, chain]),
) as { readonly [K in SchedulerTickChain]: K };

/**
 * DUR-3991: the chains whose work runs inside withTickPhases(), so the watchdog
 * can tell "stuck before its first timed step" (almost always the connection
 * wait in runInCompanyScopeBypass, which runs BEFORE the recorder opens) from
 * "this chain times nothing". scheduler-tick-single-flight.test.ts checks this
 * set against the real withTickPhases() call sites.
 */
export const TICK_PHASE_TIMED_CHAINS: ReadonlySet<SchedulerTickChain> = new Set<SchedulerTickChain>(["tickTimers"]);

/**
 * Plain-language name for each chain, for anything an operator reads.
 *
 * Filip is not a developer: "tickTimers" tells him nothing, and rule 7 of the
 * house rules says operator text never carries an internal identifier. These
 * are the words the Now page uses when a chain is stuck.
 *
 * Typed as a Record over the chain union, so TypeScript itself fails the build
 * if a chain is added without a label -- and
 * server/src/__tests__/scheduler-tick-single-flight.test.ts enumerates
 * SCHEDULER_TICK_CHAINS and asserts every one has a label that is not just its
 * internal name (the "two lists that must agree" rule).
 */
export const SCHEDULER_TICK_CHAIN_LABELS: Record<SchedulerTickChain, string> = {
  tickTimers: "waking agents on their timers",
  tickScheduledTriggers: "starting scheduled jobs",
  mergeDeployVisibility: "following merges and deploys",
  deployApprovalFeedback: "following up on deploy approvals",
  deployCarriedIssues: "checking which tasks a deploy carried",
  mergePrAutomation: "merging finished pull requests",
  agentErrorAlerts: "reporting agent errors",
  quietModeAlerts: "watching quiet mode",
  untrackedWriteAlerts: "watching for untracked file changes",
  personaPublisherSweep: "publishing agent profiles",
  issueThreadInteractionsAbandonment: "closing abandoned task conversations",
  modelBoostBossReviewTimeouts: "chasing overdue boss reviews",
  environmentCustomImagesCleanup: "cleaning up unused environment images",
  periodicRecoveryPipeline: "recovering stuck work",
  organizationCheckups: "checking company setups",
  adminAuthCheck: "checking the admin sign-in",
  claudeAuthCheck: "checking the Claude sign-in",
};

/** At most one skip line per chain per minute, however often it skips. */
export const SKIP_LOG_INTERVAL_MS = 60_000;

/**
 * How long a chain may be in flight before the next tick starts a fresh copy
 * anyway and abandons it (see the DUR-3991 note at the top of this file).
 *
 * Five minutes = ten missed ticks at the 30s default interval, or thirty at the
 * 10s floor. Chosen deliberately:
 *   * Well above any honest slow tick. The slowest real `tickTimers` measured
 *     after a restart (the cold-cache, everyone-is-due worst case) was under a
 *     minute; five minutes leaves five times that much headroom, so a busy
 *     night never trips it.
 *   * Well below the point where the operator gives up and restarts the server.
 *     The 2026-09-17 incident was restarted by hand at ~2.5 minutes; anything
 *     longer than five and the watchdog is slower than the human it replaces.
 *   * Long enough that the abandoned run has genuinely stopped making progress,
 *     so the copy is not racing a run that was about to finish.
 */
export const WEDGED_AFTER_MS = 5 * 60_000;

/**
 * The rolling window the per-chain rescue rate is counted over.
 */
export const RESCUE_WINDOW_MS = 60 * 60_000;

/**
 * How many times one chain may be rescued within any RESCUE_WINDOW_MS.
 *
 * Three an hour. A genuine one-off hang (the 2026-09-17/18 shape: the first
 * tick after a start) needs one; a second unrelated hang in the same hour is
 * plausible; a third is already a pattern. A chain wedging more often than that
 * is broken in a way a fresh copy will not fix, and every abandoned copy may be
 * sitting on an open transaction's row locks for as long as it hangs -- so past
 * this the guard stops restarting it and asks for a server restart instead.
 * With WEDGED_AFTER_MS at five minutes, three rescues also mean at most fifteen
 * minutes of a stuck chain per hour before a human is told a restart is needed.
 */
export const MAX_RESCUES_PER_CHAIN_PER_WINDOW = 3;

/**
 * How many abandoned-and-still-unsettled runs may exist at once, across EVERY
 * chain, for a bypass pool of `poolMax` connections.
 *
 * An abandoned run that never settles keeps its reserved bypass connection for
 * the life of the process (see the note at the top of this file). Every chain
 * in SCHEDULER_TICK_CHAINS -- seventeen of them -- reserves from that same pool
 * (`createDb` in index.ts, sized by getAppPoolMax(): 10 by default, or
 * PAPERCLIP_DB_POOL_MAX). postgres.js's reserve() waits without a timeout when
 * the pool is empty, so the one outcome that must be impossible is abandoned
 * runs pinning EVERY connection: then no chain could ever start again.
 *
 * So: at most a third of the pool, and never more than three. With the default
 * pool of 10 that is 3 pinned connections and 7 left for the live chains --
 * which already share 10 between seventeen chains by queueing briefly in
 * reserve(), so losing three slows the queue, it does not stop it. The floor of
 * one keeps the original single rescue on a tiny pool (the pre-existing
 * behaviour, which was already reviewed as safe). The budget is given back
 * whenever an abandoned run does settle.
 */
export function maxAbandonedInFlightFor(poolMax: number): number {
  if (!Number.isFinite(poolMax) || poolMax < 1) return 1;
  return Math.max(1, Math.min(3, Math.floor(poolMax / 3)));
}

/** Why the watchdog declined to rescue a wedged chain. */
export type SchedulerRescueRefusal = "chain_rescued_too_often" | "too_many_abandoned_runs";

/**
 * DUR-3991: the most recent rescue, kept in memory so fleet health can say
 * where the scheduler got stuck even though the stuck tick never reported.
 */
export interface SchedulerRescueRecord {
  /** When the watchdog abandoned the run (epoch ms). */
  at: number;
  chain: SchedulerTickChain;
  /** Plain-language name of the chain. */
  label: string;
  /** How long the abandoned run had been in flight. */
  runningMs: number;
  /**
   * The phase the run was in when it was abandoned (see
   * InFlightTickPhases.currentPhase), or null when none was measured.
   */
  stuckPhase: string | null;
  stuckPhaseMs: number | null;
  /** false when the chain never opened a phase recorder at all. */
  phasesMeasured: boolean;
  openPhases: OpenTickPhase[];
  completedPhases: TickPhaseTiming[];
}

export interface SchedulerTickChainSnapshot {
  chain: SchedulerTickChain;
  /** Plain-language name of this chain, for operator-facing text. */
  label: string;
  /** true while a previous invocation is still in flight. */
  inFlight: boolean;
  /** How long the in-flight run has been going, or null when idle. */
  runningMs: number | null;
  /** Duration of the last completed run, or null when none has completed. */
  lastRunMs: number | null;
  /** Total ticks skipped for this chain since the process started. */
  skipsTotal: number;
  /** Times the watchdog started a fresh copy and abandoned a wedged run. */
  overridesTotal: number;
  /** This chain's abandoned runs that have still never settled. */
  abandonedInFlight: number;
  /** Rescues of this chain within the last RESCUE_WINDOW_MS. */
  rescuesInWindow: number;
  /**
   * Set when the chain is wedged past WEDGED_AFTER_MS and the watchdog will
   * NOT rescue it (a bound is spent): only a server restart clears it.
   */
  rescueRefused: SchedulerRescueRefusal | null;
}

/** Process-wide watchdog state for fleet health. */
export interface SchedulerRescueDiagnostics {
  lastRescue: SchedulerRescueRecord | null;
  rescuesTotal: number;
  /** Abandoned runs, across every chain, that have still never settled. */
  abandonedInFlightTotal: number;
  maxAbandonedInFlight: number;
  maxRescuesPerChainPerWindow: number;
  rescueWindowMs: number;
}

interface ChainState {
  startedAt: number | null;
  /**
   * Identifies the run that currently holds the flag. An abandoned run's
   * `finally` must not clear the flag its replacement now owns, so every
   * settle checks its own id against this one first.
   */
  runId: number | null;
  skipsTotal: number;
  /** Skips not yet mentioned in a log line (reset every time one is written). */
  skipsSinceLastLog: number;
  /** Skips caused by the currently in-flight run (reset when a run starts). */
  skipsThisRun: number;
  lastSkipLoggedAt: number | null;
  lastRunMs: number | null;
  overridesTotal: number;
  abandonedInFlight: number;
  /** When each rescue of this chain happened, pruned to RESCUE_WINDOW_MS. */
  rescueTimes: number[];
  /** Probe for the run that currently holds the flag. */
  probe: TickPhaseProbe | null;
}

/** Just the logger surface this module uses, so tests can capture the lines. */
export interface TickSingleFlightLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface TickSingleFlightOptions {
  now?: () => number;
  log?: TickSingleFlightLogger;
  /** Size of the bypass pool the chains reserve from; defaults to getAppPoolMax(). */
  bypassPoolMax?: number;
}

export function createSchedulerTickSingleFlight(options: TickSingleFlightOptions = {}) {
  const nowFn = options.now ?? (() => Date.now());
  const log = options.log ?? (logger as unknown as TickSingleFlightLogger);
  const states = new Map<string, ChainState>();
  let nextRunId = 1;
  let poolMax = options.bypassPoolMax;
  if (poolMax === undefined) {
    try {
      poolMax = getAppPoolMax();
    } catch {
      poolMax = 10;
    }
  }
  const maxAbandonedInFlight = maxAbandonedInFlightFor(poolMax);
  /** Abandoned runs, across every chain, that have not settled yet. */
  let abandonedInFlightTotal = 0;
  let rescuesTotal = 0;
  let lastRescue: SchedulerRescueRecord | null = null;

  function pruneRescues(state: ChainState, now: number): void {
    while (state.rescueTimes.length > 0 && now - state.rescueTimes[0]! >= RESCUE_WINDOW_MS) {
      state.rescueTimes.shift();
    }
  }

  /** null = a rescue is allowed right now; otherwise why not. */
  function rescueRefusal(state: ChainState, now: number): SchedulerRescueRefusal | null {
    pruneRescues(state, now);
    if (abandonedInFlightTotal >= maxAbandonedInFlight) return "too_many_abandoned_runs";
    if (state.rescueTimes.length >= MAX_RESCUES_PER_CHAIN_PER_WINDOW) return "chain_rescued_too_often";
    return null;
  }

  function describeRefusal(refusal: SchedulerRescueRefusal): string {
    return refusal === "too_many_abandoned_runs"
      ? `${abandonedInFlightTotal} abandoned scheduler ${abandonedInFlightTotal === 1 ? "run is" : "runs are"} still ` +
          `holding on to the database (the limit is ${maxAbandonedInFlight})`
      : `it has already been restarted ${MAX_RESCUES_PER_CHAIN_PER_WINDOW} times in the last hour`;
  }

  function stateFor(chain: SchedulerTickChain): ChainState {
    let state = states.get(chain);
    if (!state) {
      state = {
        startedAt: null,
        runId: null,
        skipsTotal: 0,
        skipsSinceLastLog: 0,
        skipsThisRun: 0,
        lastSkipLoggedAt: null,
        lastRunMs: null,
        overridesTotal: 0,
        abandonedInFlight: 0,
        rescueTimes: [],
        probe: null,
      };
      states.set(chain, state);
    }
    return state;
  }

  function logSkipIfDue(chain: SchedulerTickChain, state: ChainState, now: number): void {
    const isFirstEver = state.lastSkipLoggedAt === null;
    if (!isFirstEver && now - state.lastSkipLoggedAt! < SKIP_LOG_INTERVAL_MS) return;

    const runningMs = state.startedAt === null ? 0 : now - state.startedAt;
    const skippedTicks = state.skipsSinceLastLog;
    state.skipsSinceLastLog = 0;
    state.lastSkipLoggedAt = now;

    const fields = {
      chain,
      runningMs,
      runningMinutes: Math.floor(runningMs / 60_000),
      skippedTicks,
      skipsTotal: state.skipsTotal,
      overridesTotal: state.overridesTotal,
      abandonedInFlight: state.abandonedInFlight,
    };

    // Past WEDGED_AFTER_MS the watchdog would normally have started a fresh
    // copy, so reaching here means a rescue bound refused it: nothing else
    // will clear this chain.
    if (runningMs >= WEDGED_AFTER_MS) {
      const refusal = rescueRefusal(state, now) ?? "chain_rescued_too_often";
      log.error(
        { ...fields, rescueRefused: refusal, rescuesInWindow: state.rescueTimes.length, abandonedInFlightTotal },
        `scheduler chain "${chain}" has been running for ${Math.floor(runningMs / 60_000)} minutes and will not be ` +
          `restarted automatically again because ${describeRefusal(refusal)} — this server needs restarting`,
      );
      return;
    }

    log.warn(fields, `scheduler chain "${chain}" is still running from an earlier tick — skipping this tick`);
  }

  /**
   * Run `start` unless this chain's previous invocation is still in flight, in
   * which case the tick is skipped (not queued). Never rejects.
   */
  async function run(chain: SchedulerTickChain, start: () => unknown | Promise<unknown>): Promise<void> {
    const state = stateFor(chain);
    const now = nowFn();

    if (state.startedAt !== null) {
      const runningMs = now - state.startedAt;
      const wedged = runningMs >= WEDGED_AFTER_MS;
      const mayOverride = wedged && rescueRefusal(state, now) === null;

      if (!mayOverride) {
        state.skipsTotal += 1;
        state.skipsSinceLastLog += 1;
        state.skipsThisRun += 1;
        logSkipIfDue(chain, state, now);
        return;
      }

      // DUR-3991: abandon the wedged run and fall through to start a fresh
      // copy. The old run keeps its own `runId`, so if it ever settles its
      // `finally` will see the flag has moved on and leave it alone.
      state.overridesTotal += 1;
      state.abandonedInFlight += 1;
      state.rescueTimes.push(now);
      abandonedInFlightTotal += 1;
      rescuesTotal += 1;

      // Where was it stuck? Read live from the run's own phase recorder --
      // the only moment this can be known, since the run will never report.
      // Diagnostics must never block the rescue itself: fail open.
      let inFlight = null as ReturnType<TickPhaseProbe["read"]>;
      try {
        inFlight = state.probe?.read() ?? null;
      } catch {
        inFlight = null;
      }
      lastRescue = {
        at: now,
        chain,
        label: SCHEDULER_TICK_CHAIN_LABELS[chain],
        runningMs,
        stuckPhase: inFlight?.currentPhase ?? null,
        stuckPhaseMs: inFlight?.currentPhaseMs ?? null,
        phasesMeasured: inFlight !== null,
        openPhases: inFlight?.openPhases ?? [],
        completedPhases: inFlight?.completedPhases ?? [],
      };
      const done = inFlight
        ? describeTickPhases({ totalMs: inFlight.elapsedMs, phases: inFlight.completedPhases, slowest: inFlight.completedPhases[0] ?? null })
        : null;
      let where: string;
      if (!inFlight) {
        where = "its steps are not timed";
      } else {
        const stuckAt = inFlight.currentPhase
          ? `stuck in phase "${inFlight.currentPhase}" for ${inFlight.currentPhaseMs}ms`
          : "no timed phase in progress";
        const open =
          inFlight.openPhases.length > 1
            ? `; open: ${inFlight.openPhases.map((p) => `${p.phase} ${p.runningMs}ms`).join(" > ")}`
            : "";
        where = `${stuckAt}${open}; finished: ${done}`;
      }
      log.error(
        {
          chain,
          runningMs,
          runningMinutes: Math.floor(runningMs / 60_000),
          skippedTicks: state.skipsThisRun,
          skipsTotal: state.skipsTotal,
          overridesTotal: state.overridesTotal,
          abandonedInFlight: state.abandonedInFlight,
          abandonedInFlightTotal,
          maxAbandonedInFlight,
          rescuesInWindow: state.rescueTimes.length,
          maxRescuesPerChainPerWindow: MAX_RESCUES_PER_CHAIN_PER_WINDOW,
          wedgedAfterMs: WEDGED_AFTER_MS,
          stuckPhase: lastRescue.stuckPhase,
          stuckPhaseMs: lastRescue.stuckPhaseMs,
          openPhases: lastRescue.openPhases,
          completedPhases: done,
        },
        `scheduler chain "${chain}" has been wedged for ${Math.floor(runningMs / 60_000)} minutes (${where}) — ` +
          "abandoning it and starting a fresh copy so the fleet keeps moving " +
          `(rescue ${state.rescueTimes.length} of ${MAX_RESCUES_PER_CHAIN_PER_WINDOW} this hour for this chain; ` +
          `${abandonedInFlightTotal} of ${maxAbandonedInFlight} abandoned runs still unsettled)`,
      );
      // The replacement owns the flag from here; the wedged run is off the books.
      state.startedAt = null;
      state.runId = null;
      state.probe = null;
    }

    const runId = nextRunId++;
    const probe = createTickPhaseProbe({ expectsTick: TICK_PHASE_TIMED_CHAINS.has(chain), now: nowFn });
    state.startedAt = now;
    state.runId = runId;
    state.probe = probe;
    state.skipsThisRun = 0;
    try {
      await runWithTickPhaseProbe(probe, start);
    } catch (err) {
      // The call sites in index.ts already .catch() and log their own failure;
      // this is the backstop for anything that escapes (a synchronous throw
      // before the chain is even built, say). The `finally` below is what
      // actually matters: without it one exception would wedge this chain
      // until the next restart.
      log.error({ err, chain }, `scheduler chain "${chain}" failed — it will be tried again on the next tick`);
    } finally {
      const finishedAt = nowFn();
      const runMs = finishedAt - now;

      if (state.runId !== runId) {
        // DUR-3991: this run was abandoned by the watchdog and a replacement
        // has owned the flag since. It must not clear that replacement's flag
        // or claim its skip count -- all it does is hand back the abandoned
        // budget, since the thing that was stuck is demonstrably unstuck.
        if (state.abandonedInFlight > 0) state.abandonedInFlight -= 1;
        if (abandonedInFlightTotal > 0) abandonedInFlightTotal -= 1;
        log.info(
          { chain, runMs, abandonedInFlight: state.abandonedInFlight, abandonedInFlightTotal },
          `scheduler chain "${chain}" finally returned after ${runMs}ms, long after it was given up on`,
        );
      } else {
        state.startedAt = null;
        state.runId = null;
        state.probe = null;
        state.lastRunMs = runMs;
        if (state.skipsThisRun > 0) {
          log.info(
            { chain, runMs, skippedTicks: state.skipsThisRun },
            `scheduler chain "${chain}" finished after ${runMs}ms and is accepting ticks again`,
          );
        }
        state.skipsThisRun = 0;
      }
    }
  }

  function snapshot(): SchedulerTickChainSnapshot[] {
    const now = nowFn();
    return SCHEDULER_TICK_CHAINS.map((chain) => {
      const state = states.get(chain);
      const runningMs = state?.startedAt != null ? now - state.startedAt : null;
      const rescueRefused =
        state && runningMs !== null && runningMs >= WEDGED_AFTER_MS ? rescueRefusal(state, now) : null;
      return {
        chain,
        label: SCHEDULER_TICK_CHAIN_LABELS[chain],
        inFlight: state?.startedAt != null,
        runningMs: state?.startedAt != null ? now - state.startedAt : null,
        lastRunMs: state?.lastRunMs ?? null,
        skipsTotal: state?.skipsTotal ?? 0,
        overridesTotal: state?.overridesTotal ?? 0,
        abandonedInFlight: state?.abandonedInFlight ?? 0,
        rescuesInWindow: state?.rescueTimes.length ?? 0,
        rescueRefused,
      };
    });
  }

  function diagnostics(): SchedulerRescueDiagnostics {
    return {
      lastRescue,
      rescuesTotal,
      abandonedInFlightTotal,
      maxAbandonedInFlight,
      maxRescuesPerChainPerWindow: MAX_RESCUES_PER_CHAIN_PER_WINDOW,
      rescueWindowMs: RESCUE_WINDOW_MS,
    };
  }

  /** Test-only: forget every chain's state. */
  function reset(): void {
    states.clear();
    abandonedInFlightTotal = 0;
    rescuesTotal = 0;
    lastRescue = null;
  }

  return { run, snapshot, diagnostics, reset };
}

export type SchedulerTickSingleFlight = ReturnType<typeof createSchedulerTickSingleFlight>;

/**
 * DUR-3991: the one chain worth naming on the Now page when the scheduler has
 * stopped completing ticks -- the longest-running one, and only once it has
 * been going longer than a tick could honestly take.
 *
 * Returns plain operator language only: the label, never the chain name.
 */
export function describeStuckSchedulerChain(
  snapshot: SchedulerTickChainSnapshot[],
  options: { minRunningMs?: number } = {},
): FleetSchedulerStuckChain | null {
  // A chain that has been going less than one WEDGED_AFTER_MS is not yet
  // something the operator can act on, but it IS the explanation for a stale
  // scheduler, so the bar is low on purpose: one minute, two missed ticks.
  const minRunningMs = options.minRunningMs ?? 60_000;
  let worst: SchedulerTickChainSnapshot | null = null;
  for (const entry of snapshot) {
    if (!entry.inFlight || entry.runningMs === null) continue;
    if (entry.runningMs < minRunningMs) continue;
    if (worst === null || entry.runningMs > (worst.runningMs ?? 0)) worst = entry;
  }
  if (!worst) return null;
  return {
    label: worst.label,
    runningMs: worst.runningMs ?? 0,
    freshAttemptAlreadyTried: worst.abandonedInFlight > 0,
    freshAttemptAfterMs: WEDGED_AFTER_MS,
    restartNeeded: worst.rescueRefused !== null,
  };
}

/**
 * DUR-3991: the watchdog's rescues, shaped for fleet health (board-only). Plain
 * labels for the operator alongside the internal phase names for diagnosis;
 * nothing about companies, agents or data -- the phase recorder never sees any.
 */
export function describeSchedulerRescues(
  snapshot: SchedulerTickChainSnapshot[],
  diagnostics: SchedulerRescueDiagnostics,
): FleetSchedulerRescues {
  const last = diagnostics.lastRescue;
  const timing = (phase: string, ms: number): FleetSchedulerPhaseTiming => ({
    phase,
    label: describeTickPhase(phase),
    ms,
  });
  return {
    last: last
      ? {
          at: new Date(last.at).toISOString(),
          label: last.label,
          runningMs: last.runningMs,
          phasesMeasured: last.phasesMeasured,
          stuckPhase: last.stuckPhase,
          stuckPhaseLabel: last.phasesMeasured
            ? describeTickPhase(last.stuckPhase)
            : "at a point this step does not measure",
          stuckPhaseMs: last.stuckPhaseMs,
          completedPhases: last.completedPhases.map((p) => timing(p.phase, p.totalMs)),
          openPhases: last.openPhases.map((p) => timing(p.phase, p.runningMs)),
        }
      : null,
    total: diagnostics.rescuesTotal,
    abandonedStillRunning: diagnostics.abandonedInFlightTotal,
    maxAbandonedStillRunning: diagnostics.maxAbandonedInFlight,
    maxPerStepPerHour: diagnostics.maxRescuesPerChainPerWindow,
    restartNeededFor: snapshot.filter((entry) => entry.rescueRefused !== null).map((entry) => entry.label),
  };
}

/**
 * DUR-3991: the public-safe slice of the same thing, for the reduced
 * /api/health body that anyone can read without signing in. Phase names and
 * millisecond timings ONLY: no chain labels beyond the fixed code name, no
 * counts that would reveal how many agents were woken, nothing about any
 * company, agent or piece of data.
 */
export interface PublicSchedulerDiagnostics {
  restartNeeded: boolean;
  lastRescue: {
    at: string;
    chain: string;
    runningMs: number;
    stuckPhase: string | null;
    stuckPhaseMs: number | null;
    /** phase -> total ms, for the phases that had finished. */
    completedPhaseMs: Record<string, number>;
  } | null;
  lastTickSlowestPhase: { phase: string; ms: number } | null;
}

export function describePublicSchedulerDiagnostics(
  snapshot: SchedulerTickChainSnapshot[],
  diagnostics: SchedulerRescueDiagnostics,
  lastTickSlowestPhase: { phase: string; ms: number } | null,
): PublicSchedulerDiagnostics {
  const last = diagnostics.lastRescue;
  return {
    restartNeeded: snapshot.some((entry) => entry.rescueRefused !== null),
    lastRescue: last
      ? {
          at: new Date(last.at).toISOString(),
          chain: last.chain,
          runningMs: last.runningMs,
          stuckPhase: last.stuckPhase,
          stuckPhaseMs: last.stuckPhaseMs,
          completedPhaseMs: Object.fromEntries(last.completedPhases.map((p) => [p.phase, p.totalMs])),
        }
      : null,
    lastTickSlowestPhase,
  };
}

/** Process-wide instance: the scheduler loop in index.ts runs every chain through this. */
export const schedulerTickSingleFlight = createSchedulerTickSingleFlight();
