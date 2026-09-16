import { describe, expect, it } from "vitest";
import {
  createSchedulerTickSingleFlight,
  SKIP_LOG_INTERVAL_MS,
  STUCK_AFTER_MS,
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

    clock += STUCK_AFTER_MS;
    await guard.run("deployCarriedIssues", () => wedged.promise);
    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe(
      'scheduler chain "deployCarriedIssues" has been running for 11 minutes and is blocking its own ticks — this one needs looking at',
    );
    expect(errors[0]!.fields).toMatchObject({ runningMinutes: 11, skippedTicks: 1 });

    wedged.resolve();
    await flush();
  });
});
