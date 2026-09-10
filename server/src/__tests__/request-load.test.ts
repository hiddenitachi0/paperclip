import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import type { FleetAgentCounts, FleetDatabaseLoad, FleetRunCounts, FleetSchedulerStatus } from "@paperclipai/shared";
import { computeFleetSlotUsage, summarizeFleetHealth } from "../services/fleet-health.js";
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
    expect(snap.streaming).toBe(0);
    expect(snap.totalStarted).toBe(1);
    expect(snap.totalFinished).toBe(1);
    expect(snap.peakInFlight).toBe(1);
  });

  it("a streaming response held open past the slow line is not a slow request and never turns the fleet signal amber", async () => {
    let clock = 0;
    const tracker = createRequestLoadTracker({ now: () => clock, slowThresholdMs: 10_000, overloadThreshold: 2 });
    const app = express();
    app.use(tracker.middleware());

    // Board chat streams its reply over SSE (server/src/routes/board-chat.ts)
    // and a long answer keeps the response open well past 10 s.
    let openStream: express.Response | null = null;
    app.get("/chat", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      res.write("data: {\"type\":\"start\"}\n\n");
      openStream = res;
    });
    // A request that has not answered at all is the pile-up shape DUR-272 is about.
    let releaseHang: (() => void) | null = null;
    app.get("/hang", (_req, res) => {
      releaseHang = () => res.json({ ok: true });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const openRequest = (path: string, waitForHeaders: boolean) =>
      new Promise<http.ClientRequest>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
          res.resume();
          if (waitForHeaders) resolve(req);
        });
        req.on("error", reject);
        if (!waitForHeaders) req.on("socket", () => resolve(req));
      });

    try {
      const chatClient = await openRequest("/chat", true);
      const hangClient = await openRequest("/hang", false);
      // Give the hung request a moment to reach its handler.
      for (let i = 0; i < 50 && !releaseHang; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(openStream).not.toBeNull();
      expect(releaseHang).not.toBeNull();

      clock += 30_000;
      const snap = tracker.snapshot();
      // The stream is reported, but it is not "in flight" for pile-up purposes...
      expect(snap.streaming).toBe(1);
      expect(snap.inFlight).toBe(1);
      // ...and only the unanswered request is slow.
      expect(snap.slowInFlight).toBe(1);
      expect(snap.longestInFlightMs).toBe(30_000);
      // The open stream does not count toward the overload line either.
      expect(snap.overloaded).toBe(false);

      const summary = summarizeFleetHealth({
        runs: quietRuns,
        slots: computeFleetSlotUsage(4, 0),
        agents: noAgentsInError,
        scheduler: healthyScheduler,
        requests: snap,
        database: calmDatabase,
        quietMode: {
          active: false,
          activatedAt: null,
          activeForMs: null,
          stuckAfterMinutes: 30,
          stuck: false,
          activatedForDeploy: false,
        },
      });
      expect(summary.level).toBe("ok");
      expect(summary.headline).toContain("Quiet");
      expect(summary.notes).toEqual([
        "1 request has been waiting longer than 10 seconds. That is fine on its own; it only matters if pages feel slow.",
      ]);

      releaseHang!();
      (openStream as unknown as express.Response).end();
      chatClient.destroy();
      hangClient.destroy();
      for (let i = 0; i < 50 && tracker.snapshot().totalFinished < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      const drained = tracker.snapshot();
      expect(drained.inFlight).toBe(0);
      expect(drained.streaming).toBe(0);
      expect(drained.totalFinished).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const quietRuns: FleetRunCounts = {
  windowMinutes: 15,
  startedInWindow: 0,
  succeededInWindow: 0,
  failedInWindow: 0,
  cancelledInWindow: 0,
  running: 0,
  queued: 0,
  queuedWithNoRunningAgent: 0,
  oldestQueuedWaitMs: null,
  zombieCandidates: 0,
  zombieSilenceMinutes: 30,
};
const noAgentsInError: FleetAgentCounts = { inError: 0, inErrorSample: [] };
const healthyScheduler: FleetSchedulerStatus = {
  enabled: true,
  intervalMs: 30_000,
  lastTickStartedAt: "2026-09-06T09:59:30.000Z",
  lastTickFinishedAt: "2026-09-06T09:59:30.200Z",
  lastTickResult: { checked: 12, enqueued: 0, skipped: 12 },
  lastTickError: null,
  sinceLastTickMs: 5_000,
  stale: false,
};
const calmDatabase: FleetDatabaseLoad = {
  available: true,
  poolMax: 20,
  connections: 3,
  active: 1,
  idleInTransaction: 0,
  waitingOnLocks: 0,
};
