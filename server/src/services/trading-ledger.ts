import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingDailyStats, tradingFifoLots, tradingLedgerEntries } from "@paperclipai/db";
import type { TradingLedgerEventType } from "@paperclipai/shared";

/**
 * The FIFO tax ledger and the append-only decision ledger (design report
 * section 5.7): "every signal, decision, order, fill, fee, NOK rate and
 * FIFO cost, append-only" -- the functions here are the only writers of
 * trading_fifo_lots and trading_ledger_entries, and neither ever runs an
 * UPDATE that changes history, only inserts (trading_fifo_lots rows are
 * mutated in one field, quantity_remaining, as lots are consumed -- that is
 * bookkeeping of an open position, not a rewrite of what happened).
 */

export interface TradingFifoConsumeResult {
  /** True cost basis of the quantity actually consumed (may be less than requested if the strategy's own cached position_quantity had drifted -- callers should treat a short-fall as a reconciliation signal). */
  costNokConsumed: number;
  quantityConsumed: number;
}

export function tradingLedgerService(db: Db) {
  async function addFifoLot(params: {
    companyId: string;
    strategyId: string;
    sourceOrderId: string;
    quantity: number;
    costNokPerUnit: number;
    acquiredAt: Date;
  }): Promise<void> {
    await db.insert(tradingFifoLots).values({
      companyId: params.companyId,
      strategyId: params.strategyId,
      sourceOrderId: params.sourceOrderId,
      quantityRemaining: params.quantity,
      costNokPerUnit: params.costNokPerUnit,
      acquiredAt: params.acquiredAt,
    });
  }

  /** Consumes open lots oldest-first up to `quantity`. Pure database bookkeeping -- callers compute realized P&L from the returned cost basis. */
  async function consumeFifoLots(params: { strategyId: string; quantity: number }): Promise<TradingFifoConsumeResult> {
    let remainingToConsume = params.quantity;
    let costNokConsumed = 0;
    let quantityConsumed = 0;

    const lots = await db
      .select()
      .from(tradingFifoLots)
      .where(and(eq(tradingFifoLots.strategyId, params.strategyId), gt(tradingFifoLots.quantityRemaining, 0)))
      .orderBy(asc(tradingFifoLots.acquiredAt));

    for (const lot of lots) {
      if (remainingToConsume <= 1e-12) break;
      const takeFromLot = Math.min(lot.quantityRemaining, remainingToConsume);
      await db
        .update(tradingFifoLots)
        .set({ quantityRemaining: sql`${tradingFifoLots.quantityRemaining} - ${takeFromLot}` })
        .where(eq(tradingFifoLots.id, lot.id));
      costNokConsumed += takeFromLot * lot.costNokPerUnit;
      quantityConsumed += takeFromLot;
      remainingToConsume -= takeFromLot;
    }

    return { costNokConsumed, quantityConsumed };
  }

  async function writeLedgerEntry(params: {
    companyId: string;
    strategyId: string;
    orderId?: string | null;
    eventType: TradingLedgerEventType;
    nokValue?: number | null;
    feeNok?: number | null;
    fifoCostNok?: number | null;
    realizedPnlNok?: number | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await db.insert(tradingLedgerEntries).values({
      companyId: params.companyId,
      strategyId: params.strategyId,
      orderId: params.orderId ?? null,
      eventType: params.eventType,
      nokValue: params.nokValue ?? null,
      feeNok: params.feeNok ?? null,
      fifoCostNok: params.fifoCostNok ?? null,
      realizedPnlNok: params.realizedPnlNok ?? null,
      detail: params.detail ?? null,
    });
  }

  async function listLedgerEntries(params: { companyId: string; strategyId: string; limit: number }) {
    return db
      .select()
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.companyId, params.companyId), eq(tradingLedgerEntries.strategyId, params.strategyId)))
      .orderBy(sql`${tradingLedgerEntries.createdAt} DESC`)
      .limit(params.limit);
  }

  /** UTC calendar date key, "YYYY-MM-DD" -- matches watchers.ts's utcDay() convention. */
  function statDateOf(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async function recordDailyStat(params: {
    companyId: string;
    strategyId: string;
    at: Date;
    realizedPnlDeltaNok?: number;
    feesDeltaNok?: number;
    ordersDelta?: number;
    equityNok?: number | null;
  }): Promise<void> {
    const statDate = statDateOf(params.at);
    await db
      .insert(tradingDailyStats)
      .values({
        companyId: params.companyId,
        strategyId: params.strategyId,
        statDate,
        realizedPnlNok: params.realizedPnlDeltaNok ?? 0,
        feesNok: params.feesDeltaNok ?? 0,
        ordersCount: params.ordersDelta ?? 0,
        equityNok: params.equityNok ?? null,
      })
      .onConflictDoUpdate({
        target: [tradingDailyStats.strategyId, tradingDailyStats.statDate],
        set: {
          realizedPnlNok: sql`${tradingDailyStats.realizedPnlNok} + ${params.realizedPnlDeltaNok ?? 0}`,
          feesNok: sql`${tradingDailyStats.feesNok} + ${params.feesDeltaNok ?? 0}`,
          ordersCount: sql`${tradingDailyStats.ordersCount} + ${params.ordersDelta ?? 0}`,
          equityNok: params.equityNok ?? undefined,
          updatedAt: new Date(),
        },
      });
  }

  async function listDailyStats(params: { companyId: string; strategyId: string; limit: number }) {
    return db
      .select()
      .from(tradingDailyStats)
      .where(and(eq(tradingDailyStats.companyId, params.companyId), eq(tradingDailyStats.strategyId, params.strategyId)))
      .orderBy(sql`${tradingDailyStats.statDate} DESC`)
      .limit(params.limit);
  }

  return { addFifoLot, consumeFifoLots, writeLedgerEntry, listLedgerEntries, recordDailyStat, listDailyStats, statDateOf };
}
