import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, companyCryptoSettings, createDb, tradingLedgerEntries, tradingOrders, tradingPredictions, tradingStrategies, tradingStrategyVersions, type Db } from "@paperclipai/db";
import { TRADING_LLM_FORECASTER_KEY, tradingTimeframeMs, type CreateTradingStrategyInput, type TradingCandle, type TradingRiskConfig } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentTradingRoutes } from "../routes/agent-trading.js";
import { tradingService } from "../services/trading.js";
import { tradingEvaluatorService } from "../services/trading-evaluator.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";

/**
 * DUR-5020: trading_log_forecast, the Trader agent's own probability calls, over HTTP with a real database.
 * The server picks the bar, the price and the time; the caller can only send a probability and a reason.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent trading forecast tests: ${support.reason ?? "unsupported environment"}`);

const TF_MS = tradingTimeframeMs("4h");
const RISK: TradingRiskConfig = {
  maxPositionNok: 1_000,
  maxTotalExposureNok: 15_000,
  maxOrdersPerDay: 20,
  dailyLossLimitNok: 1_000,
  maxDrawdownPct: 20,
  priceBandPct: 5,
  approvalAboveNok: 1_000_000_000,
  feeRatePct: 0.25,
};
const INPUT: CreateTradingStrategyInput = {
  name: "Forecast test",
  asset: "BTC",
  timeframe: "4h",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 },
  riskConfig: RISK,
};

/** Oldest-first bars, the last one CLOSING at `lastClose`. */
function barsClosingAt(count: number, lastClose: Date, finalClose = 21): TradingCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = i === count - 1 ? finalClose : 20;
    return { openTime: new Date(lastClose.getTime() - (count - i) * TF_MS), open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 };
  });
}

d("trading_log_forecast route (DUR-5020)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  const close = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-trading-forecasts");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  const market = (lastClose = close) => fakeTradingMarketData({ candles: { BTC: { candles: barsClosingAt(40, lastClose) } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: new Date() } } });

  function app(companyId: string, agentId: string, over: { now?: Date; marketData?: ReturnType<typeof market> } = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_jwt", agentId, companyId, runId: randomUUID() };
      next();
    });
    const now = over.now ?? new Date(close.getTime() + 60_000);
    a.use("/api", agentTradingRoutes(db, { marketData: over.marketData ?? market(), now: () => now }));
    a.use(errorHandler);
    return a;
  }

  function boardApp(companyId: string) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "user-1", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] };
      next();
    });
    a.use("/api", agentTradingRoutes(db, { marketData: market(), now: () => new Date(close.getTime() + 60_000) }));
    a.use(errorHandler);
    return a;
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Forecast Co", issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const traderId = randomUUID();
    const otherId = randomUUID();
    await db.insert(agents).values([
      { id: traderId, companyId, name: "Trader", role: "analyst" },
      { id: otherId, companyId, name: "Other agent", role: "engineer" },
    ]);
    await db.insert(companyCryptoSettings).values({ companyId, traderAgentId: traderId });
    const strategy = await tradingService(db, { marketData: market() }).createStrategy(companyId, INPUT, { actorType: "user", actorId: "owner-1" });
    return { companyId, traderId, otherId, strategyId: strategy.id };
  }

  const url = (strategyId: string) => `/api/agent-trading/strategies/${strategyId}/forecasts`;
  const body = (over: Record<string, unknown> = {}) => ({ probabilityUp: 0.7, reason: "The bar closed above its range after a quiet week.", ...over });
  const rowsOf = (strategyId: string) => db.select().from(tradingPredictions).where(and(eq(tradingPredictions.strategyId, strategyId), eq(tradingPredictions.forecasterKind, "llm")));

  it("logs the call as forecaster_kind 'llm' on the newest closed bar, with the server's clock and the bar's own close as the reference", async () => {
    const s = await seed();
    const before = Date.now();
    const res = await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ forecasterKey: TRADING_LLM_FORECASTER_KEY, direction: "up", probabilityUp: 0.7, referencePrice: 21 });
    const [row] = await rowsOf(s.strategyId);
    expect(row).toMatchObject({ forecasterKind: "llm", forecasterKey: "llm:trader", probability: 0.7, probabilitySource: "llm", direction: "up", referencePrice: 21, asset: "BTC", outcome: null, resolvedAt: null });
    expect(row!.barCloseAt.getTime()).toBe(close.getTime());
    expect(row!.dataCutoffAt.getTime()).toBe(close.getTime());
    // decided_at is the database's clock at insert time, not the bar's close and not anything the caller sent
    expect(row!.decidedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row!.decidedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(row!.indicatorSnapshot).toMatchObject({ source: "llm_trader", reason: "The bar closed above its range after a quiet week." });
    const [log] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "trading.trader_logged_forecast")));
    expect(log?.agentId).toBe(s.traderId);
    expect(JSON.stringify(log?.details)).not.toContain("quiet week"); // the free text stays in the ledger row only
  });

  it("derives the side from the probability, and refuses 0, 1 and exactly 50%", async () => {
    const s = await seed();
    expect((await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body({ probabilityUp: 0.3 }))).body.direction).toBe("down");
    for (const probabilityUp of [0, 1, 0.5, 1.2, -0.1, "0.7", null]) {
      const res = await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body({ probabilityUp }));
      expect(res.status).toBe(400);
    }
    expect(await rowsOf(s.strategyId)).toHaveLength(1);
  });

  it("cannot be backdated: no time, bar, price, version or kind field is accepted, and a stale bar is refused", async () => {
    const s = await seed();
    const longAgo = new Date(close.getTime() - 3 * TF_MS).toISOString();
    for (const extra of [{ decidedAt: longAgo }, { decided_at: longAgo }, { barCloseAt: longAgo }, { dataCutoffAt: longAgo }, { referencePrice: 1 }, { specVersion: 1 }, { forecasterKind: "rule" }, { forecasterKey: "rule" }, { outcome: "hit" }]) {
      const res = await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await rowsOf(s.strategyId)).toHaveLength(0);
    // 20 minutes after the close: the reference price is that bar's close, so the call is too late for it
    const late = await request(app(s.companyId, s.traderId, { now: new Date(close.getTime() + 20 * 60_000) })).post(url(s.strategyId)).send(body());
    expect(late.status).toBe(409);
    expect(late.body.details?.reason ?? late.body.reason).toBe("bar_too_old");
    // the exchange has not published the newest bar: the previous bar is never used instead
    const lagging = await request(app(s.companyId, s.traderId, { marketData: market(new Date(close.getTime() - TF_MS)) })).post(url(s.strategyId)).send(body());
    expect(lagging.status).toBe(409);
    expect(await rowsOf(s.strategyId)).toHaveLength(0);
  });

  it("accepts a call at the close + 14 minutes for the default 4h x 6 strategy (the window is the full 15 minutes: 2% of the horizon is 28.8)", async () => {
    const s = await seed();
    const res = await request(app(s.companyId, s.traderId, { now: new Date(close.getTime() + 14 * 60_000) })).post(url(s.strategyId)).send(body());
    expect(res.status).toBe(201);
    // ...and refuses it a minute after the 15-minute window, with the plain stale-bar reason
    const s2 = await seed();
    const late = await request(app(s2.companyId, s2.traderId, { now: new Date(close.getTime() + 16 * 60_000) })).post(url(s2.strategyId)).send(body());
    expect(late.status).toBe(409);
    expect(late.body.details?.reason ?? late.body.reason).toBe("bar_too_old");
  });

  it("refuses a call at the close + 14 minutes for a 15m x 1 strategy: the window is 2% of the horizon (18 seconds), not 15 minutes", async () => {
    const s = await seed();
    // the same strategy, moved to a new approved version with a 15-minute decision bar that predicts one bar ahead (a version's rules never change in place)
    const [strategy] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, s.strategyId));
    const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, strategy!.activeVersionId!));
    const spec = version!.spec as any;
    await db.update(tradingStrategyVersions).set({ status: "superseded", supersededAt: new Date() }).where(eq(tradingStrategyVersions.id, version!.id));
    const [short] = await db
      .insert(tradingStrategyVersions)
      .values({
        companyId: s.companyId,
        strategyId: s.strategyId,
        version: version!.version + 1,
        spec: { ...spec, universe: { ...spec.universe, decisionTimeframe: "15m" }, prediction: { ...spec.prediction, horizonBars: 1 } },
        status: "approved",
        proposedByType: "user",
        proposedById: "owner-1",
        approvedByUserId: "owner-1",
        approvedAt: new Date(),
        specDigest: "a".repeat(64),
      })
      .returning();
    await db.update(tradingStrategies).set({ activeVersionId: short!.id }).where(eq(tradingStrategies.id, s.strategyId));
    const close15 = new Date(Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000);
    const late = await request(app(s.companyId, s.traderId, { now: new Date(close15.getTime() + 14 * 60_000) })).post(url(s.strategyId)).send(body());
    expect(late.status).toBe(409);
    expect(late.body.details?.reason ?? late.body.reason).toBe("look_ahead_window");
    expect(late.body.details?.windowMs ?? late.body.windowMs).toBe(18_000);
    expect(JSON.stringify(late.body)).toContain("18 seconds");
    expect(await rowsOf(s.strategyId)).toHaveLength(0);
  });

  it("keeps one call per strategy and bar, and never replaces it", async () => {
    const s = await seed();
    expect((await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body())).status).toBe(201);
    const again = await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body({ probabilityUp: 0.2, reason: "Changed my mind after seeing the move." }));
    expect(again.status).toBe(409);
    const rows = await rowsOf(s.strategyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.probability).toBe(0.7);
  });

  it("refuses everyone but the company's designated Trader with 403, and another company's strategy is not found", async () => {
    const s = await seed();
    const other = await seed();
    const res = await request(app(s.companyId, s.otherId)).post(url(s.strategyId)).send(body());
    expect(res.status).toBe(403);
    expect((await request(boardApp(s.companyId)).post(url(s.strategyId)).send(body())).status).toBe(403);
    // another company's Trader is designated in its own company only
    const crossCompany = await request(app(other.companyId, other.traderId)).post(url(s.strategyId)).send(body());
    expect(crossCompany.status).toBe(404);
    // the Trader of company A cannot reach company B by claiming B's id: the company comes from the token
    expect(await rowsOf(s.strategyId)).toHaveLength(0);
    expect(await rowsOf(other.strategyId)).toHaveLength(0);
  });

  it("has no path to an order: no order, no ledger entry and no change to the strategy row", async () => {
    const s = await seed();
    const [strategyBefore] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, s.strategyId));
    const ledgerBefore = await db.select({ id: tradingLedgerEntries.id }).from(tradingLedgerEntries).where(eq(tradingLedgerEntries.companyId, s.companyId));
    expect((await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body({ probabilityUp: 0.99 }))).status).toBe(201);
    expect(await db.select({ id: tradingOrders.id }).from(tradingOrders).where(eq(tradingOrders.companyId, s.companyId))).toHaveLength(0);
    expect(await db.select({ id: tradingLedgerEntries.id }).from(tradingLedgerEntries).where(eq(tradingLedgerEntries.companyId, s.companyId))).toHaveLength(ledgerBefore.length);
    const [strategyAfter] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, s.strategyId));
    expect(strategyAfter).toEqual(strategyBefore);
  });

  it("shows up on the scoreboard as its own forecaster next to the rules and baselines", async () => {
    const s = await seed();
    await request(app(s.companyId, s.traderId)).post(url(s.strategyId)).send(body());
    const board = await tradingEvaluatorService(db).scoreboard(s.companyId, s.strategyId);
    const llm = board.forecasters.find((f) => f.forecasterKey === TRADING_LLM_FORECASTER_KEY);
    expect(llm).toMatchObject({ calls: 1, pending: 1, resolved: 0 });
  });

  it("is never read by a backtest or an experiment: no past-data module touches the prediction ledger", () => {
    const dir = path.resolve(__dirname, "../services");
    const offenders = readdirSync(dir)
      .filter((f) => /^trading-(backtest|experiment|gate|walk)/.test(f) && f.endsWith(".ts"))
      .filter((f) => /tradingPredictions|trading_predictions/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
