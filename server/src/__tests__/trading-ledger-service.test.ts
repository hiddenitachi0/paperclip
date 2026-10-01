import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, tradingOrders, tradingStrategies } from "@paperclipai/db";
import { DEFAULT_TRADING_RISK_CONFIG, DEFAULT_TRADING_RULE_CONFIG } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingLedgerService } from "../services/trading-ledger.ts";

/**
 * DUR-4171: trading-ledger.ts is the only writer of trading_fifo_lots and
 * trading_ledger_entries (see its own module doc comment) -- these tests
 * cover the two pieces of real logic in it that trading.ts's own tests don't
 * exercise directly: FIFO lot consumption ordering/partial consumption, and
 * recordDailyStat's insert-then-increment upsert.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading ledger service tests: ${support.reason ?? "unsupported environment"}`);
}

d("tradingLedgerService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-ledger-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  /** A company + a strategy row + a "source order" row, the minimum a FIFO lot's FKs need. */
  async function seedStrategyWithOrder() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ledger Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [strategy] = await db
      .insert(tradingStrategies)
      .values({
        companyId,
        name: "Strategy",
        asset: "BTC",
        startingCashNok: 2_000,
        cashNok: 2_000,
        peakEquityNok: 2_000,
        ruleConfig: DEFAULT_TRADING_RULE_CONFIG,
        riskConfig: DEFAULT_TRADING_RISK_CONFIG,
      })
      .returning();
    const [order] = await db
      .insert(tradingOrders)
      .values({
        companyId,
        strategyId: strategy!.id,
        side: "buy",
        status: "filled",
        ruleVersion: "sma_crossover@1",
        signalPriceNok: 100,
        requestedQuantity: 30,
      })
      .returning();
    return { companyId, strategyId: strategy!.id, orderId: order!.id };
  }

  it("consumes lots oldest-first and only partially drains the lot that satisfies the remainder", async () => {
    const { companyId, strategyId, orderId } = await seedStrategyWithOrder();
    const ledger = tradingLedgerService(db);

    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 10, costNokPerUnit: 100, acquiredAt: new Date("2026-01-01T00:00:00Z") });
    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 10, costNokPerUnit: 200, acquiredAt: new Date("2026-01-02T00:00:00Z") });
    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 10, costNokPerUnit: 300, acquiredAt: new Date("2026-01-03T00:00:00Z") });

    // Consume 15: all of the oldest lot (10 @ 100) plus half of the second (5 @ 200) -- the third, newest lot must stay untouched.
    const result = await ledger.consumeFifoLots({ strategyId, quantity: 15 });

    expect(result.quantityConsumed).toBe(15);
    expect(result.costNokConsumed).toBe(10 * 100 + 5 * 200);

    const ledgerEntries = await ledger.listLedgerEntries({ companyId, strategyId, limit: 10 });
    expect(ledgerEntries).toHaveLength(0); // consumeFifoLots itself never writes a ledger entry -- that's the caller's job (fillSell).
  });

  it("stops early once the requested quantity is fully consumed, leaving later lots untouched", async () => {
    const { companyId, strategyId, orderId } = await seedStrategyWithOrder();
    const ledger = tradingLedgerService(db);

    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 5, costNokPerUnit: 50, acquiredAt: new Date("2026-01-01T00:00:00Z") });
    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 5, costNokPerUnit: 999, acquiredAt: new Date("2026-01-02T00:00:00Z") });

    const result = await ledger.consumeFifoLots({ strategyId, quantity: 5 });

    expect(result.quantityConsumed).toBe(5);
    expect(result.costNokConsumed).toBe(5 * 50); // must not touch the second (much more expensive) lot.

    // Consuming again drains the untouched second lot, proving it was never partially taken by the first call.
    const second = await ledger.consumeFifoLots({ strategyId, quantity: 5 });
    expect(second.quantityConsumed).toBe(5);
    expect(second.costNokConsumed).toBe(5 * 999);
  });

  it("returns a short-fall (not an error) when asked to consume more than is open", async () => {
    const { companyId, strategyId, orderId } = await seedStrategyWithOrder();
    const ledger = tradingLedgerService(db);
    await ledger.addFifoLot({ companyId, strategyId, sourceOrderId: orderId, quantity: 3, costNokPerUnit: 100, acquiredAt: new Date("2026-01-01T00:00:00Z") });

    const result = await ledger.consumeFifoLots({ strategyId, quantity: 100 });

    expect(result.quantityConsumed).toBe(3);
    expect(result.costNokConsumed).toBe(300);
  });

  it("recordDailyStat inserts once then increments the same day's row on every later call", async () => {
    const { companyId, strategyId } = await seedStrategyWithOrder();
    const ledger = tradingLedgerService(db);
    const day1 = new Date("2026-02-01T10:00:00Z");

    await ledger.recordDailyStat({ companyId, strategyId, at: day1, realizedPnlDeltaNok: 100, feesDeltaNok: 2, ordersDelta: 1 });
    await ledger.recordDailyStat({ companyId, strategyId, at: day1, realizedPnlDeltaNok: -30, feesDeltaNok: 1, ordersDelta: 1 });

    const stats = await ledger.listDailyStats({ companyId, strategyId, limit: 10 });
    expect(stats).toHaveLength(1);
    expect(stats[0]!.statDate).toBe("2026-02-01");
    expect(stats[0]!.realizedPnlNok).toBe(70);
    expect(stats[0]!.feesNok).toBe(3);
    expect(stats[0]!.ordersCount).toBe(2);
  });

  it("recordDailyStat opens a separate row for a different UTC day", async () => {
    const { companyId, strategyId } = await seedStrategyWithOrder();
    const ledger = tradingLedgerService(db);

    await ledger.recordDailyStat({ companyId, strategyId, at: new Date("2026-02-01T23:59:00Z"), ordersDelta: 1 });
    await ledger.recordDailyStat({ companyId, strategyId, at: new Date("2026-02-02T00:01:00Z"), ordersDelta: 1 });

    const stats = await ledger.listDailyStats({ companyId, strategyId, limit: 10 });
    expect(stats.map((s) => s.statDate).sort()).toEqual(["2026-02-01", "2026-02-02"]);
    expect(stats.every((s) => s.ordersCount === 1)).toBe(true);
  });
});
