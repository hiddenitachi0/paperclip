import { describe, expect, it } from "vitest";
import {
  createSchedulerTickSingleFlight,
  describeStuckSchedulerChain,
  MAX_ABANDONED_RUNS_PER_CHAIN,
  SCHEDULER_TICK_CHAIN_LABELS,
  SCHEDULER_TICK_CHAINS,
  SKIP_LOG_INTERVAL_MS,
  WEDGED_AFTER_MS,
  type TickSingleFlightLogger,
} from "../services/scheduler-tick-single-flight.js";

// DUR-385: each fire-and-forget scheduler tick chain holds one reserved
// connection from the bypass pool for its whole duration. Before this guard
// nothing stopped the next tick from starting the same chain again while the
// first was still holding its connection, and postgres.js's reserve() hangs
// forever (no timeout) once the pool is exhausted -- so a single slow chain
// could stall every other chain sharing the pool.

interface CapturedLine {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function captureLog() {
  const lines: CapturedLine[] = [];
  const log: TickSingleFlightLogger = {
    info: (fields, msg) => lines.push({ level: "info", fields, msg }),
    warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
    error: (fields, msg) => lines.push({ level: "error", fields, msg }),
  };
  return { lines, log };
}

/** A promise whose settlement this test controls, standing in for a slow chain. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-scheduled microtask settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("DUR-385 scheduler tick single-flight guard", () => {
  it("skips a tick whose previous invocation is still running, then runs again once it finishes", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    let starts = 0;
    const slow = deferred();
    const chain = () => {
      starts += 1;
      return slow.promise;
    };

    void guard.run("periodicRecoveryPipeline", chain);
    await flush();
    expect(starts).toBe(1);

    // Two more ticks fire while the first is still in flight.
    clock += 30_000;
    await guard.run("periodicRecoveryPipeline", chain);
    clock += 30_000;
    await guard.run("periodicRecoveryPipeline", chain);
    expect(starts).toBe(1);
    expect(guard.snapshot().find((s) => s.chain === "periodicRecoveryPipeline")).toMatchObject({
      inFlight: true,
      runningMs: 60_000,
      skipsTotal: 2,
    });

    // Skipped, never queued: finishing does not replay the two missed ticks.
    slow.resolve();
    await flush();
    expect(starts).toBe(1);
    expect(guard.snapshot().find((s) => s.chain === "periodicRecoveryPipeline")).toMatchObject({
      inFlight: false,
      runningMs: null,
      lastRunMs: 60_000,
    });

    // The next tick runs normally.
    clock += 30_000;
    const next = deferred();
    void guard.run("periodicRecoveryPipeline", () => {
      starts += 1;
      return next.promise;
    });
    await flush();
    expect(starts).toBe(2);
    next.resolve();
    await flush();

    // And the chain reported that it came back.
    expect(lines.filter((l) => l.level === "info").map((l) => l.msg)).toEqual([
      'scheduler chain "periodicRecoveryPipeline" finished after 60000ms and is accepting ticks again',
    ]);
  });

  it("clears the flag when a chain throws, so one exception cannot stop it forever", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    // A rejected promise.
    await guard.run("tickTimers", () => Promise.reject(new Error("db went away")));
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")?.inFlight).toBe(false);

    // A synchronous throw before any promise exists.
    clock += 30_000;
    await guard.run("tickTimers", () => {
      throw new Error("blew up before the chain started");
    });
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")?.inFlight).toBe(false);

    // Still runs on the next tick -- and the guard itself never rejects.
    clock += 30_000;
    let ran = false;
    await expect(
      guard.run("tickTimers", async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);

    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]!.msg).toBe('scheduler chain "tickTimers" failed — it will be tried again on the next tick');
    expect((errors[0]!.fields.err as Error).message).toBe("db went away");
  });

  it("guards each chain independently, so a wedged chain never blocks another", async () => {
    let clock = 0;
    const { log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const wedged = deferred();
    let wedgedStarts = 0;
    let otherStarts = 0;

    void guard.run("periodicRecoveryPipeline", () => {
      wedgedStarts += 1;
      return wedged.promise;
    });
    await flush();

    // The wedged chain skips every tick; the other chain runs on every tick.
    for (let tick = 0; tick < 3; tick += 1) {
      clock += 30_000;
      await guard.run("periodicRecoveryPipeline", () => {
        wedgedStarts += 1;
        return wedged.promise;
      });
      await guard.run("tickTimers", async () => {
        otherStarts += 1;
      });
    }

    expect(wedgedStarts).toBe(1);
    expect(otherStarts).toBe(3);
    const snapshot = guard.snapshot();
    expect(snapshot.find((s) => s.chain === "periodicRecoveryPipeline")).toMatchObject({ inFlight: true, skipsTotal: 3 });
    expect(snapshot.find((s) => s.chain === "tickTimers")).toMatchObject({ inFlight: false, skipsTotal: 0 });

    wedged.resolve();
    await flush();
  });

  it("logs the first skip, then at most one line per minute per chain", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const wedged = deferred();
    void guard.run("tickScheduledTriggers", () => wedged.promise);
    await flush();

    const skip = async (advanceMs: number) => {
      clock += advanceMs;
      await guard.run("tickScheduledTriggers", () => wedged.promise);
    };

    await skip(10_000); // first skip -- always logged
    let skips = lines.filter((l) => l.level === "warn");
    expect(skips).toHaveLength(1);
    expect(skips[0]!.msg).toBe(
      'scheduler chain "tickScheduledTriggers" is still running from an earlier tick — skipping this tick',
    );
    expect(skips[0]!.fields).toMatchObject({ runningMs: 10_000, skippedTicks: 1, skipsTotal: 1 });

    // Five more skips inside the same minute stay silent.
    for (let n = 0; n < 5; n += 1) await skip(10_000);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(guard.snapshot().find((s) => s.chain === "tickScheduledTriggers")?.skipsTotal).toBe(6);

    // Once the minute is up, exactly one more line -- and it accounts for the
    // skips the rate limit swallowed.
    await skip(SKIP_LOG_INTERVAL_MS - 50_000 + 1);
    skips = lines.filter((l) => l.level === "warn");
    expect(skips).toHaveLength(2);
    expect(skips[1]!.fields).toMatchObject({ skippedTicks: 6, skipsTotal: 7 });

    wedged.resolve();
    await flush();
  });

  it("gets louder once a chain has been stuck long enough to need a human", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const wedged = deferred();
    void guard.run("deployCarriedIssues", () => wedged.promise);
    await flush();

    clock += 60_000;
    await guard.run("deployCarriedIssues", () => wedged.promise);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(0);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);

    // DUR-3991: the first time it passes the limit the watchdog overrides
    // instead of skipping, so the loud "restart this" line only arrives once
    // that override has been spent and the replacement is wedged too.
    clock += WEDGED_AFTER_MS;
    const replacement = deferred();
    void guard.run("deployCarriedIssues", () => replacement.promise);
    await flush();
    clock += WEDGED_AFTER_MS;
    await guard.run("deployCarriedIssues", () => replacement.promise);

    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(2);
    expect(errors[1]!.msg).toBe(
      'scheduler chain "deployCarriedIssues" has been running for 5 minutes, a fresh copy was already started once ' +
        "and is stuck too — this server needs restarting",
    );

    wedged.resolve();
    replacement.resolve();
    await flush();
  });
});

// DUR-3991: on 2026-09-17 tickTimers stopped returning and the guard above did
// the only thing it knew how to do -- skip, for as long as the operator left
// it. The Now page said the scheduler had never completed a tick and no agent
// was woken by anything until the server was restarted by hand.
describe("DUR-3991 scheduler tick wedge watchdog", () => {
  it("starts a fresh copy once a chain has been wedged past the limit, and says so once, loudly", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const wedged = deferred();
    let starts = 0;
    void guard.run("tickTimers", () => {
      starts += 1;
      return wedged.promise;
    });
    await flush();

    // Every tick right up to the limit is skipped, exactly as before.
    for (let elapsed = 30_000; elapsed < WEDGED_AFTER_MS; elapsed += 30_000) {
      clock = elapsed;
      await guard.run("tickTimers", () => {
        starts += 1;
        return wedged.promise;
      });
    }
    expect(starts).toBe(1);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(0);

    // The tick that crosses the limit starts a fresh copy instead of skipping.
    clock = WEDGED_AFTER_MS;
    const replacement = deferred();
    void guard.run("tickTimers", () => {
      starts += 1;
      return replacement.promise;
    });
    await flush();
    expect(starts).toBe(2);

    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe(
      'scheduler chain "tickTimers" has been wedged for 5 minutes and is not coming back — abandoning it and ' +
        "starting a fresh copy so the fleet keeps moving (one copy only; if this one wedges too the server needs " +
        "restarting)",
    );
    expect(errors[0]!.fields).toMatchObject({
      chain: "tickTimers",
      runningMs: WEDGED_AFTER_MS,
      overridesTotal: 1,
      abandonedInFlight: 1,
    });

    // Said once per wedge, not once per tick: the replacement owns the flag now.
    clock += 30_000;
    await guard.run("tickTimers", () => {
      starts += 1;
      return replacement.promise;
    });
    expect(starts).toBe(2);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(1);

    const snapshot = guard.snapshot().find((s) => s.chain === "tickTimers")!;
    expect(snapshot).toMatchObject({ inFlight: true, runningMs: 30_000, overridesTotal: 1, abandonedInFlight: 1 });

    wedged.resolve();
    replacement.resolve();
    await flush();
  });

  it("never overrides a chain that finishes normally, however many ticks it spans", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    // Twenty ticks, each a chain that finishes well inside its interval.
    for (let tick = 0; tick < 20; tick += 1) {
      clock += 30_000;
      await guard.run("tickTimers", async () => {
        clock += 1_000;
      });
    }

    expect(lines.filter((l) => l.level === "error")).toHaveLength(0);
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")).toMatchObject({
      inFlight: false,
      overridesTotal: 0,
      abandonedInFlight: 0,
      skipsTotal: 0,
    });
  });

  it("leaves a slow-but-finishing chain alone: it still just skips ticks, as before", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const slow = deferred();
    let starts = 0;
    const chain = () => {
      starts += 1;
      return slow.promise;
    };
    void guard.run("periodicRecoveryPipeline", chain);
    await flush();

    // Four minutes of skipping -- under the limit, so nothing is overridden.
    for (let elapsed = 30_000; elapsed <= 4 * 60_000; elapsed += 30_000) {
      clock = elapsed;
      await guard.run("periodicRecoveryPipeline", chain);
    }
    expect(starts).toBe(1);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(0);

    // ...and then it finishes, before the watchdog ever had to act.
    slow.resolve();
    await flush();
    const snapshot = guard.snapshot().find((s) => s.chain === "periodicRecoveryPipeline")!;
    expect(snapshot).toMatchObject({ inFlight: false, overridesTotal: 0, abandonedInFlight: 0, lastRunMs: 4 * 60_000 });
  });

  it("overrides at most once per wedge: a replacement that wedges too is not overridden again", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const first = deferred();
    const second = deferred();
    let starts = 0;
    const chainFor = (promise: Promise<void>) => () => {
      starts += 1;
      return promise;
    };

    void guard.run("tickTimers", chainFor(first.promise));
    await flush();

    // Crossing the limit the first time: one override.
    clock += WEDGED_AFTER_MS;
    void guard.run("tickTimers", chainFor(second.promise));
    await flush();
    expect(starts).toBe(2);

    // The replacement wedges too. Twenty more minutes of ticks and the guard
    // never starts a third copy -- the abandoned budget is spent.
    for (let tick = 0; tick < 40; tick += 1) {
      clock += 30_000;
      await guard.run("tickTimers", chainFor(second.promise));
    }
    expect(starts).toBe(2);
    expect(MAX_ABANDONED_RUNS_PER_CHAIN).toBe(1);
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")).toMatchObject({
      overridesTotal: 1,
      abandonedInFlight: 1,
    });

    // It says what is left to do instead of silently skipping.
    const loud = lines.filter((l) => l.level === "error").map((l) => l.msg);
    expect(loud.some((msg) => msg.includes("this server needs restarting"))).toBe(true);

    first.resolve();
    second.resolve();
    await flush();
  });

  it("an abandoned run that finally returns hands its budget back and does not clear the replacement", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    const abandoned = deferred();
    const replacement = deferred();
    void guard.run("tickTimers", () => abandoned.promise);
    await flush();

    clock += WEDGED_AFTER_MS;
    void guard.run("tickTimers", () => replacement.promise);
    await flush();
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")?.abandonedInFlight).toBe(1);

    // The abandoned run comes back long after it was given up on.
    clock += 60_000;
    abandoned.resolve();
    await flush();

    // The replacement still holds the flag -- the late finish must not clear it.
    expect(guard.snapshot().find((s) => s.chain === "tickTimers")).toMatchObject({
      inFlight: true,
      runningMs: 60_000,
      abandonedInFlight: 0,
    });
    expect(lines.some((l) => l.msg.includes("finally returned"))).toBe(true);

    // With the budget back, a fresh wedge may be overridden again.
    clock += WEDGED_AFTER_MS;
    let restarted = false;
    void guard.run("tickTimers", async () => {
      restarted = true;
    });
    await flush();
    expect(restarted).toBe(true);

    replacement.resolve();
    await flush();
  });
});

describe("DUR-3991 operator-facing chain names", () => {
  // Rule 3 ("two lists that must agree, with nothing enforcing it, is the
  // recurring bug"): the label map is typed as a Record over the chain union
  // so TypeScript catches a missing entry, and this reads the real list so a
  // placeholder or a leftover internal name cannot slip through either.
  it("gives every scheduler chain a plain-language name that is not its internal one", () => {
    for (const chain of SCHEDULER_TICK_CHAINS) {
      const label = SCHEDULER_TICK_CHAIN_LABELS[chain];
      expect(label, `chain ${chain} has no operator label`).toBeTruthy();
      expect(label).not.toBe(chain);
      // No camelCase identifiers smuggled into operator text.
      expect(label).not.toMatch(/[a-z][A-Z]/);
      expect(label.length).toBeGreaterThan(5);
    }
    expect(Object.keys(SCHEDULER_TICK_CHAIN_LABELS).sort()).toEqual([...SCHEDULER_TICK_CHAINS].sort());
  });

  it("describes the longest-running stuck chain in operator words, or nothing at all", () => {
    let clock = 0;
    const { log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log });

    expect(describeStuckSchedulerChain(guard.snapshot())).toBeNull();

    const timers = deferred();
    const recovery = deferred();
    void guard.run("tickTimers", () => timers.promise);
    clock += 30_000;
    void guard.run("periodicRecoveryPipeline", () => recovery.promise);

    // Nothing has been going long enough to be worth naming yet.
    clock += 20_000;
    expect(describeStuckSchedulerChain(guard.snapshot())).toBeNull();

    clock += 3 * 60_000;
    const stuck = describeStuckSchedulerChain(guard.snapshot());
    expect(stuck).toEqual({
      label: "waking agents on their timers",
      runningMs: 3 * 60_000 + 50_000,
      freshAttemptAlreadyTried: false,
      freshAttemptAfterMs: WEDGED_AFTER_MS,
    });
    expect(stuck!.label).not.toContain("tickTimers");

    timers.resolve();
    recovery.resolve();
  });
});
