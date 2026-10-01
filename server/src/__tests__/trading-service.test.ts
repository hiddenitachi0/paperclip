import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, type Db } from "@paperclipai/db";
import { usdToNok, type CreateTradingStrategyInput, type TradingRiskConfig, type TradingRuleConfig } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.ts";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";

/**
 * DUR-4171: end-to-end coverage for the tick loop (services/trading.ts),
 * the piece the pure rule-engine (packages/shared/src/trading.test.ts) and
 * risk-gate (trading-risk-gate.test.ts) unit tests deliberately don't touch
 * -- how a signal actually becomes a filled paper order, a FIFO lot, a
 * ledger entry and an updated strategy row, plus the two safety
 * requirements the design calls out explicitly: "starts paused after
 * restart" (reconcileOnBoot) and the kill switch (setStatus).
 *
 * Market data is the fake from trading-market-data.ts (built for exactly
 * this) -- no real network call anywhere in this file. Every fixture below
 * keeps its quote price equal to its own candles' last close (zero price-
 * band drift) and close to the previous tick's price (small drawdown), so
 * only the thing each test is actually about can block the order.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading service tests: ${support.reason ?? "unsupported environment"}`);
}

const RULE: TradingRuleConfig = { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 };

function riskConfig(overrides: Partial<TradingRiskConfig> = {}): TradingRiskConfig {
  return {
    maxPositionNok: 5_000,
    maxTotalExposureNok: 15_000,
    maxOrdersPerDay: 20,
    dailyLossLimitNok: 1_000,
    maxDrawdownPct: 20,
    priceBandPct: 5,
    approvalAboveNok: 1_000_000_000, // effectively "no approval gate" for tests not about that path -- see the dedicated null test below.
    feeRatePct: 0.25,
    ...overrides,
  };
}

const STRATEGY_INPUT: CreateTradingStrategyInput = {
  name: "Test strategy",
  asset: "BTC",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: RULE,
  riskConfig: riskConfig(),
};

/** closes=[20,20,20,21]: prevFast=prevSlow=20, curFast=20.5 > curSlow=20.333 -> buy. Quote pinned to the same 21 USD last close (zero price-band drift). */
const BUY_CANDLES = { closes: [20, 20, 20, 21], lastCandleAt: new Date("2026-01-01T00:00:00Z") };
const BUY_QUOTE_USD = 21;
/** closes=[20,20,20,19]: prevFast=prevSlow=20, curFast=19.5 < curSlow=19.667 -> sell. Only a small dip from the buy's 21, so the drawdown breaker (20% cap) doesn't also fire. */
const SELL_CANDLES = { closes: [20, 20, 20, 19], lastCandleAt: new Date("2026-01-01T00:15:00Z") };
const SELL_QUOTE_USD = 19;

d("tradingService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Trading Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("fills a buy signal: opens a FIFO lot, debits cash+fee, writes order_filled", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({
        candles: { BTC: BUY_CANDLES },
        quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } },
      }),
    });

    const strategy = await trading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await trading.setStatus(companyId, strategy.id, "running"); // writes a kill_switch ledger entry -- accounted for below.

    const result = await trading.tick(now);
    expect(result).toMatchObject({ checked: 1, filled: 1, blocked: 0, approvalRequested: 0, halted: 0 });

    // quotePriceNok = usdToNok(21); orderValueNok = orderSizeFraction*cashNok = 1000 exactly, independent of price; fee = 1000*0.0025 = 2.5.
    const quotePriceNok = usdToNok(BUY_QUOTE_USD);
    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.positionQuantity).toBeCloseTo(1_000 / quotePriceNok, 6);
    expect(row.cashNok).toBeCloseTo(2_000 - 1_000 - 2.5, 6);
    expect(row.positionCostNok).toBeCloseTo(1_000 + 2.5, 6);

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: "buy", status: "filled" });

    const ledgerEntries = await trading.listLedgerEntries(companyId, strategy.id);
    expect(ledgerEntries.map((e) => e.eventType)).toEqual(["order_filled", "kill_switch"]); // newest first: the fill, then the earlier resume-to-running.
    expect(ledgerEntries[0]!.feeNok).toBeCloseTo(2.5, 6);

    // tick() claims due strategies across every company, not just this test's -- pause so a later test's tick() at the same clock time can't sweep this one in too.
    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("fills a sell signal after a buy: consumes the FIFO lot and realizes the correct P&L", async () => {
    const companyId = await seedCompany();
    const buyNow = new Date("2026-01-01T00:00:00Z");
    const sellNow = new Date("2026-01-01T00:15:00Z");

    const buyTrading = tradingService(db, {
      now: () => buyNow,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: buyNow } } }),
    });
    const strategy = await buyTrading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await buyTrading.setStatus(companyId, strategy.id, "running");
    await buyTrading.tick(buyNow);
    const afterBuy = await buyTrading.requireStrategy(companyId, strategy.id);

    const sellTrading = tradingService(db, {
      now: () => sellNow,
      marketData: fakeTradingMarketData({ candles: { BTC: SELL_CANDLES }, quotes: { BTC: { bidUsd: SELL_QUOTE_USD, askUsd: SELL_QUOTE_USD, at: sellNow } } }),
    });
    const result = await sellTrading.tick(sellNow);
    expect(result).toMatchObject({ checked: 1, filled: 1, blocked: 0 });

    const afterSell = await sellTrading.requireStrategy(companyId, strategy.id);
    expect(afterSell.positionQuantity).toBeCloseTo(0, 9);

    // Sells the whole position bought at BUY_QUOTE_USD, now at SELL_QUOTE_USD (a loss).
    const sellQuotePriceNok = usdToNok(SELL_QUOTE_USD);
    const quantity = afterBuy.positionQuantity;
    const orderValueNok = quantity * sellQuotePriceNok;
    const fee = orderValueNok * 0.0025;
    const proceedsNok = orderValueNok - fee;
    const costBasis = afterBuy.positionCostNok; // the buy's full cost (order value + its own fee), the whole lot is consumed
    const expectedPnl = proceedsNok - costBasis;

    const orders = await sellTrading.listOrders(companyId, strategy.id);
    const sellOrder = orders.find((o) => o.side === "sell")!;
    expect(sellOrder.realizedPnlNok).toBeCloseTo(expectedPnl, 6);
    expect(afterSell.cashNok).toBeCloseTo(afterBuy.cashNok + proceedsNok, 6);

    const ledgerEntries = await sellTrading.listLedgerEntries(companyId, strategy.id);
    const sellEntry = ledgerEntries.find((e) => e.orderId === sellOrder.id)!;
    expect(sellEntry.realizedPnlNok).toBeCloseTo(expectedPnl, 6);
    expect(sellEntry.fifoCostNok).toBeCloseTo(costBasis, 6);

    await sellTrading.setStatus(companyId, strategy.id, "paused");
  });

  it("blocks an order the risk gate rejects (position cap) without filling, and logs risk_block", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } } }),
    });
    // orderSizeFraction=1 against a tiny maxPositionNok forces the position-cap block, not a cash shortfall.
    const strategy = await trading.createStrategy(
      companyId,
      { ...STRATEGY_INPUT, ruleConfig: { ...RULE, orderSizeFraction: 1 }, riskConfig: riskConfig({ maxPositionNok: 10 }) },
      { actorType: "user", actorId: "u1" },
    );
    await trading.setStatus(companyId, strategy.id, "running");

    const result = await trading.tick(now);
    expect(result).toMatchObject({ checked: 1, filled: 0, blocked: 1 });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.positionQuantity).toBe(0);
    expect(row.cashNok).toBe(2_000); // untouched

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders[0]).toMatchObject({ status: "rejected" });

    const ledgerEntries = await trading.listLedgerEntries(companyId, strategy.id);
    expect(ledgerEntries.map((e) => e.eventType)).toEqual(["risk_block", "kill_switch"]);

    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("halts on a single-tick price jump beyond the protected circuit-breaker ceiling, without placing an order", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    // Last two closes jump 20 -> 30, a 50% single-tick move -- well past the 15% ceiling.
    // Still a "buy" signal by the SMA rule, which is the point: the breaker must fire before the rule/risk gate ever gets a say.
    const jumpCandles = { closes: [20, 20, 20, 30], lastCandleAt: now };
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: jumpCandles }, quotes: { BTC: { bidUsd: 30, askUsd: 30, at: now } } }),
    });
    const strategy = await trading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await trading.setStatus(companyId, strategy.id, "running");

    const result = await trading.tick(now);
    expect(result).toMatchObject({ checked: 1, filled: 0, blocked: 0, halted: 1 });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.status).toBe("halted_risk");
    expect(row.pauseReason).toBe("circuit_breaker");
    expect(row.cashNok).toBe(2_000); // untouched -- no order was even attempted

    expect(await trading.listOrders(companyId, strategy.id)).toHaveLength(0);

    const ledgerEntries = await trading.listLedgerEntries(companyId, strategy.id);
    expect(ledgerEntries.map((e) => e.eventType)).toEqual(["circuit_breaker", "kill_switch"]);
    expect(ledgerEntries[0]!.detail).toMatchObject({ reason: "single_tick_price_jump" });
  });

  it("requires operator approval on every trade when approvalAboveNok is null, and never fills on its own", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } } }),
    });
    const strategy = await trading.createStrategy(
      companyId,
      { ...STRATEGY_INPUT, riskConfig: riskConfig({ approvalAboveNok: null }) },
      { actorType: "user", actorId: "u1" },
    );
    await trading.setStatus(companyId, strategy.id, "running");

    const result = await trading.tick(now);
    expect(result).toMatchObject({ checked: 1, filled: 0, approvalRequested: 1 });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.cashNok).toBe(2_000); // no fill happened

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders[0]).toMatchObject({ status: "pending_approval" });
    expect(orders[0]!.approvalId).toBeTruthy();

    // resolvePendingApprovals scans pending_approval orders across every company -- reject and re-tick so this order doesn't sit there (undecided, unexpired) for a later test's own resolvePendingApprovals scan to trip over.
    await approvalService(db).reject(orders[0]!.approvalId!, "test-cleanup");
    await trading.tick(new Date(now.getTime() + 60_000));

    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("fills a pending_approval order once the operator approves it, on the next tick", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } } }),
    });
    const strategy = await trading.createStrategy(
      companyId,
      { ...STRATEGY_INPUT, riskConfig: riskConfig({ approvalAboveNok: null }) },
      { actorType: "user", actorId: "u1" },
    );
    await trading.setStatus(companyId, strategy.id, "running");
    await trading.tick(now);
    const pending = (await trading.listOrders(companyId, strategy.id))[0]!;
    expect(pending.status).toBe("pending_approval");

    await approvalService(db).approve(pending.approvalId!, "operator-1");

    // resolvePendingApprovals runs at the top of every tick, before claiming new due strategies -- the strategy itself stays paused-for-new-signals-wise, nothing else to claim here.
    const later = new Date(now.getTime() + 60_000);
    const result = await trading.tick(later);
    expect(result.approvalsResolved).toBe(1);

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders.find((o) => o.id === pending.id)).toMatchObject({ status: "rejected" }); // superseded by the fresh fill row, see resolvePendingApprovals's own comment
    const filled = orders.find((o) => o.status === "filled");
    expect(filled).toMatchObject({ side: "buy" });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.cashNok).toBeCloseTo(2_000 - 1_000 - 2.5, 6);

    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("never fills a pending_approval order the operator rejects", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } } }),
    });
    const strategy = await trading.createStrategy(
      companyId,
      { ...STRATEGY_INPUT, riskConfig: riskConfig({ approvalAboveNok: null }) },
      { actorType: "user", actorId: "u1" },
    );
    await trading.setStatus(companyId, strategy.id, "running");
    await trading.tick(now);
    const pending = (await trading.listOrders(companyId, strategy.id))[0]!;

    await approvalService(db).reject(pending.approvalId!, "operator-1");

    const later = new Date(now.getTime() + 60_000);
    const result = await trading.tick(later);
    expect(result.approvalsResolved).toBe(1);

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders).toHaveLength(1); // no fresh fill row -- unlike the approve path, a rejection never creates a second order
    expect(orders[0]).toMatchObject({ status: "rejected", rejectionReason: "The operator rejected the trade card." });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.cashNok).toBe(2_000); // untouched

    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("expires a pending_approval order nobody decided in time, without ever filling it", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: BUY_CANDLES }, quotes: { BTC: { bidUsd: BUY_QUOTE_USD, askUsd: BUY_QUOTE_USD, at: now } } }),
    });
    const strategy = await trading.createStrategy(
      companyId,
      { ...STRATEGY_INPUT, riskConfig: riskConfig({ approvalAboveNok: null }) },
      { actorType: "user", actorId: "u1" },
    );
    await trading.setStatus(companyId, strategy.id, "running");
    await trading.tick(now);

    // TRADING_TRADE_APPROVAL_EXPIRY_MS is 5 minutes -- nobody decided the card, so it's expired by the time the next tick runs.
    const later = new Date(now.getTime() + 6 * 60_000);
    const result = await trading.tick(later);
    expect(result.approvalsResolved).toBe(1);

    const orders = await trading.listOrders(companyId, strategy.id);
    expect(orders[0]).toMatchObject({ status: "expired_approval" });

    const row = await trading.requireStrategy(companyId, strategy.id);
    expect(row.cashNok).toBe(2_000); // untouched

    const ledgerEntries = await trading.listLedgerEntries(companyId, strategy.id);
    expect(ledgerEntries.map((e) => e.eventType)).toContain("order_rejected");

    await trading.setStatus(companyId, strategy.id, "paused");
  });

  it("reconcileOnBoot pauses every running strategy with pauseReason 'restart', and leaves paused ones alone", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    const trading = tradingService(db, { now: () => now, marketData: fakeTradingMarketData({}) });

    const running = await trading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await trading.setStatus(companyId, running.id, "running");
    const stillPaused = await trading.createStrategy(companyId, { ...STRATEGY_INPUT, name: "Paused strategy" }, { actorType: "user", actorId: "u1" });

    const { pausedCount } = await trading.reconcileOnBoot();
    expect(pausedCount).toBeGreaterThanOrEqual(1); // >=1, not ===1: earlier tests in this file may leave other running strategies for this same embedded db.

    const runningAfter = await trading.requireStrategy(companyId, running.id);
    expect(runningAfter.status).toBe("paused");
    expect(runningAfter.pauseReason).toBe("restart");

    const pausedAfter = await trading.requireStrategy(companyId, stillPaused.id);
    expect(pausedAfter.status).toBe("paused");
    expect(pausedAfter.pauseReason).toBeNull(); // never touched -- it was already paused, not coming back from a restart.

    const ledgerEntries = await trading.listLedgerEntries(companyId, running.id);
    expect(ledgerEntries.map((e) => e.eventType)).toContain("reconciliation");
  });

  it("the kill switch pauses and resumes, writing a kill_switch ledger entry each time", async () => {
    const companyId = await seedCompany();
    const trading = tradingService(db, { now: () => new Date("2026-01-01T00:00:00Z"), marketData: fakeTradingMarketData({}) });
    const strategy = await trading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    expect(strategy.status).toBe("paused"); // every strategy is created paused

    const resumed = await trading.setStatus(companyId, strategy.id, "running");
    expect(resumed.status).toBe("running");
    expect(resumed.pauseReason).toBeNull();

    const paused = await trading.setStatus(companyId, strategy.id, "paused");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("manual");

    const ledgerEntries = await trading.listLedgerEntries(companyId, strategy.id);
    expect(ledgerEntries.map((e) => e.eventType)).toEqual(["kill_switch", "kill_switch"]);
    expect(ledgerEntries.map((e) => e.detail)).toEqual([
      { action: "pause", fromStatus: "running" },
      { action: "resume", fromStatus: "paused" },
    ]);
  });

  it("dashboard's buy-and-hold benchmark tracks the asset's price move, not just starting cash", async () => {
    const companyId = await seedCompany();
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");

    // Strategy is created while BTC is worth 20 USD; asserts against a
    // trading service pinned to a later "now" where BTC has doubled to 40 USD.
    const creationTrading = tradingService(db, {
      now: () => createdAt,
      marketData: fakeTradingMarketData({ quotes: { BTC: { bidUsd: 20, askUsd: 20, at: createdAt } } }),
    });
    const strategy = await creationTrading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    expect(strategy.startingQuoteNok).toBeCloseTo(usdToNok(20), 6);

    const laterTrading = tradingService(db, {
      now: () => later,
      marketData: fakeTradingMarketData({ quotes: { BTC: { bidUsd: 40, askUsd: 40, at: later } } }),
    });
    const summary = await laterTrading.dashboard(companyId, strategy.id);
    // Never traded, so cash is untouched -- buy-and-hold must show the doubled
    // value (2_000 -> 4_000), not just echo startingCashNok back unchanged.
    expect(summary.buyAndHoldValueNok).toBeCloseTo(STRATEGY_INPUT.startingCashNok * 2, 6);
  });

  it("dashboard's buy-and-hold benchmark is null when the creation-time quote fetch failed", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-01-01T00:00:00Z");
    // No BTC fixture at all -- fetchQuote returns a "no_data" error at creation, same as a real upstream outage.
    const trading = tradingService(db, { now: () => now, marketData: fakeTradingMarketData({}) });
    const strategy = await trading.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    expect(strategy.startingQuoteNok).toBeNull();

    const summary = await trading.dashboard(companyId, strategy.id);
    expect(summary.buyAndHoldValueNok).toBeNull();
  });
});
