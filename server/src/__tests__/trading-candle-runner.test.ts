import { describe, expect, it, vi } from "vitest";
import type { CandleCycleResult } from "../services/trading-candle-backfill.js";
import { tradingCandleRunner } from "../services/trading-candle-runner.js";

function result(overrides: Partial<CandleCycleResult> = {}): CandleCycleResult {
  return { inserted: 0, corrections: 0, invalid: 0, entriesDone: 0, stops: [], errors: [], timedOut: false, complete: true, ...overrides };
}

function setup(outcomes: Array<CandleCycleResult | Error>, options: { enabled?: boolean } = {}) {
  let now = new Date("2026-10-29T12:00:00Z");
  const jobs: Array<{ runArchives: boolean; budgetMs: number }> = [];
  let release: (() => void) | null = null;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runner = tradingCandleRunner({
    databaseUrl: "postgres://not-used",
    logger,
    enabled: options.enabled,
    startDelayMs: 120_000,
    now: () => now,
    runWorker: async (job, onMessage) => {
      jobs.push({ runArchives: job.runArchives, budgetMs: job.budgetMs });
      onMessage({ type: "log", level: "warn", fields: { a: 1 }, message: "from the worker" });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const outcome = outcomes.shift()!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  const advance = (ms: number) => void (now = new Date(now.getTime() + ms));
  async function finishCycle() {
    release!();
    await vi.waitFor(() => expect(runner.status().running).toBe(false));
  }
  return { runner, jobs, advance, finishCycle, logger, at: () => now };
}

describe("trading candle runner (DUR-5007)", () => {
  it("waits for the start delay, then starts a cycle without waiting for it to finish", () => {
    const t = setup([result()]);
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    t.advance(121_000);
    expect(t.runner.tick(t.at())).toEqual({ started: true });
    expect(t.runner.status().running).toBe(true);
    // A second tick while the cycle runs starts nothing.
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    expect(t.jobs).toHaveLength(1);
    expect(t.jobs[0]).toMatchObject({ runArchives: true });
  });

  it("forwards the worker's log lines to the server logger", async () => {
    const t = setup([result()]);
    t.advance(121_000);
    t.runner.tick(t.at());
    await vi.waitFor(() => expect(t.logger.warn).toHaveBeenCalledWith({ a: 1 }, "from the worker"));
    await t.finishCycle();
  });

  it("tops up every few minutes after a clean cycle and only re-checks the archive index every six hours", async () => {
    const t = setup([result(), result(), result()]);
    t.advance(121_000);
    t.runner.tick(t.at());
    await t.finishCycle();
    t.advance(60_000);
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    t.advance(5 * 60_000);
    expect(t.runner.tick(t.at())).toEqual({ started: true });
    expect(t.jobs[1]).toMatchObject({ runArchives: false });
    await t.finishCycle();
    t.advance(6 * 3_600_000);
    t.runner.tick(t.at());
    expect(t.jobs[2]).toMatchObject({ runArchives: true });
    await t.finishCycle();
  });

  it("carries straight on after a cycle that ran out of time, and keeps asking for archives until they are done", async () => {
    const t = setup([result({ timedOut: true, complete: false }), result()]);
    t.advance(121_000);
    t.runner.tick(t.at());
    await t.finishCycle();
    t.advance(16_000);
    expect(t.runner.tick(t.at())).toEqual({ started: true });
    expect(t.jobs[1]).toMatchObject({ runArchives: true });
    await t.finishCycle();
  });

  it("backs off after failures, doubling up to an hour, and recovers", async () => {
    const t = setup([new Error("boom"), result({ errors: ["kraken archives: x"], complete: false }), result()]);
    t.advance(121_000);
    t.runner.tick(t.at());
    await t.finishCycle();
    expect(t.runner.status().lastFailure).toBe("boom");
    t.advance(4 * 60_000);
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    t.advance(61_000);
    expect(t.runner.tick(t.at())).toEqual({ started: true });
    await t.finishCycle();
    expect(t.runner.status().consecutiveFailures).toBe(2);
    t.advance(9 * 60_000); // 2nd failure waits 10 minutes
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    t.advance(2 * 60_000);
    expect(t.runner.tick(t.at())).toEqual({ started: true });
    await t.finishCycle();
    expect(t.runner.status().consecutiveFailures).toBe(0);
    expect(t.runner.status().lastFailure).toBeNull();
  });

  it("does nothing at all when switched off", () => {
    const t = setup([], { enabled: false });
    t.advance(10 * 3_600_000);
    expect(t.runner.tick(t.at())).toEqual({ started: false });
    expect(t.runner.status()).toMatchObject({ enabled: false, nextRunAt: null });
    expect(t.jobs).toHaveLength(0);
  });
});
