import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, companies, tradingLedgerEntries, tradingOrders, tradingPredictionVerdicts, tradingPredictions, tradingStrategies, tradingStrategyVersions, type Db } from "@paperclipai/db";
import {
  legacySmaCrossoverSpec,
  tradingTimeframeMs,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.ts";
import { tradingVersionsService, tradingRuleBookDigest } from "../services/trading-versions.ts";
import { tradingEvaluatorService } from "../services/trading-evaluator.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";

/**
 * DUR-5010: the evaluator chain against a real Postgres. The database stamps
 * decided_at with its own clock, so a prediction can only be written for a bar
 * that has really closed; those tests build their bars from the real clock.
 * The resolver tests seed old, matured predictions with triggers off (the way
 * a long-running instance would have them) because a test cannot wait a day.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping trading evaluator tests: ${support.reason ?? "unsupported environment"}`);

const TF = "4h" as const;
const TF_MS = tradingTimeframeMs(TF);
const RISK: TradingRiskConfig = {
  maxPositionNok: 5_000,
  maxTotalExposureNok: 15_000,
  maxOrdersPerDay: 20,
  dailyLossLimitNok: 1_000,
  maxDrawdownPct: 20,
  priceBandPct: 5,
  approvalAboveNok: 1_000_000_000,
  feeRatePct: 0.25,
};

/** Oldest-first bars for the closes, the last bar CLOSING at `lastClose`. */
function barsClosingAt(closes: number[], lastClose: Date): TradingCandle[] {
  return closes.map((close, i) => ({
    openTime: new Date(lastClose.getTime() - (closes.length - i) * TF_MS),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1,
  }));
}

/** A cross up on the last bar (SMA 2/3). */
const WARM = Array.from({ length: 18 }, () => 20);
const CROSS_UP = [...WARM, 20, 20, 20, 21];
const NO_SIGNAL = [...WARM, 20, 20, 20, 20];

d("tradingEvaluatorService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-evaluator");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  async function seedStrategy(overrides: { prediction?: Partial<TradingStrategySpec["prediction"]>; status?: "running" | "paused" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Eval Co", issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const strategyId = randomUUID();
    await db.insert(tradingStrategies).values({
      id: strategyId,
      companyId,
      name: "S",
      asset: "BTC",
      timeframe: TF,
      status: overrides.status ?? "paused",
      ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 },
      riskConfig: RISK,
      startingCashNok: 2_000,
      cashNok: 2_000,
      peakEquityNok: 2_000,
    });
    const base = legacySmaCrossoverSpec({ name: "S", asset: "BTC", timeframe: TF, rule: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 }, risk: RISK });
    const spec: TradingStrategySpec = { ...base, prediction: { ...base.prediction, horizonBars: 6, ...overrides.prediction } };
    const [version] = await db
      .insert(tradingStrategyVersions)
      .values({
        companyId,
        strategyId,
        version: 1,
        spec,
        guidelines: "",
        status: "approved",
        proposedByType: "system",
        proposedById: "test",
        approvedAt: new Date(),
        grandfathered: true,
        specDigest: tradingRuleBookDigest({ spec, guidelines: "" }),
      })
      .returning();
    await db.update(tradingStrategies).set({ activeVersionId: version!.id }).where(eq(tradingStrategies.id, strategyId));
    return { companyId, strategyId, versionId: version!.id, spec };
  }

  /** Insert matured, resolved-or-not predictions with triggers off, like rows from weeks ago. */
  async function seedOld(rows: Array<typeof tradingPredictions.$inferInsert>) {
    await db.transaction(async (tx) => {
      await tx.execute(`SET LOCAL session_replication_role = replica` as never);
      await tx.insert(tradingPredictions).values(rows);
    });
  }

  function oldRow(s: { companyId: string; strategyId: string }, i: number, over: Partial<typeof tradingPredictions.$inferInsert> = {}): typeof tradingPredictions.$inferInsert {
    const closeAt = new Date(Date.UTC(2026, 0, 1) + i * TF_MS);
    return {
      companyId: s.companyId,
      strategyId: s.strategyId,
      specVersion: 1,
      forecasterKind: "rule",
      forecasterKey: "rule",
      asset: "BTC",
      timeframe: TF,
      barCloseAt: closeAt,
      decidedAt: new Date(closeAt.getTime() + 60_000),
      dataCutoffAt: closeAt,
      horizonBars: 1,
      resolvesAt: new Date(closeAt.getTime() + TF_MS),
      direction: "up",
      referencePrice: 100,
      flatBandPct: 0.45,
      ...over,
    };
  }

  it("writes the rule's call and the three baselines before the outcome, once per bar", async () => {
    const s = await seedStrategy();
    const close = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);
    const marketData = fakeTradingMarketData({ candles: { BTC: { candles: barsClosingAt(CROSS_UP, close) } } });
    const evaluator = tradingEvaluatorService(db, { marketData });
    await evaluator.boot(new Date(close.getTime() - 60_000));
    const now = new Date(close.getTime() + 60_000);
    const first = await evaluator.tick(now);
    expect(first.predictionsWritten).toBe(4);
    const rows = await db.select().from(tradingPredictions).where(eq(tradingPredictions.strategyId, s.strategyId));
    expect(rows.map((r) => r.forecasterKey).sort()).toEqual(["baseline:always_up", "baseline:coin_flip", "baseline:persistence", "rule"]);
    const rule = rows.find((r) => r.forecasterKey === "rule")!;
    expect(rule).toMatchObject({ direction: "up", forecasterKind: "rule", probability: null, probabilitySource: null, outcome: null, resolvedAt: null, horizonBars: 6, referencePrice: 21 });
    expect(rule.barCloseAt.getTime()).toBe(close.getTime());
    expect(rule.dataCutoffAt.getTime()).toBe(close.getTime());
    expect(rule.decidedAt.getTime()).toBeGreaterThan(rule.dataCutoffAt.getTime() - 1);
    expect(rule.resolvesAt.getTime()).toBe(close.getTime() + 6 * TF_MS);
    expect(rule.rDistance).toBeGreaterThan(0);
    // A second tick on the same bar writes nothing.
    expect((await evaluator.tick(new Date(close.getTime() + 120_000))).predictionsWritten).toBe(0);
    expect(await db.select({ id: tradingPredictions.id }).from(tradingPredictions).where(eq(tradingPredictions.strategyId, s.strategyId))).toHaveLength(4);
  });

  it("makes no rule call when the rule has nothing to say, but the baselines still call", async () => {
    const s = await seedStrategy();
    const close = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);
    const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({ candles: { BTC: { candles: barsClosingAt(NO_SIGNAL, close) } } }) });
    await evaluator.boot(new Date(close.getTime() - 60_000));
    expect((await evaluator.tick(new Date(close.getTime() + 60_000))).predictionsWritten).toBe(3);
    const rows = await db.select().from(tradingPredictions).where(eq(tradingPredictions.strategyId, s.strategyId));
    expect(rows.some((r) => r.forecasterKey === "rule")).toBe(false);
  });

  it("keeps logging after a simulated restart while the paper order path stays paused; the gap is written and downtime bars are never backfilled", async () => {
    const s = await seedStrategy({ status: "running" });
    const close3 = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);
    const close2 = new Date(close3.getTime() - TF_MS);
    const close1 = new Date(close2.getTime() - TF_MS);
    const candlesAt = (close: Date) => fakeTradingMarketData({ candles: { BTC: { candles: barsClosingAt(CROSS_UP, close) } } });

    // Before the crash: the evaluator runs for bar 1.
    const before = tradingEvaluatorService(db, { marketData: candlesAt(close1) });
    await before.boot(new Date(close1.getTime() - 60_000));
    await before.tick(new Date(close1.getTime() + 60_000));
    const forBar = (close: Date) => db.select().from(tradingPredictions).where(and(eq(tradingPredictions.strategyId, s.strategyId), eq(tradingPredictions.barCloseAt, close)));
    expect(await forBar(close1)).toHaveLength(4);
    const heartbeatBeforeCrash = new Date(close1.getTime() + 60_000);

    // The process restarts one bar later. The paper order path pauses ...
    const restartedAt = new Date(close2.getTime() + 60_000);
    const trading = tradingService(db, { now: () => restartedAt, marketData: fakeTradingMarketData({}) });
    await trading.reconcileOnBoot();
    const paused = await trading.requireStrategy(s.companyId, s.strategyId);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("restart");

    // ... the evaluator starts by itself, and records the gap.
    const after = tradingEvaluatorService(db, { marketData: candlesAt(close3) });
    const bootResult = await after.boot(restartedAt);
    expect(bootResult.gapFrom?.getTime()).toBe(heartbeatBeforeCrash.getTime());
    expect(bootResult.gapMs).toBe(restartedAt.getTime() - heartbeatBeforeCrash.getTime());
    const gaps = await db.select().from(tradingLedgerEntries).where(and(eq(tradingLedgerEntries.strategyId, s.strategyId), eq(tradingLedgerEntries.eventType, "evaluator_gap")));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.strategyVersionId).toBe(s.versionId);
    expect(gaps[0]!.detail).toMatchObject({ from: heartbeatBeforeCrash.toISOString(), to: restartedAt.toISOString(), seconds: bootResult.gapMs / 1000 });

    // The bar that closed during the downtime (close2) is never predicted, even though the exchange still serves it.
    const stale = tradingEvaluatorService(db, { marketData: candlesAt(close2) });
    await stale.boot(restartedAt);
    await stale.tick(new Date(close2.getTime() + 120_000));
    expect(await forBar(close2)).toHaveLength(0);

    // The next bar after the restart is predicted normally.
    await after.tick(new Date(close3.getTime() + 60_000));
    expect(await forBar(close3)).toHaveLength(4);

    // The order path is still paused and placed nothing.
    const stillPaused = await trading.requireStrategy(s.companyId, s.strategyId);
    expect(stillPaused.status).toBe("paused");
    expect(await db.select({ id: tradingOrders.id }).from(tradingOrders).where(eq(tradingOrders.strategyId, s.strategyId))).toHaveLength(0);
  });

  it("does nothing for a bar the exchange has not published yet", async () => {
    const s = await seedStrategy();
    const close = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);
    const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({ candles: { BTC: { candles: barsClosingAt(CROSS_UP, new Date(close.getTime() - TF_MS)) } } }) });
    await evaluator.boot(new Date(close.getTime() - 60_000));
    expect((await evaluator.tick(new Date(close.getTime() + 60_000))).predictionsWritten).toBe(0);
    expect(await db.select().from(tradingPredictions).where(eq(tradingPredictions.strategyId, s.strategyId))).toHaveLength(0);
  });

  describe("the resolver", () => {
    it("resolves from closed candles, records MFE/MAE, and marks the non-overlapping independent subset", async () => {
      const s = await seedStrategy({ prediction: { horizonBars: 2 } });
      // Three calls on consecutive 4h bars, 2-bar horizon: the 1st and 3rd do not overlap, the 2nd overlaps the 1st.
      const rows = [0, 1, 2].map((i) => oldRow(s, i, { horizonBars: 2, resolvesAt: new Date(Date.UTC(2026, 0, 1) + (i + 2) * TF_MS) }));
      await seedOld(rows);
      const start = Date.UTC(2026, 0, 1);
      // Bars open at call close .. ; reference 100 for every call. Closes: bar0 (opens at call 0) .. bar5.
      const closes = [101, 103, 104, 99, 98, 106];
      const bars: TradingCandle[] = closes.map((c, i) => ({ openTime: new Date(start + i * TF_MS), open: 100, high: c + 1, low: c - 1, close: c, volume: 1 }));
      const now = new Date(start + 10 * TF_MS);
      const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({ candles: { BTC: { candles: bars } } }) });
      expect(await evaluator.resolveDue(now)).toBe(3);
      const after = await db.select().from(tradingPredictions).where(eq(tradingPredictions.strategyId, s.strategyId));
      const byBar = [...after].sort((a, b) => a.barCloseAt.getTime() - b.barCloseAt.getTime());
      // Call 0: window bars 0,1 -> final close bars[1]=103 -> +3% hit ; MFE = (104/100-1)=4% ; MAE = min(0, 100/100-1)=0
      expect(byBar[0]).toMatchObject({ outcome: "hit", independent: true, resolverVersion: 1 });
      expect(byBar[0]!.realizedReturn).toBeCloseTo(0.03, 12);
      expect(byBar[0]!.mfe).toBeCloseTo(0.04, 12);
      expect(byBar[0]!.mae).toBeCloseTo(0, 12);
      // Call 1: window bars 1,2 -> final close 104 -> +4% hit, overlaps call 0 -> not independent
      expect(byBar[1]).toMatchObject({ outcome: "hit", independent: false });
      // Call 2: window bars 2,3 -> final close 99 -> -1% miss for an "up" call ; starts when call 0 ended -> independent
      expect(byBar[2]).toMatchObject({ outcome: "miss", independent: true });
      expect(byBar[2]!.realizedReturn).toBeCloseTo(-0.01, 12);
      expect(byBar[2]!.mae).toBeCloseTo(98 / 100 - 1, 12); // low of bar 3 is 98
      // Resolving again changes nothing.
      expect(await evaluator.resolveDue(now)).toBe(0);
    });

    it("leaves a call pending until its outcome bar exists, and never resolves a call whose time has not come", async () => {
      const s = await seedStrategy();
      await seedOld([oldRow(s, 0)]);
      const start = Date.UTC(2026, 0, 1);
      const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({ candles: { BTC: { candles: [{ openTime: new Date(start - TF_MS), open: 1, high: 2, low: 1, close: 1.5, volume: 1 }] } } }) });
      expect(await evaluator.resolveDue(new Date(start + 5 * TF_MS))).toBe(0);
      expect(await evaluator.resolveDue(new Date(start + 1000))).toBe(0); // before resolves_at
    });
  });

  describe("no verdict before N", () => {
    async function seedResolved(s: { companyId: string; strategyId: string }, n: number) {
      await seedOld(
        Array.from({ length: n }, (_, i) =>
          oldRow(s, i, {
            resolvedAt: new Date(Date.UTC(2026, 0, 1) + (i + 1) * TF_MS + 1000),
            outcome: i % 3 === 0 ? "miss" : "hit",
            realizedReturn: i % 3 === 0 ? -0.02 : 0.02,
            mfe: 0.02,
            mae: 0,
            resolverVersion: 1,
            independent: true,
            indicatorSnapshot: { baseRateUp: 0.5 },
          }),
        ),
      );
    }

    it("stays collecting below the planned sample size, even with a long running time", async () => {
      const s = await seedStrategy(); // default plan: 620 samples, 90 days
      await seedResolved(s, 25);
      const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({}) });
      expect(await evaluator.computeVerdicts(new Date(Date.UTC(2027, 0, 1)))).toBe(0);
      expect(await db.select().from(tradingPredictionVerdicts).where(eq(tradingPredictionVerdicts.strategyId, s.strategyId))).toHaveLength(0);
      const board = await evaluator.scoreboard(s.companyId, s.strategyId);
      expect(board.status).toMatchObject({ status: "collecting", samples: 25, targetSamples: 620 });
      // While collecting, no hit rate is presented for any forecaster.
      expect(board.forecasters.every((f) => f.hitRate === null && f.hitRateInterval === null)).toBe(true);
      expect(board.verdict).toBeNull();
    });

    it("writes the verdict once when the sample size and the running time are both reached", async () => {
      const s = await seedStrategy({ prediction: { targetSamples: 20, minRunningDays: 1 } });
      await seedResolved(s, 24);
      const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({}) });
      // Enough samples, but "now" is inside the first day of calendar time: not yet.
      expect(await evaluator.computeVerdicts(new Date(Date.UTC(2026, 0, 1, 2)))).toBe(0);
      const later = new Date(Date.UTC(2026, 0, 20));
      // The database's own clock must also agree that the period has passed (it does: its clock is November 2026 or later).
      expect(await evaluator.computeVerdicts(later)).toBe(1);
      expect(await evaluator.computeVerdicts(later)).toBe(0); // computed once
      const [verdict] = await db.select().from(tradingPredictionVerdicts).where(eq(tradingPredictionVerdicts.strategyId, s.strategyId));
      expect(verdict).toMatchObject({ targetSamples: 20, minRunningDays: 1, specVersion: 1, forecasterKey: "rule" });
      expect(verdict!.samplesCounted).toBe(24);
      expect((verdict!.verdict as { result: string }).result).toMatch(/edge_in_direction|no_edge/);
      const board = await evaluator.scoreboard(s.companyId, s.strategyId);
      expect(board.status.status).toBe("ready");
      expect(board.verdict).not.toBeNull();
      const rule = board.forecasters.find((f) => f.forecasterKey === "rule")!;
      expect(rule.hitRate).toBeCloseTo(16 / 24, 12);
    });
  });

  it("running time is calendar time minus the gap events", async () => {
    const s = await seedStrategy({ prediction: { targetSamples: 20, minRunningDays: 0 } });
    await seedOld([oldRow(s, 0)]);
    const first = Date.UTC(2026, 0, 1);
    const writeGap = (fromH: number, toH: number) =>
      db.insert(tradingLedgerEntries).values({ companyId: s.companyId, strategyId: s.strategyId, strategyVersionId: s.versionId, eventType: "evaluator_gap", detail: { from: new Date(first + fromH * 3_600_000).toISOString(), to: new Date(first + toH * 3_600_000).toISOString() } });
    await writeGap(2, 6);
    await writeGap(5, 8);
    const evaluator = tradingEvaluatorService(db, { marketData: fakeTradingMarketData({}) });
    // `now` of the scoreboard is the real clock, so check the pure helper's contract through the stored gaps instead:
    const board = await evaluator.scoreboard(s.companyId, s.strategyId);
    expect(board.time!.gapMs).toBe(6 * 3_600_000); // hours 2-8 once
    expect(board.time!.runningMs).toBe(board.time!.calendarMs - 6 * 3_600_000);
  });
});

void tradingVersionsService;
