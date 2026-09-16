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
// A chain in flight for longer than STUCK_AFTER_MS gets a louder (error-level)
// line, because at that point it is no longer "a tick that ran a bit long" but
// something wedged that a human should look at.

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

/** At most one skip line per chain per minute, however often it skips. */
export const SKIP_LOG_INTERVAL_MS = 60_000;

/**
 * How long an in-flight chain may run before its skip lines get louder.
 * Ten minutes is ~20 missed ticks at the 30s default: well past "this tick is
 * slow today" and into "this chain is not coming back on its own".
 */
export const STUCK_AFTER_MS = 10 * 60_000;

export interface SchedulerTickChainSnapshot {
  chain: SchedulerTickChain;
  /** true while a previous invocation is still in flight. */
  inFlight: boolean;
  /** How long the in-flight run has been going, or null when idle. */
  runningMs: number | null;
  /** Duration of the last completed run, or null when none has completed. */
  lastRunMs: number | null;
  /** Total ticks skipped for this chain since the process started. */
  skipsTotal: number;
}

interface ChainState {
  startedAt: number | null;
  skipsTotal: number;
  /** Skips not yet mentioned in a log line (reset every time one is written). */
  skipsSinceLastLog: number;
  /** Skips caused by the currently in-flight run (reset when a run starts). */
  skipsThisRun: number;
  lastSkipLoggedAt: number | null;
  lastRunMs: number | null;
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

  function stateFor(chain: SchedulerTickChain): ChainState {
    let state = states.get(chain);
    if (!state) {
      state = {
        startedAt: null,
        skipsTotal: 0,
        skipsSinceLastLog: 0,
        skipsThisRun: 0,
        lastSkipLoggedAt: null,
        lastRunMs: null,
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
    };

    if (runningMs >= STUCK_AFTER_MS) {
      log.error(
        fields,
        `scheduler chain "${chain}" has been running for ${Math.floor(runningMs / 60_000)} minutes and is ` +
          "blocking its own ticks — this one needs looking at",
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
      state.skipsTotal += 1;
      state.skipsSinceLastLog += 1;
      state.skipsThisRun += 1;
      logSkipIfDue(chain, state, now);
      return;
    }

    state.startedAt = now;
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
      const runMs = finishedAt - (state.startedAt ?? finishedAt);
      state.startedAt = null;
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

  function snapshot(): SchedulerTickChainSnapshot[] {
    const now = nowFn();
    return SCHEDULER_TICK_CHAINS.map((chain) => {
      const state = states.get(chain);
      return {
        chain,
        inFlight: state?.startedAt != null,
        runningMs: state?.startedAt != null ? now - state.startedAt : null,
        lastRunMs: state?.lastRunMs ?? null,
        skipsTotal: state?.skipsTotal ?? 0,
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

/** Process-wide instance: the scheduler loop in index.ts runs every chain through this. */
export const schedulerTickSingleFlight = createSchedulerTickSingleFlight();
