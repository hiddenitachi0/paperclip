// DUR-3939/DUR-3940: the one fact that separates "the scheduler is broken"
// from "the scheduler is fine but every run slot is taken" is whether the
// timer tick is still happening. Nothing persisted that before -- the only
// evidence was a log line. The scheduler loop in index.ts records each tick
// here (same process as the API, by design: run dispatch is single-process,
// see agent-start-lock.ts) and /api/health reads it back.

export interface SchedulerTickResult {
  checked: number;
  enqueued: number;
  skipped: number;
}

export interface SchedulerLivenessSnapshot {
  /** false when HEARTBEAT_SCHEDULER_ENABLED=false (nothing will ever tick). */
  enabled: boolean;
  intervalMs: number | null;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickResult: SchedulerTickResult | null;
  lastTickError: string | null;
  /** ms since the last tick finished (null when it never ran). */
  sinceLastTickMs: number | null;
  /**
   * true when the scheduler is enabled and no tick has completed within
   * three intervals (or it has never completed one and the process has been
   * up for longer than three intervals).
   */
  stale: boolean;
}

interface SchedulerLivenessState {
  enabled: boolean;
  intervalMs: number | null;
  configuredAt: number | null;
  lastTickStartedAt: number | null;
  lastTickFinishedAt: number | null;
  lastTickResult: SchedulerTickResult | null;
  lastTickError: string | null;
}

export const SCHEDULER_STALE_AFTER_INTERVALS = 3;

export function createSchedulerLiveness(nowFn: () => number = () => Date.now()) {
  const state: SchedulerLivenessState = {
    enabled: false,
    intervalMs: null,
    configuredAt: null,
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastTickResult: null,
    lastTickError: null,
  };

  function configure(input: { enabled: boolean; intervalMs: number }) {
    state.enabled = input.enabled;
    state.intervalMs = input.intervalMs > 0 ? input.intervalMs : null;
    state.configuredAt = nowFn();
  }

  function tickStarted() {
    state.lastTickStartedAt = nowFn();
  }

  function tickFinished(result: SchedulerTickResult) {
    state.lastTickFinishedAt = nowFn();
    state.lastTickResult = result;
    state.lastTickError = null;
  }

  function tickFailed(error: unknown) {
    state.lastTickFinishedAt = nowFn();
    state.lastTickError = error instanceof Error ? error.message : String(error);
  }

  function snapshot(): SchedulerLivenessSnapshot {
    const now = nowFn();
    const sinceLastTickMs = state.lastTickFinishedAt === null ? null : Math.max(0, now - state.lastTickFinishedAt);
    let stale = false;
    if (state.enabled && state.intervalMs) {
      const staleAfterMs = state.intervalMs * SCHEDULER_STALE_AFTER_INTERVALS;
      if (sinceLastTickMs !== null) {
        stale = sinceLastTickMs > staleAfterMs;
      } else if (state.configuredAt !== null) {
        stale = now - state.configuredAt > staleAfterMs;
      }
    }
    return {
      enabled: state.enabled,
      intervalMs: state.intervalMs,
      lastTickStartedAt: state.lastTickStartedAt === null ? null : new Date(state.lastTickStartedAt).toISOString(),
      lastTickFinishedAt: state.lastTickFinishedAt === null ? null : new Date(state.lastTickFinishedAt).toISOString(),
      lastTickResult: state.lastTickResult,
      lastTickError: state.lastTickError,
      sinceLastTickMs,
      stale,
    };
  }

  function reset() {
    state.enabled = false;
    state.intervalMs = null;
    state.configuredAt = null;
    state.lastTickStartedAt = null;
    state.lastTickFinishedAt = null;
    state.lastTickResult = null;
    state.lastTickError = null;
  }

  return { configure, tickStarted, tickFinished, tickFailed, snapshot, reset };
}

export type SchedulerLiveness = ReturnType<typeof createSchedulerLiveness>;

/** Process-wide instance: written by the scheduler loop, read by /api/health. */
export const schedulerLiveness = createSchedulerLiveness();
