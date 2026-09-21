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
  /**
   * Phases that have started and not yet finished, keyed by a per-occurrence
   * token. A hung tick never reaches report(), so this is the only record of
   * WHERE it is stuck -- read live by the watchdog through a TickPhaseProbe.
   */
  open: Map<number, { phase: string; startedAt: number }>;
  nextOpenToken: number;
  /** Set once the tick's own work has returned (it may still be tearing down). */
  finishedAt: number | null;
  now: () => number;
}

const storage = new AsyncLocalStorage<PhaseRecorder>();

/**
 * DUR-3991: a phase that is in progress right now, and how long it has been
 * going. What a stuck tick looks like from the outside.
 */
export interface OpenTickPhase {
  phase: string;
  runningMs: number;
}

/**
 * DUR-3991: a live look inside a tick that has NOT finished -- the evidence the
 * completed-tick report can never give, because a hung tick never completes.
 */
export interface InFlightTickPhases {
  /** ms since the tick opened its recorder. */
  elapsedMs: number;
  /**
   * The innermost phase still in progress (the most recently started one that
   * has not finished) -- "where it is stuck". AFTER_TICK_PHASE when the tick's
   * own work returned but the chain around it has not (handing its database
   * connection back), and null when no timed phase is in progress.
   */
  currentPhase: string | null;
  /** How long currentPhase has been going, when there is one. */
  currentPhaseMs: number | null;
  /** Every phase still in progress, outermost first. */
  openPhases: OpenTickPhase[];
  /** Phases that finished, slowest total first (same shape as a completed report). */
  completedPhases: TickPhaseTiming[];
}

/**
 * The pseudo-phase reported when the tick's own work has already returned but
 * the chain wrapped around it has not -- i.e. it is stuck handing back its
 * reserved database connection (runInCompanyScopeBypass's release path).
 */
export const AFTER_TICK_PHASE = "afterTick";

/**
 * DUR-3991: a slot the scheduler watchdog hands to a tick chain before it
 * starts, so it can look inside the chain later if the chain never returns.
 * The chain's withTickPhases() attaches its recorder to the slot; a chain that
 * times no phases simply leaves it empty.
 */
export interface TickPhaseProbe {
  /** Live view of the attached tick, or null when no tick has attached. Never throws. */
  read(): InFlightTickPhases | null;
}

interface ProbeSlot extends TickPhaseProbe {
  recorder: PhaseRecorder | null;
}

const probeStorage = new AsyncLocalStorage<ProbeSlot>();

function readInFlight(recorder: PhaseRecorder): InFlightTickPhases {
  const now = recorder.now();
  const openPhases = [...recorder.open.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((entry) => ({ phase: entry.phase, runningMs: Math.max(0, now - entry.startedAt), startedAt: entry.startedAt }));
  const innermost = openPhases.length > 0 ? openPhases[openPhases.length - 1]! : null;
  const completedPhases: TickPhaseTiming[] = [...recorder.phases.entries()]
    .map(([phase, value]) => ({ phase, totalMs: value.totalMs, count: value.count, maxMs: value.maxMs }))
    .sort((a, b) => b.totalMs - a.totalMs);
  let currentPhase: string | null = innermost?.phase ?? null;
  let currentPhaseMs: number | null = innermost?.runningMs ?? null;
  if (!innermost && recorder.finishedAt !== null) {
    currentPhase = AFTER_TICK_PHASE;
    currentPhaseMs = Math.max(0, now - recorder.finishedAt);
  }
  return {
    elapsedMs: Math.max(0, now - recorder.startedAt),
    currentPhase,
    currentPhaseMs,
    openPhases: openPhases.map(({ phase, runningMs }) => ({ phase, runningMs })),
    completedPhases,
  };
}

/** A fresh, empty probe for one chain run. */
export function createTickPhaseProbe(): TickPhaseProbe {
  const slot: ProbeSlot = {
    recorder: null,
    read() {
      try {
        return slot.recorder ? readInFlight(slot.recorder) : null;
      } catch {
        // Diagnostics only: a failure to read must never reach the watchdog.
        return null;
      }
    },
  };
  return slot;
}

/**
 * Run `fn` with `probe` visible to any withTickPhases() it opens, however deep
 * (AsyncLocalStorage, so it survives the company-scope wrapper in between).
 */
export function runWithTickPhaseProbe<T>(probe: TickPhaseProbe, fn: () => T): T {
  return probeStorage.run(probe as ProbeSlot, fn);
}

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
  const token = recorder.nextOpenToken++;
  recorder.open.set(token, { phase, startedAt });
  try {
    return await fn();
  } finally {
    recorder.open.delete(token);
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
  const recorder: PhaseRecorder = {
    startedAt: now(),
    phases: new Map(),
    open: new Map(),
    nextOpenToken: 1,
    finishedAt: null,
    now,
  };
  // DUR-3991: let the watchdog that started this chain see inside it. Only the
  // first tick to open inside a probe claims it (a nested recorder would be a
  // bug elsewhere, and the outer one is the tick the watchdog is timing).
  const probe = probeStorage.getStore();
  if (probe && probe.recorder === null) probe.recorder = recorder;
  const report = (): TickPhaseReport => {
    const phases: TickPhaseTiming[] = [...recorder.phases.entries()]
      .map(([phase, value]) => ({ phase, totalMs: value.totalMs, count: value.count, maxMs: value.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs);
    return { totalMs: now() - recorder.startedAt, phases, slowest: phases[0] ?? null };
  };
  return storage.run(recorder, async () => {
    try {
      return await fn(report);
    } finally {
      recorder.finishedAt = now();
    }
  });
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

/**
 * DUR-3991: what each timed phase is, in words an operator can read. Phase
 * names are code identifiers ("loadAgents"); Filip is not a developer and
 * operator text never carries one (house rule 7). Unknown phases fall back to
 * a neutral phrase rather than leaking the identifier.
 */
export const TICK_PHASE_LABELS: Record<string, string> = {
  loadAgents: "loading the list of agents",
  wakeAgents: "waking the agents that were due",
  wakeAgent: "waking one of the agents that was due",
  actionableWorkGate: "checking whether an agent has work to do",
  idleGate: "checking whether an agent is free to wake",
  issueMonitors: "checking task monitors",
  customerInboxHandoff: "passing customer inbox messages to agents",
  [AFTER_TICK_PHASE]: "handing its database connection back after finishing its work",
};

export function describeTickPhase(phase: string | null): string {
  if (phase === null) return "before any of its measured steps had started";
  return TICK_PHASE_LABELS[phase] ?? "a step without a plain-language name";
}
