import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { tradingBacktestRunner, type BacktestQueue } from "../services/trading-backtest-runner.js";
import type { BacktestWorkerMessage } from "../services/trading-backtest-worker.js";

/**
 * DUR-5008: the supervisor of the past-data test. One test at a time, started
 * from its own scheduler chain without ever awaiting the simulation, a run
 * that dies is marked failed, and the live trading tick shares nothing with it.
 */

type Result = BacktestWorkerMessage & { type: "result" };
const OK: Result = { type: "result", ok: true, gatePassed: false, message: "Did not pass: x." };

function setup(options: { queued?: Array<{ id: string; companyId: string }>; worker?: (runId: string) => Promise<Result> } = {}) {
  const queued = [...(options.queued ?? [{ id: "r1", companyId: "c1" }])];
  const failed: Array<{ runId: string; message: string }> = [];
  const queue: BacktestQueue = {
    claimNextRun: vi.fn(async () => queued.shift() ?? null),
    failInterrupted: vi.fn(async () => 2),
    failRun: vi.fn(async (_c: string, runId: string, message: string) => {
      failed.push({ runId, message });
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const started: string[] = [];
  let now = new Date("2026-10-30T12:00:00Z");
  const runner = tradingBacktestRunner({
    databaseUrl: "postgres://not-used",
    queue,
    logger,
    pollEveryMs: 15_000,
    now: () => now,
    runWorker: async (job) => {
      started.push(job.runId);
      return options.worker ? options.worker(job.runId) : OK;
    },
  });
  return { runner, queue, logger, started, failed, queued, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("past-data test supervisor", () => {
  it("returns at once and runs the test in the background, never awaiting it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup({ worker: async () => (await gate, OK) });
    const before = performance.now();
    expect(s.runner.tick(s.now())).toEqual({ started: true });
    expect(performance.now() - before).toBeLessThan(25);
    await settle();
    expect(s.runner.status()).toMatchObject({ running: true, currentRunId: "r1" });
    release();
    await settle();
    expect(s.runner.status()).toMatchObject({ running: false, currentRunId: null, lastMessage: "Did not pass: x." });
  });

  it("runs one test at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup({ queued: [{ id: "r1", companyId: "c1" }, { id: "r2", companyId: "c1" }], worker: async () => (await gate, OK) });
    s.runner.tick(s.now());
    await settle();
    s.advance(60_000);
    expect(s.runner.tick(s.now())).toEqual({ started: false }); // r1 is still running
    expect(s.started).toEqual(["r1"]);
    release();
    await settle();
    expect(s.runner.tick(s.now())).toEqual({ started: true }); // the next one follows straight away
    await settle();
    expect(s.started).toEqual(["r1", "r2"]);
  });

  it("marks a run that crashed or hit its time limit failed, with the reason, and carries on", async () => {
    const s = setup({ queued: [{ id: "r1", companyId: "c1" }, { id: "r2", companyId: "c1" }], worker: async (id) => { if (id === "r1") throw new Error("The past-data test ran past its time limit and was stopped."); return OK; } });
    s.runner.tick(s.now());
    await settle();
    expect(s.failed).toEqual([{ runId: "r1", message: "The past-data test ran past its time limit and was stopped." }]);
    s.runner.tick(s.now());
    await settle();
    expect(s.started).toEqual(["r1", "r2"]);
  });

  it("on the first look it marks runs a restart interrupted as failed", async () => {
    const s = setup({ queued: [] });
    s.runner.tick(s.now());
    await settle();
    expect(s.queue.failInterrupted).toHaveBeenCalledTimes(1);
    expect(s.logger.warn).toHaveBeenCalled();
    s.advance(60_000);
    s.runner.tick(s.now());
    await settle();
    expect(s.queue.failInterrupted).toHaveBeenCalledTimes(1);
  });

  it("looks at the queue only every poll interval when idle", async () => {
    const s = setup({ queued: [] });
    s.runner.tick(s.now());
    await settle();
    s.advance(5_000);
    expect(s.runner.tick(s.now())).toEqual({ started: false });
    s.advance(11_000);
    expect(s.runner.tick(s.now())).toEqual({ started: true });
    await settle();
    expect(s.queue.claimNextRun).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled", async () => {
    const queue: BacktestQueue = { claimNextRun: vi.fn(async () => null), failInterrupted: vi.fn(async () => 0), failRun: vi.fn() };
    const runner = tradingBacktestRunner({ databaseUrl: "x", queue, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, enabled: false });
    expect(runner.tick(new Date())).toEqual({ started: false });
    expect(queue.claimNextRun).not.toHaveBeenCalled();
  });

  it("keeps the main thread free while a test burns CPU in its worker thread: the live tick's timers keep their rhythm", async () => {
    // A real worker thread doing a second of pure CPU work stands in for the simulation.
    const burn = () =>
      new Promise<Result>((resolve, reject) => {
        const worker = new Worker("const end = Date.now() + 1200; let x = 0; while (Date.now() < end) { x += Math.sqrt(x + 1); } require('node:worker_threads').parentPort.postMessage('done');", { eval: true });
        worker.once("message", () => resolve(OK));
        worker.once("error", reject);
      });
    const s = setup({ worker: burn });
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      gaps.push(t - last);
      last = t;
    }, 10);
    const startedAt = performance.now();
    s.runner.tick(s.now());
    while (s.runner.status().running || performance.now() - startedAt < 100) await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(timer);
    expect(performance.now() - startedAt).toBeGreaterThan(1000); // the worker really ran for over a second
    expect(gaps.length).toBeGreaterThan(50);
    expect(Math.max(...gaps)).toBeLessThan(150); // a blocked event loop would show a gap of a second or more
  });
});

describe("template reports share the supervisor (DUR-5014)", () => {
  function withReports(companyRuns: Array<{ id: string; companyId: string }>, reports: string[]) {
    const order: string[] = [];
    const failedReports: Array<{ id: string; message: string }> = [];
    const prepare = vi.fn(async () => undefined);
    const queue: BacktestQueue = {
      claimNextRun: vi.fn(async () => companyRuns.shift() ?? null),
      failInterrupted: vi.fn(async () => 0),
      failRun: vi.fn(async () => undefined),
      templateReports: {
        claimNextReport: vi.fn(async () => {
          const id = reports.shift();
          return id ? { id } : null;
        }),
        failInterrupted: vi.fn(async () => 1),
        failReport: vi.fn(async (id: string, message: string) => {
          failedReports.push({ id, message });
        }),
        prepare,
      },
    };
    let now = new Date("2026-10-30T12:00:00Z");
    const runner = tradingBacktestRunner({
      databaseUrl: "postgres://not-used",
      queue,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollEveryMs: 15_000,
      now: () => now,
      runWorker: async (job) => {
        order.push(`run:${job.runId}`);
        return OK;
      },
      runTemplateWorker: async (job) => {
        order.push(`report:${job.reportId}`);
        if (job.reportId === "bad") throw new Error("worker died");
        return { type: "result", ok: true, gatePassed: false, message: "report done" };
      },
    });
    return { runner, queue, order, failedReports, prepare, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
  }

  it("runs a company test before a template report, and a template report when no test is waiting", async () => {
    const s = withReports([{ id: "r1", companyId: "c1" }], ["t1"]);
    s.runner.tick(s.now());
    await settle();
    s.advance(60_000);
    s.runner.tick(s.now());
    await settle();
    expect(s.order).toEqual(["run:r1", "report:t1"]);
    expect(s.runner.status().lastMessage).toBe("report done");
  });

  it("marks a template report failed when its worker dies, and carries on", async () => {
    const s = withReports([], ["bad", "t2"]);
    s.runner.tick(s.now());
    await settle();
    expect(s.failedReports).toEqual([{ id: "bad", message: "worker died" }]);
    s.advance(60_000);
    s.runner.tick(s.now());
    await settle();
    expect(s.order).toEqual(["report:bad", "report:t2"]);
  });

  it("prepares the library at most every ten minutes, and fails interrupted reports once at start", async () => {
    const s = withReports([], []);
    s.runner.tick(s.now());
    await settle();
    expect(s.prepare).toHaveBeenCalledTimes(1);
    expect(s.queue.templateReports!.failInterrupted).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    s.runner.tick(s.now());
    await settle();
    expect(s.prepare).toHaveBeenCalledTimes(1);
    s.advance(11 * 60_000);
    s.runner.tick(s.now());
    await settle();
    expect(s.prepare).toHaveBeenCalledTimes(2);
    expect(s.queue.templateReports!.failInterrupted).toHaveBeenCalledTimes(1);
  });
});
