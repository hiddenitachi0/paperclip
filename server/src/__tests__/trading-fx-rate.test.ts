import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, companies, fxRates, tradingFifoLots, tradingLedgerEntries, tradingOrders, tradingStrategies, type Db } from "@paperclipai/db";
import {
  TRADING_FX_SOURCE_ESTIMATED,
  TRADING_FX_SOURCE_FIXED_ESTIMATE,
  tradingTimeframeMs,
  type CreateTradingStrategyInput,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingRuleConfig,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fxRatesService, parseNorgesBankObservations, type FxRateFetcher } from "../services/fx-rates.ts";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";

/**
 * DUR-5001: a real USD/NOK rate on every fill, and strategies scored in USD so
 * the NOK rate creates no fake profit or loss. Market data is the fake from
 * trading-market-data.ts and the rate fetcher is a stub: no network anywhere.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading fx-rate tests: ${support.reason ?? "unsupported environment"}`);
}

const RULE: TradingRuleConfig = { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 };

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

const STRATEGY_INPUT: CreateTradingStrategyInput = {
  name: "FX strategy",
  asset: "BTC",
  timeframe: "15m",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: RULE,
  riskConfig: RISK,
};

function barsEndingAt(closes: number[], lastOpen: Date): TradingCandle[] {
  const step = tradingTimeframeMs("15m");
  return closes.map((close, i) => ({ openTime: new Date(lastOpen.getTime() - (closes.length - 1 - i) * step), open: close, high: close, low: close, close, volume: 1 }));
}

/** closes=[20,20,20,21] -> buy; [20,20,20,19] -> sell; flat -> hold. */
const BUY_CLOSES = [20, 20, 20, 21];
const SELL_CLOSES = [20, 20, 20, 19];
const FLAT_CLOSES = [21, 21, 21, 21];

d("trading USD/NOK rate (DUR-5001)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-fx-rate");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(async () => {
    await db.delete(fxRates);
    await db.delete(tradingStrategies); // ticks and the boot switch work across every company, so start each test with none
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "FX Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedRates(rates: Array<[string, number]>) {
    await db.insert(fxRates).values(rates.map(([rateDate, rate]) => ({ rateDate, rate, source: "norges_bank" })));
  }

  /** Make a freshly created strategy look like one that existed before the switch: drop its creation note. */
  async function asPreSwitch(strategyId: string) {
    await db.delete(tradingLedgerEntries).where(and(eq(tradingLedgerEntries.strategyId, strategyId), sql`${tradingLedgerEntries.detail}->>'reason' = 'valuation_switch'`));
  }

  function trading(now: Date, closes: number[], quoteUsd: number, fxFetcher?: FxRateFetcher) {
    // Last bar opens 15 minutes before `now`, so it has just closed.
    const candles = barsEndingAt(closes, new Date(now.getTime() - tradingTimeframeMs("15m")));
    return tradingService(db, {
      now: () => now,
      fxRates: fxRatesService(db, fxFetcher),
      marketData: fakeTradingMarketData({ candles: { BTC: { candles } }, quotes: { BTC: { bidUsd: quoteUsd, askUsd: quoteUsd, at: now } } }),
    });
  }

  async function runningStrategy(svc: ReturnType<typeof tradingService>, companyId: string) {
    const strategy = await svc.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await svc.setStatus(companyId, strategy.id, "running");
    return strategy;
  }

  it("a weekend fill uses the last published rate and stores that rate's date", async () => {
    const companyId = await seedCompany();
    // Friday 23 Oct 2026 is the last business day; Saturday 24 Oct has no rate of its own.
    await seedRates([
      ["2026-10-22", 9.3444],
      ["2026-10-23", 9.317],
    ]);
    const saturday = new Date("2026-10-24T10:00:00Z");
    const svc = trading(saturday, BUY_CLOSES, 21);
    const strategy = await runningStrategy(svc, companyId);

    expect(await svc.tick(saturday)).toMatchObject({ filled: 1 });

    const [order] = await db.select().from(tradingOrders).where(eq(tradingOrders.strategyId, strategy.id));
    expect(order).toMatchObject({ status: "filled", fxRate: 9.317, fxDate: "2026-10-23", fxSource: "norges_bank" });
    expect(order!.filledPriceNok).toBeCloseTo(21 * 9.317, 6);
    const [lot] = await db.select().from(tradingFifoLots).where(eq(tradingFifoLots.strategyId, strategy.id));
    expect(lot).toMatchObject({ fxRate: 9.317, fxDate: "2026-10-23", fxSource: "norges_bank" });
  });

  it("with no rate stored and no way to fetch one, a fill uses 11.5 flagged 'estimated'", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-10-26T10:00:00Z");
    const svc = trading(now, BUY_CLOSES, 21);
    const strategy = await runningStrategy(svc, companyId);

    expect(await svc.tick(now)).toMatchObject({ filled: 1 });

    const [order] = await db.select().from(tradingOrders).where(eq(tradingOrders.strategyId, strategy.id));
    expect(order).toMatchObject({ fxRate: 11.5, fxDate: null, fxSource: TRADING_FX_SOURCE_ESTIMATED });
    const [lot] = await db.select().from(tradingFifoLots).where(eq(tradingFifoLots.strategyId, strategy.id));
    expect(lot).toMatchObject({ fxRate: 11.5, fxDate: null, fxSource: TRADING_FX_SOURCE_ESTIMATED });
  });

  it("a failing fetcher leaves the last stored rate in place and never throws into the tick", async () => {
    await seedRates([["2026-10-23", 9.317]]);
    const failing: FxRateFetcher = {
      async fetchRecent() {
        throw new Error("Norges Bank is down");
      },
    };
    const service = fxRatesService(db, failing);
    expect(await service.current(new Date("2026-10-26T10:00:00Z"))).toEqual({ rate: 9.317, date: "2026-10-23", source: "norges_bank" });
  });

  it("fetches and stores the published rates once, and does not duplicate them", async () => {
    let calls = 0;
    const fetcher: FxRateFetcher = {
      async fetchRecent() {
        calls++;
        return [
          { date: "2026-10-22", rate: 9.3444 },
          { date: "2026-10-23", rate: 9.317 },
        ];
      },
    };
    const service = fxRatesService(db, fetcher);
    expect(await service.refresh()).toBe(2);
    expect(await service.refresh()).toBe(0);
    // Saturday: newest published is Friday's, with Friday's date.
    expect(await service.current(new Date("2026-10-24T12:00:00Z"))).toEqual({ rate: 9.317, date: "2026-10-23", source: "norges_bank" });
    expect(calls).toBe(2);
    const rows = await db.select().from(fxRates);
    expect(rows).toHaveLength(2);
  });

  it("parses Norges Bank's answer and drops values that are not a plausible rate", () => {
    const body = {
      data: {
        dataSets: [{ series: { "0:0:0:0": { observations: { "0": ["9.3509"], "1": ["0"], "2": ["9.317"], "3": ["not a number"] } } } }],
        structure: { dimensions: { observation: [{ id: "TIME_PERIOD", values: [{ id: "2026-10-23" }, { id: "2026-10-24" }, { id: "2026-10-26" }, { id: "2026-10-27" }] }] } },
      },
    };
    expect(parseNorgesBankObservations(body)).toEqual([
      { date: "2026-10-23", rate: 9.3509 },
      { date: "2026-10-26", rate: 9.317 },
    ]);
    expect(() => parseNorgesBankObservations({})).toThrow();
  });

  it("a rate move creates no fake profit or loss: buy and sell at the same USD price on different rates", async () => {
    const companyId = await seedCompany();
    await seedRates([
      ["2026-10-26", 10],
      ["2026-10-27", 9],
    ]);
    const monday = new Date("2026-10-26T10:00:00Z");
    const tuesday = new Date("2026-10-27T10:00:00Z");
    const buySvc = trading(monday, BUY_CLOSES, 21);
    const strategy = await runningStrategy(buySvc, companyId);
    expect(await buySvc.tick(monday)).toMatchObject({ filled: 1 });

    // The sell signal fires at the same 21 USD the buy filled at; only the NOK rate has fallen.
    // A sell needs a sell signal: closes that cross down while the quote stays at 21.
    const sellCandles = barsEndingAt([22, 22, 22, 21], new Date(tuesday.getTime() - tradingTimeframeMs("15m")));
    const sellSvc = tradingService(db, {
      now: () => tuesday,
      fxRates: fxRatesService(db),
      marketData: fakeTradingMarketData({ candles: { BTC: { candles: sellCandles } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: tuesday } } }),
    });
    await db.update(tradingStrategies).set({ nextCheckAt: tuesday, lastEvaluatedBarAt: null }).where(eq(tradingStrategies.id, strategy.id));
    expect(await sellSvc.tick(tuesday)).toMatchObject({ filled: 1 });

    const summary = await sellSvc.dashboard(companyId, strategy.id);
    // In USD the round trip costs exactly the two fees (0.25% of 1000 NOK-worth each side, in USD).
    const stake = (0.5 * 2_000) / 10; // 100 USD bought at rate 10
    const feeUsd = stake * 0.0025 * 2;
    expect(summary.totalPnlUsd).toBeCloseTo(-feeUsd, 6);
    expect(summary.cashUsd).toBeCloseTo(2_000 / 10 - feeUsd, 6);
    // In kroner the same trip lost real money: 100 USD went in at 10 and came out at 9 (that is what the tax ledger must show).
    const [sell] = await db.select().from(tradingOrders).where(and(eq(tradingOrders.strategyId, strategy.id), eq(tradingOrders.side, "sell")));
    expect(sell).toMatchObject({ fxRate: 9, fxDate: "2026-10-27", fxSource: "norges_bank" });
    expect(sell!.realizedPnlNok!).toBeLessThan(-90);
    expect(summary.fxRate).toBe(9);
  });

  it("a rate below 11.5 does not trip the drawdown limit on a position held in USD", async () => {
    const companyId = await seedCompany();
    // 9.0 is 21.7% below 11.5: in kroner the position would look like a >20% drawdown.
    await seedRates([["2026-10-26", 9]]);
    const now = new Date("2026-10-26T10:00:00Z");
    const svc = trading(now, FLAT_CLOSES, 21);
    const strategy = await runningStrategy(svc, companyId);
    // A strategy as it stood before the switch: fully invested at the fixed 11.5.
    const usd = 2_000 / 11.5;
    await db
      .update(tradingStrategies)
      .set({ cashNok: 0, cashUsd: 0, positionQuantity: usd / 21, positionCostNok: 2_000, peakEquityNok: 2_000, peakEquityUsd: usd, startingCashUsd: usd })
      .where(eq(tradingStrategies.id, strategy.id));

    expect(await svc.tick(now)).toMatchObject({ checked: 1, halted: 0 });
    const row = await svc.requireStrategy(companyId, strategy.id);
    expect(row.status).toBe("running");
    expect(row.peakEquityUsd).toBeCloseTo(usd, 9);
  });

  it("at the switch, peak equity is reset to current equity and a ledger note is written once", async () => {
    const companyId = await seedCompany();
    await seedRates([["2026-10-29", 9.3]]);
    const now = new Date("2026-10-29T12:00:00Z");
    const svc = trading(now, FLAT_CLOSES, 25);
    const strategy = await svc.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await asPreSwitch(strategy.id);
    // Peak left over from the old NOK valuation (a high-water mark of 3000 NOK = 260.87 USD at 11.5), position 4 coins.
    await db
      .update(tradingStrategies)
      .set({ cashNok: 1_000, cashUsd: 1_000 / 11.5, positionQuantity: 4, positionCostNok: 1_000, peakEquityNok: 3_000, peakEquityUsd: 3_000 / 11.5 })
      .where(eq(tradingStrategies.id, strategy.id));

    expect(await svc.applyValuationSwitch()).toEqual({ switched: 1 });

    const row = await svc.requireStrategy(companyId, strategy.id);
    const equityUsd = 1_000 / 11.5 + 4 * 25;
    expect(row.peakEquityUsd).toBeCloseTo(equityUsd, 9);
    expect(row.peakEquityNok).toBeCloseTo(equityUsd * 9.3, 9);
    const notes = await db
      .select()
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.strategyId, strategy.id), sql`${tradingLedgerEntries.detail}->>'reason' = 'valuation_switch'`));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ eventType: "reconciliation" });
    expect(notes[0]!.detail).toMatchObject({ note: "valuation switched to the daily Norges Bank rate", rate: 9.3, rateDate: "2026-10-29", rateSource: "norges_bank" });

    // Idempotent: a second boot neither moves the peak again nor writes a second note.
    await db.update(tradingStrategies).set({ peakEquityUsd: 1 }).where(eq(tradingStrategies.id, strategy.id));
    expect(await svc.applyValuationSwitch()).toEqual({ switched: 0 });
    expect((await svc.requireStrategy(companyId, strategy.id)).peakEquityUsd).toBe(1);
  });

  it("a strategy created after the switch keeps its drawdown peak across a restart", async () => {
    const companyId = await seedCompany();
    await seedRates([["2026-10-29", 9.3]]);
    const now = new Date("2026-10-29T12:00:00Z");
    const svc = trading(now, FLAT_CLOSES, 25);
    const strategy = await svc.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    const peakUsd = strategy.peakEquityUsd!;
    // 18% down from the peak, as a strategy sitting at its drawdown stop.
    await db
      .update(tradingStrategies)
      .set({ cashUsd: peakUsd * 0.82, status: "paused", pauseReason: "drawdown_limit" })
      .where(eq(tradingStrategies.id, strategy.id));

    expect(await svc.applyValuationSwitch()).toEqual({ switched: 0 });

    const row = await svc.requireStrategy(companyId, strategy.id);
    expect(row.peakEquityUsd).toBe(peakUsd);
    expect(row.status).toBe("paused");
    const notes = await db
      .select()
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.strategyId, strategy.id), sql`${tradingLedgerEntries.detail}->>'reason' = 'valuation_switch'`));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.detail).toMatchObject({ created: true });
  });

  it("values the position at cost for the peak reset when the live quote is unavailable", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-10-29T12:00:00Z");
    const svc = tradingService(db, { now: () => now, fxRates: fxRatesService(db), marketData: fakeTradingMarketData({ quotes: { BTC: { bidUsd: 20, askUsd: 20, at: now } } }) });
    const strategy = await svc.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await asPreSwitch(strategy.id);
    const [order] = await db
      .insert(tradingOrders)
      .values({ companyId, strategyId: strategy.id, side: "buy", status: "filled", ruleVersion: "x", signalPriceNok: 230, requestedQuantity: 2, filledQuantity: 2, filledPriceNok: 230, fxRate: 11.5, fxSource: TRADING_FX_SOURCE_FIXED_ESTIMATE })
      .returning();
    await db.insert(tradingFifoLots).values({ companyId, strategyId: strategy.id, sourceOrderId: order!.id, quantityRemaining: 2, costNokPerUnit: 230, acquiredAt: now, fxRate: 11.5, fxSource: TRADING_FX_SOURCE_FIXED_ESTIMATE });
    await db.update(tradingStrategies).set({ cashUsd: 100, positionQuantity: 2, peakEquityUsd: 9_999 }).where(eq(tradingStrategies.id, strategy.id));

    const noQuote = tradingService(db, { now: () => now, fxRates: fxRatesService(db), marketData: fakeTradingMarketData({}) });
    await noQuote.applyValuationSwitch();
    // 2 coins bought at 230 NOK / 11.5 = 20 USD each = 40 USD of cost, plus 100 USD cash.
    expect((await noQuote.requireStrategy(companyId, strategy.id)).peakEquityUsd).toBeCloseTo(140, 9);
  });

  it("buy-and-hold in USD is the same before and after the switch, whatever the NOK rate does", async () => {
    const companyId = await seedCompany();
    const created = new Date("2026-10-26T00:00:00Z");
    const later = new Date("2026-10-29T12:00:00Z");
    // A strategy exactly as the old code stored it: starting quote 20 USD at the fixed 11.5, and no USD columns.
    const svc0 = trading(created, FLAT_CLOSES, 20);
    const strategy = await svc0.createStrategy(companyId, STRATEGY_INPUT, { actorType: "user", actorId: "u1" });
    await db
      .update(tradingStrategies)
      .set({ startingQuoteNok: 230, startingQuoteUsd: null, startingCashUsd: null, cashUsd: null, peakEquityUsd: null })
      .where(eq(tradingStrategies.id, strategy.id));

    // Before the switch (no stored rate: 11.5) and after it (a rate of 9.3): same USD figure, same NOK figure as the old formula.
    const before = await trading(later, FLAT_CLOSES, 40).dashboard(companyId, strategy.id);
    await seedRates([["2026-10-29", 9.3]]);
    const after = await trading(later, FLAT_CLOSES, 40).dashboard(companyId, strategy.id);

    const startingCashUsd = 2_000 / 11.5;
    for (const summary of [before, after]) {
      expect(summary.buyAndHoldValueUsd).toBeCloseTo(startingCashUsd * 2, 9);
      expect(summary.buyAndHoldValueNok).toBeCloseTo((2_000 / 230) * (40 * 11.5), 9); // the old fixed-rate formula
    }
    expect(before.fxSource).toBe(TRADING_FX_SOURCE_ESTIMATED);
    expect(after).toMatchObject({ fxRate: 9.3, fxDate: "2026-10-29", fxSource: "norges_bank" });
    // And strategy P&L in USD does not move with the rate either (never traded: zero).
    expect(before.totalPnlUsd).toBeCloseTo(0, 9);
    expect(after.totalPnlUsd).toBeCloseTo(0, 9);
  });
});
