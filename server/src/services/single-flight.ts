import { logger } from "../middleware/logger.js";

/**
 * DUR-385 (DUR-352 Wave 6 finding 3): a single-flight guard for the
 * scheduler's fire-and-forget tick chains.
 *
 * Every chain the heartbeat scheduler starts on each `setInterval` fire
 * (`void runInCompanyScopeBypass(bypassDb, ..., () => chain())`) reserves and
 * holds ONE physical connection from the size-limited bypassDb pool for the
 * chain's whole duration. Nothing awaited that chain before the next
 * interval fired, so a chain that ran longer than one interval (10-30s)
 * under load -- most plausibly the multi-step periodic recovery pipeline --
 * had a SECOND reservation started for it while the first was still held.
 * Repeated overlap could exhaust the bypass pool, and postgres.js's
 * `reserve()` then blocks forever rather than failing fast, which stalls
 * every *other* independent chain sharing that pool.
 *
 * `singleFlight(name, fn)` wraps a promise-returning function so that at most
 * one invocation is in flight at a time. A call made while the previous one
 * has not settled is skipped (resolves `undefined`, does not run `fn`) and
 * the skip is logged -- once per overlap episode, not once per skipped tick,
 * so a chain that is stuck for an hour produces one log line plus one
 * "recovered" line, not 120 identical warnings.
 *
 * The guard is per wrapper instance, keyed by nothing but the wrapper's own
 * closure: wrap each chain exactly once at scheduler setup and reuse that
 * wrapped function on every tick.
 */
export interface SingleFlightStats {
  /** Whether an invocation is currently in flight. */
  readonly inFlight: boolean;
  /** Total calls that were skipped because a previous one was still running. */
  readonly skipped: number;
  /** Consecutive skips since the in-flight call started (reset when it settles). */
  readonly consecutiveSkips: number;
  /** When the in-flight call started, or null when idle. */
  readonly inFlightSince: Date | null;
}

export interface SingleFlightFn<T> {
  (): Promise<T | undefined>;
  readonly stats: SingleFlightStats;
}

export interface SingleFlightOptions {
  /**
   * Called on every skipped invocation with the current stats -- for tests and
   * for callers that want their own metrics. Logging is handled here
   * regardless.
   */
  onSkip?: (stats: SingleFlightStats) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function singleFlight<T>(name: string, fn: () => Promise<T>, options: SingleFlightOptions = {}): SingleFlightFn<T> {
  const now = options.now ?? (() => Date.now());
  let inFlight: Promise<T> | null = null;
  let inFlightSinceMs: number | null = null;
  let skipped = 0;
  let consecutiveSkips = 0;

  const stats: SingleFlightStats = {
    get inFlight() {
      return inFlight !== null;
    },
    get skipped() {
      return skipped;
    },
    get consecutiveSkips() {
      return consecutiveSkips;
    },
    get inFlightSince() {
      return inFlightSinceMs === null ? null : new Date(inFlightSinceMs);
    },
  };

  const wrapped = (async (): Promise<T | undefined> => {
    if (inFlight) {
      skipped += 1;
      consecutiveSkips += 1;
      const runningForMs = inFlightSinceMs === null ? 0 : now() - inFlightSinceMs;
      if (consecutiveSkips === 1) {
        logger.warn(
          { chain: name, runningForMs },
          `scheduler chain "${name}" is still running from a previous tick; skipping this tick instead of starting a second copy (DUR-385)`,
        );
      }
      options.onSkip?.(stats);
      return undefined;
    }

    inFlightSinceMs = now();
    const startedAtMs = inFlightSinceMs;
    // `fn` runs on a microtask, after `inFlight` is set, so a synchronous
    // throw inside it becomes a rejection of `run` (settled in `finally`
    // below like any other outcome) and can never leave the guard armed.
    const run = Promise.resolve().then(fn);
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
      inFlightSinceMs = null;
      if (consecutiveSkips > 0) {
        logger.warn(
          { chain: name, skippedTicks: consecutiveSkips, ranForMs: now() - startedAtMs },
          `scheduler chain "${name}" finished after overlapping ${consecutiveSkips} tick(s); normal cadence resumes (DUR-385)`,
        );
      }
      consecutiveSkips = 0;
    }
  }) as SingleFlightFn<T>;

  Object.defineProperty(wrapped, "stats", { value: stats, enumerable: true });
  return wrapped;
}
