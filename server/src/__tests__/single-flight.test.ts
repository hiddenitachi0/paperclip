import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { singleFlight } from "../services/single-flight.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight (DUR-385)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("runs the wrapped function and passes its result through when nothing is in flight", async () => {
    const guarded = singleFlight("chain", async () => 42);
    await expect(guarded()).resolves.toBe(42);
    expect(guarded.stats.inFlight).toBe(false);
    expect(guarded.stats.skipped).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips a call while the previous invocation is still running instead of starting a second copy", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const guarded = singleFlight("recovery pipeline", () => {
      calls += 1;
      return gate.promise;
    });

    const first = guarded();
    expect(guarded.stats.inFlight).toBe(true);

    await expect(guarded()).resolves.toBeUndefined();
    await expect(guarded()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(guarded.stats.skipped).toBe(2);
    expect(guarded.stats.consecutiveSkips).toBe(2);

    gate.resolve("done");
    await expect(first).resolves.toBe("done");
    expect(guarded.stats.inFlight).toBe(false);
    expect(guarded.stats.consecutiveSkips).toBe(0);

    // Once the first call has settled the chain runs again normally (the
    // wrapped fn returns the already-resolved gate, so this settles at once).
    await expect(guarded()).resolves.toBe("done");
    expect(calls).toBe(2);
  });

  it("logs once per overlap episode (first skip + recovery), not once per skipped tick", async () => {
    const gate = deferred<void>();
    const guarded = singleFlight("tickTimers", () => gate.promise);

    const first = guarded();
    await guarded();
    await guarded();
    await guarded();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[1])).toContain("still running from a previous tick");

    gate.resolve();
    await first;
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]?.[1])).toContain("overlapping 3 tick(s)");
    expect(warnSpy.mock.calls[1]?.[0]).toMatchObject({ chain: "tickTimers", skippedTicks: 3 });
  });

  it("re-arms after a rejected invocation and propagates the rejection to that caller only", async () => {
    let attempt = 0;
    const guarded = singleFlight("flaky", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return "ok";
    });

    await expect(guarded()).rejects.toThrow("boom");
    expect(guarded.stats.inFlight).toBe(false);
    await expect(guarded()).resolves.toBe("ok");
  });

  it("treats a synchronous throw inside the wrapped function like any other failure", async () => {
    let attempt = 0;
    const guarded = singleFlight("sync-throw", () => {
      attempt += 1;
      if (attempt === 1) throw new Error("sync boom");
      return Promise.resolve("ok");
    });

    await expect(guarded()).rejects.toThrow("sync boom");
    expect(guarded.stats.inFlight).toBe(false);
    await expect(guarded()).resolves.toBe("ok");
  });

  it("reports how long the in-flight call has been running when it skips", async () => {
    let clock = 1_000;
    const gate = deferred<void>();
    const seen: number[] = [];
    const guarded = singleFlight("slow", () => gate.promise, {
      now: () => clock,
      onSkip: (stats) => {
        seen.push(clock - (stats.inFlightSince?.getTime() ?? Number.NaN));
      },
    });

    const first = guarded();
    clock += 45_000;
    await guarded();
    expect(seen).toEqual([45_000]);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ chain: "slow", runningForMs: 45_000 });

    gate.resolve();
    await first;
  });

  it("keeps independent guards independent -- one stuck chain never blocks another", async () => {
    const gate = deferred<void>();
    const stuck = singleFlight("stuck", () => gate.promise);
    const healthy = singleFlight("healthy", async () => "fine");

    const stuckRun = stuck();
    await expect(healthy()).resolves.toBe("fine");
    await expect(healthy()).resolves.toBe("fine");
    expect(healthy.stats.skipped).toBe(0);

    gate.resolve();
    await stuckRun;
  });
});
