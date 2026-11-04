import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, tradingBacktestHoldoutReads, tradingBacktestTrials, tradingExperiments, type Db } from "@paperclipai/db";
import { type CreateTradingStrategyInput, type TradingEngineBar } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";
import { insertCandles } from "../services/trading-candle-store.js";
import { spawnExperimentWorker } from "../services/trading-backtest-runner.js";
import { tradingExperimentStore } from "../services/trading-experiment-store.js";

/**
 * DUR-5018: the whole experiment path with the real worker thread: queue an
 * experiment, claim it, let the worker read candles from the store and write
 * the report, trial counts and recommendation, then read them back. Candles are
 * synthetic (a seeded random walk); nothing touches the network.
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

d("experiment, real worker thread (DUR-5018)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  let connectionString = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-experiment-worker");
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
    await db.insert(companies).values({ id: companyId, name: "Worker Co", issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const trading = tradingService(db, { now: () => NOW, marketData: fakeTradingMarketData({ candles: { BTC: { candles: [] } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: NOW } } }) });
    const strategy = await trading.createStrategy(companyId, INPUT, { actorType: "user", actorId: "owner-1" });
    return { companyId, trading, strategy, store: tradingExperimentStore(db, { now: () => NOW }) };
  }

  async function runOnce(ctx: Awaited<ReturnType<typeof setup>>, grid?: Array<{ indicator: string; param: "period" | "lookback" | "stdDev"; values: number[] }>) {
    const queued = await ctx.store.queueExperiment(ctx.companyId, ctx.strategy.id, grid ? { grid } : {}, { type: "user", id: "owner-1" });
    const claimed = await ctx.store.claimNextExperiment();
    expect(claimed?.id).toBe(queued.id);
    const message = await spawnExperimentWorker({ databaseUrl: connectionString, experimentId: queued.id, companyId: ctx.companyId, maxWallMs: 5 * 60_000 }, 6 * 60_000);
    const [row] = await db.select().from(tradingExperiments).where(eq(tradingExperiments.id, queued.id));
    return { message, row: row! };
  }

  it("writes the report with trial counts, Deflated Sharpe, plateau and holdout reads; never reads the holdout; the same experiment twice gives the same digest", async () => {
    const ctx = await setup();
    const grid = [{ indicator: "slow", param: "period" as const, values: [10, 20, 25] }];
    const first = await runOnce(ctx, grid);
    expect(first.message.ok).toBe(true);
    expect(first.row).toMatchObject({ status: "succeeded", trialCount: 4, registryTrialCount: 4, holdoutReadsLineage: 0 });
    expect(first.row.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    const report = first.row.report as { trialCount: number; deflatedSharpe: { trialsCounted: number }; plateau: unknown; holdoutReads: unknown; recommendation: { decision: string } };
    expect(report).toMatchObject({ trialCount: 4, deflatedSharpe: { trialsCounted: 4 }, holdoutReads: { lineageBefore: 0, madeByThisExperiment: 0 } });
    expect(report.plateau).toBeTruthy();
    expect(first.row.recommendation).toMatchObject({ decision: report.recommendation.decision });
    expect(first.row.trials).toHaveLength(4);
    // An experiment is an exploration: no holdout read, no backtest trial rows, nothing for the start gate.
    expect(await db.select().from(tradingBacktestHoldoutReads).where(eq(tradingBacktestHoldoutReads.strategyId, ctx.strategy.id))).toHaveLength(0);
    expect(await db.select().from(tradingBacktestTrials).where(eq(tradingBacktestTrials.strategyId, ctx.strategy.id))).toHaveLength(0);
    // What it tried counts for the strategy now.
    expect(await ctx.trading.backtests.trialCount(ctx.companyId, ctx.strategy.id)).toBe(4);

    // The same experiment again (same as-of time, same rules, same grid): the same variants (none new), and the report differs
    // only in the registry count it was judged against... so compare the parts that must not move.
    const second = await runOnce(ctx, grid);
    expect(second.row.trials).toEqual(first.row.trials);
    expect(second.row.registryTrialCount).toBe(4);
    expect(second.row.resultDigest).toBe(first.row.resultDigest);
    expect(JSON.stringify(second.row.report)).toBe(JSON.stringify(first.row.report));
    expect(await ctx.trading.backtests.trialCount(ctx.companyId, ctx.strategy.id)).toBe(4);
  }, 300_000);

  it("on noise the answer is 'no change': no recommended variant, no recommended rules, and the reason is in the checks", async () => {
    const ctx = await setup();
    const run = await runOnce(ctx);
    expect(run.row.status).toBe("succeeded");
    expect(run.row).toMatchObject({ recommendedVariantDigest: null, recommendedSpec: null });
    expect(run.row.recommendation).toMatchObject({ decision: "no_change" });
    expect((run.row.recommendation as { checks: Array<{ passed: boolean }> }).checks.some((c) => !c.passed)).toBe(true);
    expect(run.row.trialCount).toBeGreaterThan(1);
  }, 300_000);

  it("with no candles stored for the coin it still finishes, honestly, with 'no change' and nothing to compare", async () => {
    const ctx = await setup();
    const eth = await ctx.trading.createStrategy(ctx.companyId, { ...INPUT, name: "No data", asset: "ETH" }, { actorType: "user", actorId: "owner-1" });
    const queued = await ctx.store.queueExperiment(ctx.companyId, eth.id, {}, { type: "user", id: "owner-1" });
    await ctx.store.claimNextExperiment();
    const message = await spawnExperimentWorker({ databaseUrl: connectionString, experimentId: queued.id, companyId: ctx.companyId, maxWallMs: 5 * 60_000 }, 6 * 60_000);
    const [row] = await db.select().from(tradingExperiments).where(eq(tradingExperiments.id, queued.id));
    expect(message).toMatchObject({ ok: true, decision: "no_change" });
    expect(row).toMatchObject({ status: "succeeded", recommendedVariantDigest: null });
    expect((row!.recommendation as { summary: string }).summary).toMatch(/^No change: No other variant/);
  }, 120_000);
});
