import { describe, expect, it } from "vitest";
import { createSchedulerLiveness, SCHEDULER_STALE_AFTER_INTERVALS } from "../services/scheduler-liveness.js";

// DUR-3939/DUR-3940: the health payload must be able to say whether the
// scheduler tick itself is alive, independent of whether runs are starting.
describe("scheduler liveness (DUR-3939/DUR-3940)", () => {
  it("reports disabled and never-stale when the scheduler is switched off", () => {
    let clock = 0;
    const liveness = createSchedulerLiveness(() => clock);
    liveness.configure({ enabled: false, intervalMs: 30_000 });
    clock += 10 * 60_000;
    const snap = liveness.snapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.stale).toBe(false);
    expect(snap.lastTickFinishedAt).toBeNull();
    expect(snap.sinceLastTickMs).toBeNull();
  });

  it("is not stale right after boot but becomes stale if no tick ever completes", () => {
    let clock = 1_000;
    const liveness = createSchedulerLiveness(() => clock);
    liveness.configure({ enabled: true, intervalMs: 30_000 });
    expect(liveness.snapshot().stale).toBe(false);

    clock += 30_000 * SCHEDULER_STALE_AFTER_INTERVALS;
    expect(liveness.snapshot().stale).toBe(false);
    clock += 1;
    expect(liveness.snapshot().stale).toBe(true);
  });

  it("records ticks and goes stale only after three missed intervals", () => {
    let clock = 5_000;
    const liveness = createSchedulerLiveness(() => clock);
    liveness.configure({ enabled: true, intervalMs: 30_000 });

    liveness.tickStarted();
    clock += 250;
    liveness.tickFinished({ checked: 12, enqueued: 3, skipped: 9 });

    let snap = liveness.snapshot();
    expect(snap.lastTickStartedAt).toBe(new Date(5_000).toISOString());
    expect(snap.lastTickFinishedAt).toBe(new Date(5_250).toISOString());
    expect(snap.lastTickResult).toEqual({ checked: 12, enqueued: 3, skipped: 9 });
    expect(snap.lastTickError).toBeNull();
    expect(snap.sinceLastTickMs).toBe(0);
    expect(snap.stale).toBe(false);

    clock += 89_000;
    snap = liveness.snapshot();
    expect(snap.sinceLastTickMs).toBe(89_000);
    expect(snap.stale).toBe(false);

    clock += 2_000;
    snap = liveness.snapshot();
    expect(snap.stale).toBe(true);

    // A fresh tick clears staleness.
    liveness.tickStarted();
    liveness.tickFinished({ checked: 1, enqueued: 0, skipped: 1 });
    expect(liveness.snapshot().stale).toBe(false);
  });

  it("keeps the last error until the next successful tick", () => {
    let clock = 0;
    const liveness = createSchedulerLiveness(() => clock);
    liveness.configure({ enabled: true, intervalMs: 30_000 });
    liveness.tickStarted();
    liveness.tickFailed(new Error("db went away"));
    expect(liveness.snapshot().lastTickError).toBe("db went away");
    expect(liveness.snapshot().stale).toBe(false);

    clock += 1_000;
    liveness.tickStarted();
    liveness.tickFinished({ checked: 0, enqueued: 0, skipped: 0 });
    expect(liveness.snapshot().lastTickError).toBeNull();
  });
});
