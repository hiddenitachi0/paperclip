import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingDailyStats, tradingFifoLots, tradingLedgerEntries } from "@paperclipai/db";
import { TRADING_ESTIMATED_USD_NOK_RATE, type TradingLedgerEventType } from "@paperclipai/shared";

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
  /** The same cost basis in USD: each lot's NOK cost divided by the rate that lot was converted at (11.5 for a lot with no rate stamped). */
  costUsdConsumed: number;
  quantityConsumed: number;
}

/** The rate a fill's NOK figures were converted at, stamped on the order and the lot. */
export interface TradingFxStamp {
  fxRate: number;
  fxDate: string | null;
  fxSource: string;
}

export function tradingLedgerService(db: Db) {
  async function addFifoLot(params: {
    companyId: string;
    strategyId: string;
    sourceOrderId: string;
    quantity: number;
    costNokPerUnit: number;
    acquiredAt: Date;
    fx: TradingFxStamp;
  }): Promise<void> {
    await db.insert(tradingFifoLots).values({
      companyId: params.companyId,
      strategyId: params.strategyId,
      sourceOrderId: params.sourceOrderId,
      quantityRemaining: params.quantity,
      costNokPerUnit: params.costNokPerUnit,
      acquiredAt: params.acquiredAt,
      fxRate: params.fx.fxRate,
      fxDate: params.fx.fxDate,
      fxSource: params.fx.fxSource,
    });
  }

  /** Consumes open lots oldest-first up to `quantity`. Pure database bookkeeping -- callers compute realized P&L from the returned cost basis. */
  async function consumeFifoLots(params: { strategyId: string; quantity: number }): Promise<TradingFifoConsumeResult> {
    let remainingToConsume = params.quantity;
    let costNokConsumed = 0;
    let costUsdConsumed = 0;
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
      costUsdConsumed += (takeFromLot * lot.costNokPerUnit) / (lot.fxRate ?? TRADING_ESTIMATED_USD_NOK_RATE);
      quantityConsumed += takeFromLot;
      remainingToConsume -= takeFromLot;
    }

    return { costNokConsumed, costUsdConsumed, quantityConsumed };
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

  /** The engine version of the newest "engine_version" note for this strategy, or null if it has none (DUR-4999). */
  async function latestEngineVersionNote(params: { companyId: string; strategyId: string }): Promise<number | null> {
    const [row] = await db
      .select({ detail: tradingLedgerEntries.detail })
      .from(tradingLedgerEntries)
      .where(
        and(
          eq(tradingLedgerEntries.companyId, params.companyId),
          eq(tradingLedgerEntries.strategyId, params.strategyId),
          eq(tradingLedgerEntries.eventType, "reconciliation"),
          sql`${tradingLedgerEntries.detail}->>'reason' = 'engine_version'`,
        ),
      )
      .orderBy(sql`${tradingLedgerEntries.createdAt} DESC`)
      .limit(1);
    const version = (row?.detail as { engineVersion?: unknown } | null | undefined)?.engineVersion;
    return typeof version === "number" ? version : null;
  }

  /** USD cost basis of everything still open in this strategy's FIFO lots (each lot at the rate it was converted at). */
  async function openPositionCostUsd(strategyId: string): Promise<number> {
    const [row] = await db
      .select({
        cost: sql<number>`COALESCE(SUM(${tradingFifoLots.quantityRemaining} * ${tradingFifoLots.costNokPerUnit} / COALESCE(${tradingFifoLots.fxRate}, ${TRADING_ESTIMATED_USD_NOK_RATE})), 0)::float8`,
      })
      .from(tradingFifoLots)
      .where(and(eq(tradingFifoLots.strategyId, strategyId), gt(tradingFifoLots.quantityRemaining, 0)));
    return Number(row?.cost ?? 0);
  }

  /** True once the one-time "valuation switched to the daily Norges Bank rate" note (DUR-5001) exists for this strategy. */
  async function hasValuationSwitchNote(params: { companyId: string; strategyId: string }): Promise<boolean> {
    const [row] = await db
      .select({ id: tradingLedgerEntries.id })
      .from(tradingLedgerEntries)
      .where(
        and(
          eq(tradingLedgerEntries.companyId, params.companyId),
          eq(tradingLedgerEntries.strategyId, params.strategyId),
          eq(tradingLedgerEntries.eventType, "reconciliation"),
          sql`${tradingLedgerEntries.detail}->>'reason' = 'valuation_switch'`,
        ),
      )
      .limit(1);
    return Boolean(row);
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

  return { addFifoLot, consumeFifoLots, writeLedgerEntry, listLedgerEntries, latestEngineVersionNote, hasValuationSwitchNote, openPositionCostUsd, recordDailyStat, listDailyStats, statDateOf };
}
