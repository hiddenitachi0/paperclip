import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, tradingOrders, tradingStrategies } from "@paperclipai/db";
import {
  TRADING_CIRCUIT_BREAKER_MAX_CONSECUTIVE_ERRORS,
  TRADING_CIRCUIT_BREAKER_PRICE_JUMP_PCT,
  TRADING_ENGINE_VERSION,
  TRADING_MAX_CATCH_UP_BARS,
  TRADING_TICK_BATCH,
  TRADING_TRADE_APPROVAL_EXPIRY_MS,
  ccxtSymbolFor,
  evaluateTradingRule,
  tradingRuleVersionLabel,
  tradingSignalStillHolds,
  tradingWarmUpBars,
  usdToNok,
  type CreateTradingStrategyInput,
  type TradingDashboardSummary,
  type TradingAsset,
  type TradingTimeframe,
  type TradingPauseReason,
  type TradingRiskConfig,
  type TradingRuleConfig,
  type TradingStrategyStatus,
  type UpdateTradingStrategyInput,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { approvalService } from "./approvals.js";
import { ccxtTradingMarketData, isTradingMarketDataError, prepareClosedCandles, type TradingMarketDataSource } from "./trading-market-data.js";
import { evaluateTradingRiskGate, singleTickPriceJumpPct, tradingFeeNok } from "./trading-risk-gate.js";
import { tradingLedgerService } from "./trading-ledger.js";

/**
 * The trading agent (DUR-4153/DUR-4171): CRUD for strategies, the tick loop
 * that runs the deterministic rule engine and risk gate, and the kill
 * switch. See packages/db/src/schema/trading.ts and
 * packages/shared/src/trading.ts for the full design rationale; this file
 * is the "code trades" half -- no LLM call anywhere in it.
 *
 * Phase-1 order sizing (simple on purpose -- this is "one simple rule" per
 * the design report, not a portfolio manager): a buy signal invests
 * `orderSizeFraction` of the strategy's current paper cash; a sell signal
 * liquidates the entire open position. A strategy holds at most one asset.
 */

export type TradingStrategyRow = typeof tradingStrategies.$inferSelect;

export interface TradingServiceDeps {
  now?: () => Date;
  marketData?: TradingMarketDataSource;
}

export interface TradingTickResult {
  checked: number;
  filled: number;
  blocked: number;
  approvalRequested: number;
  approvalsResolved: number;
  halted: number;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Enough closed bars for the slowest indicator to warm up AND for a full catch-up to evaluate each missed bar with its own history, plus the forming bar the exchange appends (which is dropped). */
function candleLimit(config: TradingRuleConfig): number {
  return tradingWarmUpBars(config) + TRADING_MAX_CATCH_UP_BARS + 1;
}

export function tradingService(db: Db, deps: TradingServiceDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const marketData = deps.marketData ?? ccxtTradingMarketData();
  const ledger = tradingLedgerService(db);
  const approvalsSvc = approvalService(db);

  // ─── CRUD ──────────────────────────────────────────────────────────────

  async function requireStrategy(companyId: string, strategyId: string): Promise<TradingStrategyRow> {
    const [row] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!row) throw notFound("Trading strategy not found.");
    return row;
  }

  async function listStrategies(companyId: string): Promise<TradingStrategyRow[]> {
    return db.select().from(tradingStrategies).where(eq(tradingStrategies.companyId, companyId)).orderBy(asc(tradingStrategies.createdAt));
  }

  async function createStrategy(companyId: string, input: CreateTradingStrategyInput, actor: { actorType: "user" | "agent"; actorId: string }): Promise<TradingStrategyRow> {
    const now = nowOf();
    // One symbol map, checked against the exchange's market list: a strategy
    // for a market that is not there could only ever fail its price check.
    // "unknown" (market list unreachable) fails closed too.
    const availability = await marketData.marketAvailability(input.asset);
    if (availability === "missing") {
      throw unprocessable(`${input.asset} cannot be traded: the market ${ccxtSymbolFor(input.asset)} is not on the exchange. Pick another coin.`);
    }
    if (availability === "unknown") {
      throw unprocessable("Could not check the exchange's market list just now, so the strategy was not created. Try again in a moment.");
    }
    // Best-effort: record the asset's price at creation so the dashboard can
    // later compute a real buy-and-hold benchmark. A failed fetch here must
    // not block creating the strategy -- startingQuoteNok just stays null and
    // the benchmark degrades to null (same convention as dashboard()'s own
    // quoteNok-unavailable case) until the next successful quote.
    const quote = await marketData.fetchQuote(input.asset, now);
    const startingQuoteNok = isTradingMarketDataError(quote) ? null : usdToNok(quote.bidUsd);
    const [row] = await db
      .insert(tradingStrategies)
      .values({
        companyId,
        name: input.name,
        asset: input.asset,
        mode: "paper",
        status: "paused",
        timeframe: input.timeframe,
        checkEveryMinutes: input.checkEveryMinutes,
        nextCheckAt: now,
        ruleConfig: input.ruleConfig,
        riskConfig: input.riskConfig,
        startingCashNok: input.startingCashNok,
        startingQuoteNok,
        cashNok: input.startingCashNok,
        peakEquityNok: input.startingCashNok,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      })
      .returning();
    return row!;
  }

  async function updateStrategy(companyId: string, strategyId: string, input: UpdateTradingStrategyInput): Promise<TradingStrategyRow> {
    await requireStrategy(companyId, strategyId);
    const [row] = await db
      .update(tradingStrategies)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.checkEveryMinutes !== undefined ? { checkEveryMinutes: input.checkEveryMinutes } : {}),
        ...(input.ruleConfig !== undefined ? { ruleConfig: input.ruleConfig } : {}),
        ...(input.riskConfig !== undefined ? { riskConfig: input.riskConfig } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)))
      .returning();
    return row!;
  }

  /** The kill switch, both directions -- UI and Telegram call this same function (see routes/trading.ts). */
  async function setStatus(companyId: string, strategyId: string, target: "running" | "paused"): Promise<TradingStrategyRow> {
    const existing = await requireStrategy(companyId, strategyId);
    const now = nowOf();
    if (target === "running") {
      const [row] = await db
        .update(tradingStrategies)
        .set({ status: "running", pauseReason: null, nextCheckAt: now, checkLeaseUntil: null, consecutiveErrors: 0, updatedAt: now })
        .where(eq(tradingStrategies.id, strategyId))
        .returning();
      await ledger.writeLedgerEntry({ companyId, strategyId, eventType: "kill_switch", detail: { action: "resume", fromStatus: existing.status } });
      return row!;
    }
    const [row] = await db
      .update(tradingStrategies)
      .set({ status: "paused", pauseReason: "manual" satisfies TradingPauseReason, checkLeaseUntil: null, updatedAt: now })
      .where(eq(tradingStrategies.id, strategyId))
      .returning();
    await ledger.writeLedgerEntry({ companyId, strategyId, eventType: "kill_switch", detail: { action: "pause", fromStatus: existing.status } });
    return row!;
  }

  /** "Starts paused after restart" -- call once at server boot, before the tick timer is armed. */
  async function reconcileOnBoot(): Promise<{ pausedCount: number }> {
    const running = await db.select({ id: tradingStrategies.id, companyId: tradingStrategies.companyId }).from(tradingStrategies).where(eq(tradingStrategies.status, "running"));
    for (const row of running) {
      await db
        .update(tradingStrategies)
        .set({ status: "paused", pauseReason: "restart" satisfies TradingPauseReason, checkLeaseUntil: null })
        .where(eq(tradingStrategies.id, row.id));
      await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, eventType: "reconciliation", detail: { reason: "server_restart" } });
    }
    return { pausedCount: running.length };
  }

  /**
   * One ledger note per strategy when the engine version changes (DUR-4999),
   * so a strategy's history shows where its behaviour changed even though its
   * stored rule_config version never does. Call once at boot.
   */
  async function noteEngineVersion(): Promise<{ noted: number }> {
    const rows = await db.select({ id: tradingStrategies.id, companyId: tradingStrategies.companyId }).from(tradingStrategies);
    let noted = 0;
    for (const row of rows) {
      const previous = await ledger.latestEngineVersionNote({ companyId: row.companyId, strategyId: row.id });
      if (previous === TRADING_ENGINE_VERSION) continue;
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        eventType: "reconciliation",
        detail: {
          reason: "engine_version",
          engineVersion: TRADING_ENGINE_VERSION,
          previousEngineVersion: previous,
          note:
            previous === null
              ? `Trading engine ${TRADING_ENGINE_VERSION}: decisions now use closed candles only. Earlier history was made by an older engine.`
              : `Trading engine changed from ${previous} to ${TRADING_ENGINE_VERSION}.`,
        },
      });
      noted++;
    }
    return { noted };
  }

  /** Boot check of the symbol map against the exchange's market list; never throws (a failed check just means create refuses until it can be done). */
  async function verifyMarketsOnBoot(): Promise<{ missing: TradingAsset[]; strategiesOnMissingMarkets: number } | null> {
    const check = await marketData.verifyMarkets();
    if (isTradingMarketDataError(check)) {
      logger.warn({ message: check.message }, "trading: market list check failed at boot");
      return null;
    }
    let strategiesOnMissingMarkets = 0;
    if (check.missing.length > 0) {
      const rows = await db.select({ asset: tradingStrategies.asset }).from(tradingStrategies);
      strategiesOnMissingMarkets = rows.filter((r) => check.missing.includes(r.asset as TradingAsset)).length;
      logger.warn({ missing: check.missing.map((a) => ccxtSymbolFor(a)), strategiesOnMissingMarkets }, "trading: mapped markets missing from the exchange's market list");
    }
    return { missing: check.missing, strategiesOnMissingMarkets };
  }

  async function dashboard(companyId: string, strategyId: string): Promise<TradingDashboardSummary> {
    const row = await requireStrategy(companyId, strategyId);
    const now = nowOf();
    const quote = await marketData.fetchQuote(row.asset as CreateTradingStrategyInput["asset"], now);
    const quoteNok = isTradingMarketDataError(quote) ? null : usdToNok(quote.bidUsd);
    const positionValueNok = quoteNok !== null ? row.positionQuantity * quoteNok : row.positionCostNok;
    const unrealizedPnlNok = positionValueNok - row.positionCostNok;
    const today = utcDay(now);
    const dailyStats = await ledger.listDailyStats({ companyId, strategyId, limit: 3650 });
    const totalRealized = dailyStats.reduce((sum, d) => sum + d.realizedPnlNok, 0);
    const totalFees = dailyStats.reduce((sum, d) => sum + d.feesNok, 0);
    return {
      strategyId: row.id,
      status: row.status as TradingStrategyStatus,
      pauseReason: row.pauseReason as TradingPauseReason | null,
      asset: row.asset as CreateTradingStrategyInput["asset"],
      startingCashNok: row.startingCashNok,
      cashNok: row.cashNok,
      positionQuantity: row.positionQuantity,
      positionValueNok,
      realizedPnlNok: totalRealized,
      unrealizedPnlNok,
      totalPnlNok: totalRealized + unrealizedPnlNok,
      buyAndHoldValueNok: quoteNok !== null && row.startingQuoteNok !== null ? (row.startingCashNok / row.startingQuoteNok) * quoteNok : null,
      feesPaidNok: totalFees,
      ordersToday: row.ordersTodayDate === today ? row.ordersToday : 0,
      realizedPnlToday: row.realizedPnlTodayDate === today ? row.realizedPnlTodayNok : 0,
      lastTickAt: row.lastTickAt?.toISOString() ?? null,
      lastTickError: row.lastTickError,
    };
  }

  // ─── The tick ──────────────────────────────────────────────────────────

  async function claimDueStrategies(now: Date): Promise<TradingStrategyRow[]> {
    const due = await db
      .select({ id: tradingStrategies.id })
      .from(tradingStrategies)
      .where(and(eq(tradingStrategies.status, "running"), lte(tradingStrategies.nextCheckAt, now), or(isNull(tradingStrategies.checkLeaseUntil), lt(tradingStrategies.checkLeaseUntil, now))))
      .orderBy(asc(tradingStrategies.nextCheckAt))
      .limit(TRADING_TICK_BATCH);
    const claimed: TradingStrategyRow[] = [];
    for (const { id } of due) {
      const [row] = await db
        .update(tradingStrategies)
        .set({ checkLeaseUntil: new Date(now.getTime() + 10 * 60_000) })
        .where(and(eq(tradingStrategies.id, id), eq(tradingStrategies.status, "running"), or(isNull(tradingStrategies.checkLeaseUntil), lt(tradingStrategies.checkLeaseUntil, now))))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  function dayCounters(row: TradingStrategyRow, now: Date) {
    const today = utcDay(now);
    return row.ordersTodayDate === today
      ? { ordersTodayDate: today, ordersToday: row.ordersToday, realizedPnlTodayDate: row.realizedPnlTodayDate, realizedPnlTodayNok: row.realizedPnlTodayNok }
      : { ordersTodayDate: today, ordersToday: 0, realizedPnlTodayDate: today, realizedPnlTodayNok: 0 };
  }

  async function haltStrategy(row: TradingStrategyRow, reason: TradingPauseReason, now: Date, detail: Record<string, unknown>, evaluatedBarAt?: Date) {
    await db
      .update(tradingStrategies)
      .set({ status: "halted_risk", pauseReason: reason, checkLeaseUntil: null, lastTickAt: now, updatedAt: now, ...(evaluatedBarAt ? { lastEvaluatedBarAt: evaluatedBarAt } : {}) })
      .where(eq(tradingStrategies.id, row.id));
    await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, eventType: "circuit_breaker", detail });
    logger.warn({ strategyId: row.id, companyId: row.companyId, reason, ...detail }, "trading: strategy halted");
  }

  async function recordTickFailure(row: TradingStrategyRow, message: string, now: Date) {
    const consecutiveErrors = row.consecutiveErrors + 1;
    if (consecutiveErrors >= TRADING_CIRCUIT_BREAKER_MAX_CONSECUTIVE_ERRORS) {
      await haltStrategy(row, "circuit_breaker", now, { reason: "repeated_fetch_errors", consecutiveErrors, message });
      return;
    }
    await db
      .update(tradingStrategies)
      .set({ consecutiveErrors, lastTickAt: now, lastTickError: message.slice(0, 500), nextCheckAt: new Date(now.getTime() + row.checkEveryMinutes * 60_000), checkLeaseUntil: null, updatedAt: now })
      .where(eq(tradingStrategies.id, row.id));
  }

  async function createTradeApproval(row: TradingStrategyRow, orderId: string, reasonForOperator: string, expiresAt: Date): Promise<string> {
    const approval = await approvalsSvc.create(row.companyId, {
      type: "request_board_approval",
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: {
        kind: "trade",
        strategyId: row.id,
        orderId,
        title: `Trading agent "${row.name}": trade needs approval`,
        summary: reasonForOperator,
        plainSummary: `${reasonForOperator} This card expires in a few minutes; if nobody answers in time, the trade is skipped, not placed anyway.`,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return approval!.id;
  }

  async function fillBuy(row: TradingStrategyRow, quantity: number, priceNok: number, ruleVersion: string, signalPriceNok: number, now: Date, evaluatedBarAt?: Date) {
    const riskConfig = row.riskConfig as TradingRiskConfig;
    const orderValueNok = quantity * priceNok;
    const fee = tradingFeeNok(orderValueNok, riskConfig.feeRatePct);
    const [order] = await db
      .insert(tradingOrders)
      .values({
        companyId: row.companyId,
        strategyId: row.id,
        side: "buy",
        status: "filled",
        ruleVersion,
        signalPriceNok,
        requestedQuantity: quantity,
        filledQuantity: quantity,
        filledPriceNok: priceNok,
        feeNok: fee,
      })
      .returning();
    await ledger.addFifoLot({ companyId: row.companyId, strategyId: row.id, sourceOrderId: order!.id, quantity, costNokPerUnit: (orderValueNok + fee) / quantity, acquiredAt: now });
    await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, orderId: order!.id, eventType: "order_filled", nokValue: orderValueNok, feeNok: fee, detail: { side: "buy", quantity, priceNok } });
    const counters = dayCounters(row, now);
    await ledger.recordDailyStat({ companyId: row.companyId, strategyId: row.id, at: now, feesDeltaNok: fee, ordersDelta: 1 });
    await db
      .update(tradingStrategies)
      .set({
        cashNok: row.cashNok - orderValueNok - fee,
        positionQuantity: row.positionQuantity + quantity,
        positionCostNok: row.positionCostNok + orderValueNok + fee,
        ...counters,
        ordersToday: counters.ordersToday + 1,
        lastTickAt: now,
        lastTickError: null,
        consecutiveErrors: 0,
        nextCheckAt: new Date(now.getTime() + row.checkEveryMinutes * 60_000),
        checkLeaseUntil: null,
        updatedAt: now,
        ...(evaluatedBarAt ? { lastEvaluatedBarAt: evaluatedBarAt } : {}),
      })
      .where(eq(tradingStrategies.id, row.id));
  }

  async function fillSell(row: TradingStrategyRow, quantity: number, priceNok: number, ruleVersion: string, signalPriceNok: number, now: Date, evaluatedBarAt?: Date) {
    const riskConfig = row.riskConfig as TradingRiskConfig;
    const orderValueNok = quantity * priceNok;
    const fee = tradingFeeNok(orderValueNok, riskConfig.feeRatePct);
    const consumed = await ledger.consumeFifoLots({ strategyId: row.id, quantity });
    const proceedsNok = orderValueNok - fee;
    const realizedPnlNok = proceedsNok - consumed.costNokConsumed;
    const [order] = await db
      .insert(tradingOrders)
      .values({
        companyId: row.companyId,
        strategyId: row.id,
        side: "sell",
        status: "filled",
        ruleVersion,
        signalPriceNok,
        requestedQuantity: quantity,
        filledQuantity: consumed.quantityConsumed,
        filledPriceNok: priceNok,
        feeNok: fee,
        realizedPnlNok,
      })
      .returning();
    await ledger.writeLedgerEntry({
      companyId: row.companyId,
      strategyId: row.id,
      orderId: order!.id,
      eventType: "order_filled",
      nokValue: orderValueNok,
      feeNok: fee,
      fifoCostNok: consumed.costNokConsumed,
      realizedPnlNok,
      detail: { side: "sell", quantity: consumed.quantityConsumed, priceNok },
    });
    const counters = dayCounters(row, now);
    await ledger.recordDailyStat({ companyId: row.companyId, strategyId: row.id, at: now, realizedPnlDeltaNok: realizedPnlNok, feesDeltaNok: fee, ordersDelta: 1 });
    await db
      .update(tradingStrategies)
      .set({
        cashNok: row.cashNok + proceedsNok,
        positionQuantity: Math.max(0, row.positionQuantity - consumed.quantityConsumed),
        positionCostNok: Math.max(0, row.positionCostNok - consumed.costNokConsumed),
        ...counters,
        ordersToday: counters.ordersToday + 1,
        realizedPnlTodayNok: counters.realizedPnlTodayNok + realizedPnlNok,
        lastTickAt: now,
        lastTickError: null,
        consecutiveErrors: 0,
        nextCheckAt: new Date(now.getTime() + row.checkEveryMinutes * 60_000),
        checkLeaseUntil: null,
        updatedAt: now,
        ...(evaluatedBarAt ? { lastEvaluatedBarAt: evaluatedBarAt } : {}),
      })
      .where(eq(tradingStrategies.id, row.id));
  }

  async function markNoAction(row: TradingStrategyRow, now: Date, evaluatedBarAt?: Date) {
    const counters = dayCounters(row, now);
    await db
      .update(tradingStrategies)
      .set({
        ...counters,
        lastTickAt: now,
        lastTickError: null,
        consecutiveErrors: 0,
        nextCheckAt: new Date(now.getTime() + row.checkEveryMinutes * 60_000),
        checkLeaseUntil: null,
        updatedAt: now,
        ...(evaluatedBarAt ? { lastEvaluatedBarAt: evaluatedBarAt } : {}),
      })
      .where(eq(tradingStrategies.id, row.id));
  }

  async function tickOne(row: TradingStrategyRow, now: Date): Promise<"filled" | "blocked" | "approval_requested" | "no_action" | "error" | "halted"> {
    const asset = row.asset as Parameters<TradingMarketDataSource["fetchQuote"]>[0];
    const ruleConfig = row.ruleConfig as TradingRuleConfig;
    const riskConfig = row.riskConfig as TradingRiskConfig;

    const timeframe = row.timeframe as TradingTimeframe;
    const raw = await marketData.fetchCandles(asset, timeframe, candleLimit(ruleConfig), now);
    if (isTradingMarketDataError(raw)) {
      await recordTickFailure(row, raw.message, now);
      return raw.kind === "upstream" || raw.kind === "no_data" ? "error" : "halted";
    }
    // Closed bars only: the forming bar never reaches the rule, and price age
    // is measured from the newest closed bar's close time.
    const candles = prepareClosedCandles(raw, timeframe, now, ccxtSymbolFor(asset));
    if (isTradingMarketDataError(candles)) {
      await recordTickFailure(row, candles.message, now);
      return candles.kind === "upstream" || candles.kind === "no_data" ? "error" : "halted";
    }
    const quote = await marketData.fetchQuote(asset, now);
    if (isTradingMarketDataError(quote)) {
      await recordTickFailure(row, quote.message, now);
      return quote.kind === "upstream" || quote.kind === "no_data" ? "error" : "halted";
    }

    const quoteBidNok = usdToNok(quote.bidUsd);
    const quoteAskNok = usdToNok(quote.askUsd);
    const currentEquityNok = row.cashNok + row.positionQuantity * quoteBidNok;
    const peakEquityNok = Math.max(row.peakEquityNok, currentEquityNok);
    if (peakEquityNok !== row.peakEquityNok) {
      await db.update(tradingStrategies).set({ peakEquityNok }).where(eq(tradingStrategies.id, row.id));
    }

    // Which closed bars are new since the last evaluation? Never evaluated =
    // only the latest bar: a fresh or migrated strategy must not trade history.
    const bars = candles.candles;
    const latestIndex = bars.length - 1;
    const latestBar = bars[latestIndex]!;
    const lastEvaluatedMs = row.lastEvaluatedBarAt?.getTime() ?? null;
    const firstNewIndex = lastEvaluatedMs === null ? latestIndex : bars.findIndex((b) => b.openTime.getTime() > lastEvaluatedMs);
    if (firstNewIndex < 0) {
      await markNoAction(row, now); // no new closed bar since the last check
      return "no_action";
    }
    const newBarCount = latestIndex - firstNewIndex + 1;
    if (newBarCount > TRADING_MAX_CATCH_UP_BARS) {
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        eventType: "reconciliation",
        detail: { reason: "catch_up_gap", missedBars: newBarCount, maxCatchUpBars: TRADING_MAX_CATCH_UP_BARS, timeframe, skippedThrough: latestBar.openTime.toISOString() },
      });
      await markNoAction(row, now, latestBar.openTime);
      return "no_action";
    }

    const jumpPct = singleTickPriceJumpPct(candles.closes);
    if (jumpPct !== null && jumpPct > TRADING_CIRCUIT_BREAKER_PRICE_JUMP_PCT) {
      await haltStrategy(row, "circuit_breaker", now, { reason: "single_tick_price_jump", jumpPct }, latestBar.openTime);
      return "halted";
    }

    // Evaluate every new closed bar in order, each with its own history. An
    // older bar's entry only acts if its condition still holds on the latest
    // closed bar; held entries are all the same side, so only the newest one
    // acts. Everything else is logged, not silently dropped.
    const events: Array<{ index: number; side: "buy" | "sell" }> = [];
    for (let i = firstNewIndex; i <= latestIndex; i++) {
      const signalAtBar = evaluateTradingRule(candles.closes.slice(0, i + 1), ruleConfig);
      if (signalAtBar !== "hold") events.push({ index: i, side: signalAtBar });
    }
    const held = events.filter((e) => e.index === latestIndex || tradingSignalStillHolds(candles.closes, ruleConfig, e.side));
    const acting = held[held.length - 1] ?? null;
    for (const e of events) {
      if (e === acting) continue;
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        eventType: "signal",
        detail: {
          kind: "missed_while_not_checking",
          side: e.side,
          barOpenTime: bars[e.index]!.openTime.toISOString(),
          reason: held.includes(e) ? "superseded_by_later_signal" : "no_longer_holds",
        },
      });
    }
    if (acting === null) {
      await markNoAction(row, now, latestBar.openTime);
      return "no_action";
    }
    if (acting.index < latestIndex) {
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        eventType: "signal",
        detail: { kind: "caught_up_entry", side: acting.side, barOpenTime: bars[acting.index]!.openTime.toISOString(), stillHoldsOn: latestBar.openTime.toISOString() },
      });
    }

    const signal = acting.side;
    const lastCloseNok = usdToNok(latestBar.close);
    const evaluatedBarAt = latestBar.openTime;

    const ruleVersion = tradingRuleVersionLabel(ruleConfig);
    const side = signal;
    const quotePriceNok = side === "buy" ? quoteAskNok : quoteBidNok;
    const requestedQuantity = side === "buy" ? (ruleConfig.type === "sma_crossover" ? (ruleConfig.orderSizeFraction * row.cashNok) / quotePriceNok : 0) : row.positionQuantity;

    if (requestedQuantity <= 0) {
      await markNoAction(row, now, evaluatedBarAt);
      return "no_action";
    }

    const counters = dayCounters(row, now);
    const verdict = evaluateTradingRiskGate({
      side,
      signalPriceNok: lastCloseNok,
      quotePriceNok,
      requestedQuantity,
      riskConfig,
      cashNok: row.cashNok,
      positionQuantity: row.positionQuantity,
      positionCostNok: row.positionCostNok,
      ordersToday: counters.ordersToday,
      realizedPnlTodayNok: counters.realizedPnlTodayNok,
      peakEquityNok,
      currentEquityNok,
    });

    if (verdict.kind === "block") {
      const [order] = await db
        .insert(tradingOrders)
        .values({ companyId: row.companyId, strategyId: row.id, side, status: "rejected", ruleVersion, signalPriceNok: lastCloseNok, requestedQuantity, rejectionReason: verdict.reason })
        .returning();
      await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, orderId: order!.id, eventType: "risk_block", detail: { side, reason: verdict.reason } });
      await markNoAction(row, now, evaluatedBarAt);
      return "blocked";
    }

    if (verdict.kind === "needs_approval") {
      const expiresAt = new Date(now.getTime() + TRADING_TRADE_APPROVAL_EXPIRY_MS);
      const [order] = await db
        .insert(tradingOrders)
        .values({ companyId: row.companyId, strategyId: row.id, side, status: "pending_approval", ruleVersion, signalPriceNok: lastCloseNok, requestedQuantity, approvalExpiresAt: expiresAt })
        .returning();
      const approvalId = await createTradeApproval(row, order!.id, verdict.reasonForOperator, expiresAt);
      await db.update(tradingOrders).set({ approvalId }).where(eq(tradingOrders.id, order!.id));
      await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, orderId: order!.id, eventType: "signal", detail: { side, reason: "needs_approval", approvalId } });
      await markNoAction(row, now, evaluatedBarAt);
      return "approval_requested";
    }

    if (side === "buy") await fillBuy(row, requestedQuantity, quotePriceNok, ruleVersion, lastCloseNok, now, evaluatedBarAt);
    else await fillSell(row, requestedQuantity, quotePriceNok, ruleVersion, lastCloseNok, now, evaluatedBarAt);
    return "filled";
  }

  /** Resolves any pending-approval order whose card was decided or has expired -- called before claiming new ticks so a stale card never blocks the next signal. */
  async function resolvePendingApprovals(now: Date): Promise<number> {
    const pending = await db.select().from(tradingOrders).where(eq(tradingOrders.status, "pending_approval"));
    let resolved = 0;
    for (const order of pending) {
      if (order.approvalExpiresAt && order.approvalExpiresAt.getTime() <= now.getTime()) {
        await db.update(tradingOrders).set({ status: "expired_approval" }).where(eq(tradingOrders.id, order.id));
        await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "approval_expired" } });
        resolved++;
        continue;
      }
      if (!order.approvalId) continue;
      const [approval] = await db.select().from(approvals).where(eq(approvals.id, order.approvalId));
      if (!approval || approval.status === "pending" || approval.status === "revision_requested") continue;
      if (approval.status === "rejected") {
        await db.update(tradingOrders).set({ status: "rejected", rejectionReason: "The operator rejected the trade card." }).where(eq(tradingOrders.id, order.id));
        await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "approval_rejected" } });
        resolved++;
        continue;
      }
      if (approval.status === "approved") {
        const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, order.strategyId));
        if (!row) continue;
        const asset = row.asset as Parameters<TradingMarketDataSource["fetchQuote"]>[0];
        const quote = await marketData.fetchQuote(asset, now);
        const riskConfig = row.riskConfig as TradingRiskConfig;
        if (isTradingMarketDataError(quote)) {
          await db.update(tradingOrders).set({ status: "rejected", rejectionReason: quote.message }).where(eq(tradingOrders.id, order.id));
          await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "quote_unavailable_after_approval" } });
          resolved++;
          continue;
        }
        const priceNok = usdToNok(order.side === "buy" ? quote.askUsd : quote.bidUsd);
        const drift = Math.abs(priceNok - order.signalPriceNok) / order.signalPriceNok;
        if (drift * 100 > riskConfig.priceBandPct) {
          await db.update(tradingOrders).set({ status: "rejected", rejectionReason: "The price moved too far while the approval was pending." }).where(eq(tradingOrders.id, order.id));
          await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "price_drift_after_approval" } });
          resolved++;
          continue;
        }
        await db.update(tradingOrders).set({ status: "rejected" }).where(eq(tradingOrders.id, order.id)); // superseded by the fresh fill row fillBuy/fillSell inserts
        if (order.side === "buy") await fillBuy(row, order.requestedQuantity, priceNok, order.ruleVersion, order.signalPriceNok, now);
        else await fillSell(row, order.requestedQuantity, priceNok, order.ruleVersion, order.signalPriceNok, now);
        resolved++;
      }
    }
    return resolved;
  }

  async function tick(now: Date = nowOf()): Promise<TradingTickResult> {
    const approvalsResolved = await resolvePendingApprovals(now);
    const due = await claimDueStrategies(now);
    const result: TradingTickResult = { checked: due.length, filled: 0, blocked: 0, approvalRequested: 0, approvalsResolved, halted: 0 };
    for (const row of due) {
      try {
        const outcome = await tickOne(row, now);
        if (outcome === "filled") result.filled++;
        else if (outcome === "blocked") result.blocked++;
        else if (outcome === "approval_requested") result.approvalRequested++;
        else if (outcome === "halted") result.halted++;
      } catch (err) {
        logger.error({ err, strategyId: row.id }, "trading: tick failed");
        await recordTickFailure(row, err instanceof Error ? err.message : "Unknown error", now);
      }
    }
    return result;
  }

  return {
    listStrategies,
    requireStrategy,
    createStrategy,
    updateStrategy,
    setStatus,
    reconcileOnBoot,
    noteEngineVersion,
    verifyMarketsOnBoot,
    dashboard,
    tick,
    listLedgerEntries: (companyId: string, strategyId: string, limit = 200) => ledger.listLedgerEntries({ companyId, strategyId, limit }),
    listOrders: (companyId: string, strategyId: string) => db.select().from(tradingOrders).where(and(eq(tradingOrders.companyId, companyId), eq(tradingOrders.strategyId, strategyId))).orderBy(asc(tradingOrders.createdAt)),
  };
}
