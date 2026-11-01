import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, tradingBacktestHoldoutReads, tradingBacktestRuns, tradingBacktestTrials, type Db } from "@paperclipai/db";
import { type CreateTradingStrategyInput, type TradingEngineBar } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";
import { insertCandles } from "../services/trading-candle-store.js";
import { spawnBacktestWorker } from "../services/trading-backtest-runner.js";

/**
 * DUR-5008: the whole path with the real worker thread: queue a run, claim it,
 * let the worker read candles from the store and write the report, trials and
 * holdout read, then read them back. Candles are synthetic (a seeded random
 * walk); nothing touches the network.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping backtest worker tests: ${support.reason ?? "unsupported environment"}`);

const H4 = 4 * 3_600_000;
const NOW = new Date("2026-09-01T00:00:00Z");
const FROM = new Date("2021-06-01T00:00:00Z");

function walk(count: number, seed: number): TradingEngineBar[] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let price = 20_000;
  let drift = 0;
  return Array.from({ length: count }, (_, i) => {
    if (i % 300 === 0) drift = [0.001, -0.001, 0.0001][Math.floor(random() * 3)]!;
    const open = price;
    const close = Math.max(100, price * (1 + drift + (random() - 0.5) * 0.02));
    price = close;
    return { openTime: new Date(FROM.getTime() + i * H4), open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 100 };
  });
}

const INPUT: CreateTradingStrategyInput = {
  name: "Worker",
  asset: "BTC",
  timeframe: "4h",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 5, slowPeriod: 15, orderSizeFraction: 0.1 },
  riskConfig: { maxPositionNok: 1_000, maxTotalExposureNok: 3_000, maxOrdersPerDay: 5, dailyLossLimitNok: 200, maxDrawdownPct: 10, priceBandPct: 2, approvalAboveNok: 500, feeRatePct: 0.4 },
};

d("past-data test, real worker thread", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  let connectionString = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-backtest-worker");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
    db = createDb(connectionString);
    const bars = walk(Math.floor((NOW.getTime() - FROM.getTime()) / H4), 11).map((b) => ({ ...b }));
    await insertCandles(db, "kraken", "BTC/USD", "4h", bars);
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function setup() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker Co", issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const trading = tradingService(db, { now: () => NOW, marketData: fakeTradingMarketData({ candles: { BTC: { candles: [] } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: NOW } } }) });
    const strategy = await trading.createStrategy(companyId, INPUT, { actorType: "user", actorId: "owner-1" });
    return { companyId, trading, strategy };
  }

  async function runOnce(ctx: Awaited<ReturnType<typeof setup>>, purpose: "gate" | "explore") {
    const queued = await ctx.trading.backtests.queueRun(ctx.companyId, ctx.strategy.id, { purpose }, { type: "user", id: "owner-1" });
    const claimed = await ctx.trading.backtests.claimNextRun();
    expect(claimed?.id).toBe(queued.id);
    const message = await spawnBacktestWorker({ databaseUrl: connectionString, runId: queued.id, companyId: ctx.companyId, maxWallMs: 5 * 60_000 }, 6 * 60_000);
    const [row] = await db.select().from(tradingBacktestRuns).where(eq(tradingBacktestRuns.id, queued.id));
    return { message, row: row! };
  }

  it("writes the report, the gate verdict, the trials and the holdout read; the same run twice gives the same digest", async () => {
    const ctx = await setup();
    const first = await runOnce(ctx, "explore");
    expect(first.message.ok).toBe(true);
    expect(first.row).toMatchObject({ status: "succeeded", purpose: "explore", gatePassed: null });
    expect(first.row.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((first.row.report as { coins: unknown[] }).coins.length).toBe(1);
    expect(first.row.variantsTried).toBeGreaterThan(1);
    expect(await db.select().from(tradingBacktestHoldoutReads).where(eq(tradingBacktestHoldoutReads.strategyId, ctx.strategy.id))).toHaveLength(0);
    const trials = await db.select().from(tradingBacktestTrials).where(eq(tradingBacktestTrials.strategyId, ctx.strategy.id));
    expect(trials).toHaveLength(first.row.variantsTried);

    // The same run again (same as-of time, same rules): the same bytes.
    const second = await runOnce(ctx, "explore");
    expect(second.row.resultDigest).toBe(first.row.resultDigest);
    expect(JSON.stringify(second.row.report)).toBe(JSON.stringify(first.row.report));
    // No new variants: the registry counts each distinct variant once.
    expect(await ctx.trading.backtests.trialCount(ctx.companyId, ctx.strategy.id)).toBe(first.row.variantsTried);
  }, 300_000);

  it("a gate run reads the holdout once as clean; the second read is labelled 'already seen' and cannot clear the gate", async () => {
    const ctx = await setup();
    const first = await runOnce(ctx, "gate");
    expect(first.row.status).toBe("succeeded");
    expect((first.row.report as { holdout: { label: string; read: boolean } }).holdout).toMatchObject({ read: true, label: "clean holdout: the first read" });
    const reads = await db.select().from(tradingBacktestHoldoutReads).where(eq(tradingBacktestHoldoutReads.strategyId, ctx.strategy.id));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.seenCount).toBe(0);
    // Synthetic noise does not pass: the start gate stays shut.
    expect(first.row.gatePassed).toBe(false);

    const second = await runOnce(ctx, "gate");
    expect((second.row.report as { holdout: { label: string } }).holdout.label).toBe("holdout already seen 1 time");
    expect(second.row.gatePassed).toBe(false);
    const after = await db.select().from(tradingBacktestHoldoutReads).where(eq(tradingBacktestHoldoutReads.strategyId, ctx.strategy.id));
    expect(after.map((r) => r.seenCount).sort()).toEqual([0, 1]);
  }, 300_000);

  it("with no candles stored for the coin it finishes with an honest 'no data' report and a closed gate, instead of inventing a result", async () => {
    const ctx = await setup();
    const eth = await ctx.trading.createStrategy(ctx.companyId, { ...INPUT, name: "No data", asset: "ETH" }, { actorType: "user", actorId: "owner-1" });
    const queued = await ctx.trading.backtests.queueRun(ctx.companyId, eth.id, { purpose: "gate" }, { type: "user", id: "owner-1" });
    await ctx.trading.backtests.claimNextRun();
    const message = await spawnBacktestWorker({ databaseUrl: connectionString, runId: queued.id, companyId: ctx.companyId, maxWallMs: 5 * 60_000 }, 6 * 60_000);
    expect(message.ok).toBe(true);
    const [row] = await db.select().from(tradingBacktestRuns).where(eq(tradingBacktestRuns.id, queued.id));
    expect(row).toMatchObject({ status: "succeeded", gatePassed: false });
    const report = row!.report as { skippedCoins: Array<{ coin: string; reason: string }>; gate: { items: Array<{ key: string; passed: boolean | null }> } };
    expect(report.skippedCoins).toEqual([{ coin: "ETH", reason: "no 4h candles stored on kraken" }]);
    expect(report.gate.items.find((i) => i.key === "headline_coins")!.passed).toBe(false);
    expect(report.gate.items.find((i) => i.key === "trades")!.passed).toBe(false);
  }, 120_000);
});
