// DUR-3991: measure the scheduler tick instead of guessing about it.
//
// On 2026-09-17 the `tickTimers` chain ran for more than 150 seconds against a
// 30-second interval and never returned; the operator restarted the server.
// There was nothing to look at afterwards. The chain's log line says only what
// it enqueued -- not where the time went -- and the database showed no long
// query and no lock waits, so the slow work was inside the process with no
// evidence of which part.
//
// This is the evidence. A tick opens a recorder, every phase it runs reports
// its own duration into it, and the tick's result carries the breakdown: which
// phase, how long, how many times it ran. The scheduler logs it whenever a tick
// takes longer than its own interval, and /api/health carries the last tick's
// breakdown so the answer survives the next restart of the browser tab, if not
// of the server.
//
// Phases nest and repeat: `wakeAgents` is one phase that runs once, and the
// per-agent `idleGate` inside it is one phase that runs once per agent. Both
// are recorded; `count` tells them apart.
//
// AsyncLocalStorage, not a module-level variable, because the DUR-3991 watchdog
// in scheduler-tick-single-flight.ts can deliberately have two copies of a
// chain in flight at once -- a shared mutable recorder would mix their numbers
// together at exactly the moment the numbers matter most. Anything that reports
// a phase outside a tick (a route calling the same helper, a test) is a no-op.

import { AsyncLocalStorage } from "node:async_hooks";

export interface TickPhaseTiming {
  phase: string;
  /** Total wall-clock ms spent in this phase across every time it ran. */
  totalMs: number;
  /** How many times this phase ran during the tick. */
  count: number;
  /** The slowest single occurrence, which is what a hang looks like. */
  maxMs: number;
}

export interface TickPhaseReport {
  /** Wall-clock ms from opening the recorder to reading it. */
  totalMs: number;
  /** Every phase, slowest total first. */
  phases: TickPhaseTiming[];
  /** The phase with the largest total, or null when nothing was recorded. */
  slowest: TickPhaseTiming | null;
}

interface PhaseRecorder {
  startedAt: number;
  phases: Map<string, { totalMs: number; count: number; maxMs: number }>;
  now: () => number;
}

const storage = new AsyncLocalStorage<PhaseRecorder>();

/**
 * Record `ms` against `phase` for the tick this call is running inside.
 * A no-op outside a tick, so helpers shared with request paths can report
 * unconditionally without knowing who called them.
 */
export function recordTickPhase(phase: string, ms: number): void {
  const recorder = storage.getStore();
  if (!recorder) return;
  const existing = recorder.phases.get(phase);
  if (existing) {
    existing.totalMs += ms;
    existing.count += 1;
    if (ms > existing.maxMs) existing.maxMs = ms;
    return;
  }
  recorder.phases.set(phase, { totalMs: ms, count: 1, maxMs: ms });
}

/** Run `fn`, recording how long it took against `phase`. Timed even when it throws. */
export async function timeTickPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const recorder = storage.getStore();
  if (!recorder) return fn();
  const startedAt = recorder.now();
  try {
    return await fn();
  } finally {
    recordTickPhase(phase, recorder.now() - startedAt);
  }
}

/**
 * Open a recorder for one tick and run `fn` inside it. `fn` is handed a
 * `report()` it can call at the end to put the breakdown in its own result.
 */
export async function withTickPhases<T>(
  fn: (report: () => TickPhaseReport) => Promise<T>,
  options: { now?: () => number } = {},
): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const recorder: PhaseRecorder = { startedAt: now(), phases: new Map(), now };
  const report = (): TickPhaseReport => {
    const phases: TickPhaseTiming[] = [...recorder.phases.entries()]
      .map(([phase, value]) => ({ phase, totalMs: value.totalMs, count: value.count, maxMs: value.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs);
    return { totalMs: now() - recorder.startedAt, phases, slowest: phases[0] ?? null };
  };
  return storage.run(recorder, () => fn(report));
}

/** One line an operator-free log can carry: "wakeAgents 41200ms over 63 runs". */
export function describeTickPhases(report: TickPhaseReport): string {
  if (report.phases.length === 0) return "no phases recorded";
  return report.phases.map((p) => `${p.phase} ${p.totalMs}ms over ${p.count} (max ${p.maxMs}ms)`).join(", ");
}

export class TickPhaseTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly timeoutMs: number,
  ) {
    super(`scheduler tick phase "${phase}" did not finish within ${timeoutMs}ms`);
    this.name = "TickPhaseTimeoutError";
  }
}

/**
 * Give an await a deadline so the chain around it always ends.
 *
 * Honest about what this does NOT do: it does not cancel the underlying work.
 * A query already sent to Postgres keeps running and keeps the connection busy;
 * all this buys is that the *chain* returns, so the scheduler ticks again, the
 * fleet keeps being woken, and the wedge becomes something the single-flight
 * watchdog and the Now page can talk about instead of an invisible hang. That
 * is the whole point: on 2026-09-17 the chain never ended, so nothing else
 * could happen at all.
 *
 * CALLER'S OBLIGATION, and it is not optional: because the work is abandoned
 * rather than cancelled, it may still hold whatever it held -- most importantly
 * the ONE database connection a scheduler chain reserves for its whole
 * duration, possibly with a transaction open on it. A caller that times
 * something out must therefore stop using that connection for the rest of the
 * chain, not carry on down its loop; otherwise the next piece of work nests
 * itself inside a transaction that has been given up on, on a connection with
 * two owners. heartbeat.ts's tickTimers ends the tick at the first timeout for
 * exactly this reason.
 *
 * The timer is unref'd so a pending deadline can never hold the process open
 * during a graceful shutdown.
 */
export function withTickPhaseTimeout<T>(phase: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TickPhaseTimeoutError(phase, timeoutMs)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
