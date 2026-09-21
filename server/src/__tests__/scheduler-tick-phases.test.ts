import { describe, expect, it } from "vitest";
import {
  AFTER_TICK_PHASE,
  createTickPhaseProbe,
  describeTickPhase,
  describeTickPhases,
  recordTickPhase,
  runWithTickPhaseProbe,
  TickPhaseTimeoutError,
  timeTickPhase,
  withTickPhaseTimeout,
  withTickPhases,
} from "../services/scheduler-tick-phases.js";

// DUR-3991: on 2026-09-17 the tickTimers chain ran past 150 seconds against a
// 30-second interval and never returned. The database showed no long query and
// no lock waits, so the slow work was inside the process -- and nothing
// measured which part of it. This module is that measurement.

describe("DUR-3991 scheduler tick phase timing", () => {
  it("adds up each phase, counts repeats, and names the slowest", async () => {
    let clock = 0;
    const now = () => clock;

    const report = await withTickPhases(async (readReport) => {
      await timeTickPhase("loadAgents", async () => {
        clock += 400;
      });
      await timeTickPhase("wakeAgents", async () => {
        for (const cost of [1_000, 9_000, 2_000]) {
          await timeTickPhase("wakeAgent", async () => {
            clock += cost;
          });
        }
        // The loop's own overhead, so the outer phase is strictly the larger.
        clock += 500;
      });
      await timeTickPhase("issueMonitors", async () => {
        clock += 100;
      });
      return readReport();
    }, { now });

    expect(report.totalMs).toBe(13_000);
    expect(report.slowest).toEqual({ phase: "wakeAgents", totalMs: 12_500, count: 1, maxMs: 12_500 });
    expect(report.phases.find((p) => p.phase === "wakeAgent")).toEqual({
      phase: "wakeAgent",
      totalMs: 12_000,
      count: 3,
      // The single worst occurrence is what a hang looks like.
      maxMs: 9_000,
    });
    // Slowest total first, so a log line reads in the order that matters.
    expect(report.phases.map((p) => p.phase)).toEqual(["wakeAgents", "wakeAgent", "loadAgents", "issueMonitors"]);
    expect(describeTickPhases(report)).toContain("wakeAgent 12000ms over 3 (max 9000ms)");
  });

  it("times a phase that throws, and lets the error through", async () => {
    let clock = 0;
    const report = await withTickPhases(
      async (readReport) => {
        await expect(
          timeTickPhase("wakeAgent", async () => {
            clock += 7_000;
            throw new Error("agent blew up");
          }),
        ).rejects.toThrow("agent blew up");
        return readReport();
      },
      { now: () => clock },
    );
    expect(report.phases).toEqual([{ phase: "wakeAgent", totalMs: 7_000, count: 1, maxMs: 7_000 }]);
  });

  it("is a no-op outside a tick, so shared helpers can report unconditionally", async () => {
    // enqueueWakeup reports its gate timings whether it was called by the
    // scheduler or by a route; outside a tick there is nowhere to put them.
    expect(() => recordTickPhase("idleGate", 5)).not.toThrow();
    await expect(timeTickPhase("idleGate", async () => "ok")).resolves.toBe("ok");
  });

  it("keeps two concurrent ticks' numbers apart", async () => {
    // The DUR-3991 watchdog can deliberately have two copies of a chain in
    // flight at once. A shared recorder would mix them exactly then.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    const [first, second] = await Promise.all([
      withTickPhases(async (readReport) => {
        await timeTickPhase("wakeAgents", settle);
        await settle();
        return readReport();
      }),
      withTickPhases(async (readReport) => {
        await settle();
        await timeTickPhase("issueMonitors", settle);
        return readReport();
      }),
    ]);
    expect(first.phases.map((p) => p.phase)).toEqual(["wakeAgents"]);
    expect(second.phases.map((p) => p.phase)).toEqual(["issueMonitors"]);
  });
});

describe("DUR-3991 scheduler tick phase deadlines", () => {
  it("ends an await that never settles, so the chain around it can finish", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTickPhaseTimeout("wakeAgent", 10, never)).rejects.toBeInstanceOf(TickPhaseTimeoutError);
    await expect(withTickPhaseTimeout("wakeAgent", 10, never)).rejects.toThrow(
      'scheduler tick phase "wakeAgent" did not finish within 10ms',
    );
  });

  it("passes a value straight through when it settles in time, and does not swallow errors", async () => {
    await expect(withTickPhaseTimeout("wakeAgent", 5_000, Promise.resolve("done"))).resolves.toBe("done");
    await expect(withTickPhaseTimeout("wakeAgent", 5_000, Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  });
});

// DUR-3991 follow-up: the report above only exists once a tick COMPLETES, and
// a hung tick never completes -- so the stuck step had never been named. The
// probe is how the watchdog looks inside a tick that is still in flight.
describe("DUR-3991 looking inside a tick that has not finished", () => {
  /** Let every already-scheduled microtask settle. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("names the innermost phase in progress and how long it has been going, with the phases already done", async () => {
    let clock = 0;
    const probe = createTickPhaseProbe();
    expect(probe.read()).toBeNull();

    let hang!: () => void;
    const hung = new Promise<void>((resolve) => {
      hang = resolve;
    });
    const tick = runWithTickPhaseProbe(probe, () =>
      withTickPhases(
        async () => {
          await timeTickPhase("loadAgents", async () => {
            clock += 300;
          });
          await timeTickPhase("wakeAgents", async () => {
            await timeTickPhase("wakeAgent", async () => {
              clock += 1_000;
            });
            await timeTickPhase("wakeAgent", () => hung);
          });
        },
        { now: () => clock },
      ),
    );
    await flush();

    clock += 290_000;
    const live = probe.read()!;
    expect(live.currentPhase).toBe("wakeAgent");
    expect(live.currentPhaseMs).toBe(290_000);
    expect(live.elapsedMs).toBe(291_300);
    expect(live.openPhases).toEqual([
      { phase: "wakeAgents", runningMs: 291_000 },
      { phase: "wakeAgent", runningMs: 290_000 },
    ]);
    // The phases that did finish, with the same numbers a completed report has.
    expect(live.completedPhases).toEqual([
      { phase: "wakeAgent", totalMs: 1_000, count: 1, maxMs: 1_000 },
      { phase: "loadAgents", totalMs: 300, count: 1, maxMs: 300 },
    ]);
    expect(describeTickPhase(live.currentPhase)).toBe("waking one of the agents that was due");

    hang();
    await tick;
    // Finished work, nothing open: the tick itself is no longer stuck anywhere.
    const after = probe.read()!;
    expect(after.openPhases).toEqual([]);
    expect(after.currentPhase).toBe(AFTER_TICK_PHASE);
  });

  it("stays empty for a chain that never opens a recorder, and never throws", async () => {
    const probe = createTickPhaseProbe();
    await runWithTickPhaseProbe(probe, async () => {
      await timeTickPhase("loadAgents", async () => "untimed outside a recorder");
    });
    expect(probe.read()).toBeNull();
    expect(describeTickPhase(null)).toBe("before any of its measured steps had started");
    // No internal identifier ever reaches operator text, even for an unknown phase.
    expect(describeTickPhase("someNewPhase")).not.toContain("someNewPhase");
  });

  it("gives two concurrent copies of a chain their own probes", async () => {
    const first = createTickPhaseProbe();
    const second = createTickPhaseProbe();
    const never = new Promise<void>(() => {});
    void runWithTickPhaseProbe(first, () => withTickPhases(() => timeTickPhase("loadAgents", () => never)));
    void runWithTickPhaseProbe(second, () => withTickPhases(() => timeTickPhase("issueMonitors", () => never)));
    await flush();
    expect(first.read()?.currentPhase).toBe("loadAgents");
    expect(second.read()?.currentPhase).toBe("issueMonitors");
  });
});
