import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createRequestLoadTracker, REQUEST_LOAD_WARNING_INTERVAL_MS } from "../services/request-load.js";

// DUR-272: in-flight request counting so an overloaded server is
// distinguishable from a dead one from a single /api/health read.
describe("request load tracker (DUR-272)", () => {
  it("counts requests in flight, tracks the peak, and drains on finish", () => {
    let clock = 1_000;
    const tracker = createRequestLoadTracker({ now: () => clock, slowThresholdMs: 500 });

    const finishA = tracker.begin();
    clock += 100;
    const finishB = tracker.begin();
    clock += 600;

    let snap = tracker.snapshot();
    expect(snap.inFlight).toBe(2);
    expect(snap.peakInFlight).toBe(2);
    expect(snap.peakInFlightAt).toBe(new Date(1_100).toISOString());
    expect(snap.longestInFlightMs).toBe(700);
    // A is 700ms old, B is 600ms old; both are past the 500ms slow line.
    expect(snap.slowInFlight).toBe(2);
    expect(snap.totalStarted).toBe(2);
    expect(snap.totalFinished).toBe(0);

    finishA();
    finishA(); // idempotent: "finish" and "close" can both fire for one response
    snap = tracker.snapshot();
    expect(snap.inFlight).toBe(1);
    expect(snap.totalFinished).toBe(1);
    expect(snap.longestInFlightMs).toBe(600);

    finishB();
    snap = tracker.snapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.longestInFlightMs).toBe(0);
    expect(snap.slowInFlight).toBe(0);
    expect(snap.peakInFlight).toBe(2);
    expect(snap.totalFinished).toBe(2);
  });

  it("flags overload at the threshold and rate-limits the warning", () => {
    let clock = 0;
    const warnings: number[] = [];
    const tracker = createRequestLoadTracker({
      now: () => clock,
      overloadThreshold: 3,
      onOverload: (snap) => warnings.push(snap.inFlight),
    });

    const finishers = [tracker.begin(), tracker.begin()];
    expect(tracker.snapshot().overloaded).toBe(false);
    expect(warnings).toEqual([]);

    finishers.push(tracker.begin());
    expect(tracker.snapshot().overloaded).toBe(true);
    expect(warnings).toEqual([3]);

    // Still overloaded a moment later: no second warning inside the interval.
    clock += 1_000;
    finishers.push(tracker.begin());
    expect(warnings).toEqual([3]);

    // Past the interval, still overloaded: warn again with the current count.
    clock += REQUEST_LOAD_WARNING_INTERVAL_MS;
    finishers.push(tracker.begin());
    expect(warnings).toEqual([3, 5]);

    for (const finish of finishers) finish();
    expect(tracker.snapshot().overloaded).toBe(false);
  });

  it("counts real express requests and releases them when the response ends", async () => {
    const tracker = createRequestLoadTracker();
    const app = express();
    app.use(tracker.middleware());
    let observedDuringRequest = -1;
    app.get("/probe", (_req, res) => {
      observedDuringRequest = tracker.snapshot().inFlight;
      res.json({ ok: true });
    });

    const res = await request(app).get("/probe");
    expect(res.status).toBe(200);
    expect(observedDuringRequest).toBe(1);

    const snap = tracker.snapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.totalStarted).toBe(1);
    expect(snap.totalFinished).toBe(1);
    expect(snap.peakInFlight).toBe(1);
  });
});
