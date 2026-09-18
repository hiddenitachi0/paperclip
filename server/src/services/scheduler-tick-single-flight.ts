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
//     is gone. This override is bounded: at most ONE abandoned run per chain at
//     a time (MAX_ABANDONED_RUNS_PER_CHAIN), and the fresh copy holds the flag
//     from the moment it starts, so the normal skip rules apply again
//     immediately. Two copies, never twenty.
//   * Five minutes is ten missed ticks. A chain that has not returned in ten
//     ticks is not "slow this time"; the overlap risk of one extra copy is
//     smaller than the certainty of a fleet that wakes nobody.
//   * If the fresh copy wedges too, the guard does NOT override again -- the
//     abandoned budget is spent. Two wedged copies mean something systemic, and
//     a third would just eat the pool DUR-385 exists to protect. From there the
//     guard goes back to skipping and says loudly, in the log and on the Now
//     page, that the server needs restarting. The budget frees up again if the
//     abandoned run ever does return.
// The override is logged once per wedge, at error level, as a wedged chain --
// never as one of the routine skip lines.

import type { FleetSchedulerStuckChain } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

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
 * How many runs of one chain may be abandoned-but-unsettled at the same time.
 *
 * One. The override exists to recover from a single wedge, not to keep feeding
 * copies into a chain that is systemically broken: each in-flight chain holds a
 * reserved connection from the bypass pool (cap 10), so an uncapped watchdog
 * would reproduce exactly the pool exhaustion DUR-385 was written to stop. Once
 * the budget is spent the guard skips again and says a restart is needed. The
 * budget is given back if an abandoned run ever does settle.
 */
export const MAX_ABANDONED_RUNS_PER_CHAIN = 1;

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
  /** Abandoned runs that have still never settled (0 or 1, see the cap). */
  abandonedInFlight: number;
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
}

export function createSchedulerTickSingleFlight(options: TickSingleFlightOptions = {}) {
  const nowFn = options.now ?? (() => Date.now());
  const log = options.log ?? (logger as unknown as TickSingleFlightLogger);
  const states = new Map<string, ChainState>();
  let nextRunId = 1;

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
    // copy, so reaching here means the abandoned budget is already spent: the
    // replacement is wedged too and nothing else will clear it.
    if (runningMs >= WEDGED_AFTER_MS) {
      log.error(
        fields,
        `scheduler chain "${chain}" has been running for ${Math.floor(runningMs / 60_000)} minutes, a fresh copy was ` +
          "already started once and is stuck too — this server needs restarting",
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
      const mayOverride = wedged && state.abandonedInFlight < MAX_ABANDONED_RUNS_PER_CHAIN;

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
      log.error(
        {
          chain,
          runningMs,
          runningMinutes: Math.floor(runningMs / 60_000),
          skippedTicks: state.skipsThisRun,
          skipsTotal: state.skipsTotal,
          overridesTotal: state.overridesTotal,
          abandonedInFlight: state.abandonedInFlight,
          wedgedAfterMs: WEDGED_AFTER_MS,
        },
        `scheduler chain "${chain}" has been wedged for ${Math.floor(runningMs / 60_000)} minutes and is not coming ` +
          "back — abandoning it and starting a fresh copy so the fleet keeps moving (one copy only; if this one " +
          "wedges too the server needs restarting)",
      );
      // The replacement owns the flag from here; the wedged run is off the books.
      state.startedAt = null;
      state.runId = null;
    }

    const runId = nextRunId++;
    state.startedAt = now;
    state.runId = runId;
    state.skipsThisRun = 0;
    try {
      await start();
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
        log.info(
          { chain, runMs, abandonedInFlight: state.abandonedInFlight },
          `scheduler chain "${chain}" finally returned after ${runMs}ms, long after it was given up on`,
        );
      } else {
        state.startedAt = null;
        state.runId = null;
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
      return {
        chain,
        label: SCHEDULER_TICK_CHAIN_LABELS[chain],
        inFlight: state?.startedAt != null,
        runningMs: state?.startedAt != null ? now - state.startedAt : null,
        lastRunMs: state?.lastRunMs ?? null,
        skipsTotal: state?.skipsTotal ?? 0,
        overridesTotal: state?.overridesTotal ?? 0,
        abandonedInFlight: state?.abandonedInFlight ?? 0,
      };
    });
  }

  /** Test-only: forget every chain's state. */
  function reset(): void {
    states.clear();
  }

  return { run, snapshot, reset };
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
  };
}

/** Process-wide instance: the scheduler loop in index.ts runs every chain through this. */
export const schedulerTickSingleFlight = createSchedulerTickSingleFlight();
