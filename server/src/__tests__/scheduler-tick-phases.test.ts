import { describe, expect, it } from "vitest";
import {
  describeTickPhases,
  recordTickPhase,
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
