import { and, asc, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, tradingFifoLots, tradingOrders, tradingStrategies } from "@paperclipai/db";
import {
  TRADING_CIRCUIT_BREAKER_MAX_CONSECUTIVE_ERRORS,
  TRADING_ENGINE_VERSION,
  TRADING_ESTIMATED_USD_NOK_RATE,
  TRADING_MAX_CATCH_UP_BARS,
  TRADING_TICK_BATCH,
  TRADING_TRADE_APPROVAL_EXPIRY_MS,
  ccxtSymbolFor,
  computeTradingEntryLevels,
  deriveTradingRiskConfig,
  describeTradingPauseReason,
  evaluateTradingCatchUp,
  legacySmaCrossoverSpec,
  tradingEntriesHaltedReason,
  tradingPriceJumpThresholdPct,
  tradingSpecWarmupBars,
  tradingStrategySpecSchema,
  tradingTimeframeMs,
  type CreateTradingStrategyInput,
  type TradingDashboardSummary,
  type TradingAsset,
  type TradingEngineBar,
  type TradingPositionState,
  type TradingTimeframe,
  type TradingPauseReason,
  type TradingRiskConfig,
  type TradingStrategySpec,
  type TradingStrategyStatus,
  type UpdateTradingStrategyInput,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { approvalService } from "./approvals.js";
import { fxRatesService, type FxRateQuote, type FxRatesService } from "./fx-rates.js";
import { ccxtTradingMarketData, isTradingMarketDataError, prepareClosedCandles, type TradingMarketDataSource } from "./trading-market-data.js";
import { evaluateEntriesHaltTrip, evaluateTradingEntryGate, evaluateTradingExitGate, singleTickPriceJumpPct, tradingFeeNok } from "./trading-risk-gate.js";
import { tradingLedgerService, type TradingFxStamp } from "./trading-ledger.js";
import { tradingVersionsService, tradingVersionLabel, type ProposeVersionResult, type TradingProposer, type TradingStrategyVersionRow } from "./trading-versions.js";

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
  /** The USD/NOK rate source. Default: read-only over the stored daily rates (the server's scheduler passes one that also fetches them). */
  fxRates?: FxRatesService;
  /** The raw (non request-scoped) db, for the transactions a version change needs. Defaults to the db passed in. */
  rawDb?: Db;
}

/** What the open position's protective levels look like in trading_strategies.position_levels. USD, like the bars. */
export interface TradingPositionLevelsRecord {
  versionId: string;
  entryPrice: number;
  entryAt: string;
  stopPrice: number | null;
  targetPrice: number | null;
  highestPrice: number;
}

/** The rule-book version a fill is stamped with, and the protective levels a buy starts the position with. */
interface FillStamp {
  versionId: string | null;
  levels: TradingPositionLevelsRecord | null;
}

/** What a PATCH that changes the rules returns next to the row: the rules were NOT changed, a draft and a card were filed. */
export interface TradingPendingVersion {
  outcome: ProposeVersionResult["outcome"];
  versionId: string;
  versionNumber: number;
  approvalId: string | null;
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
function candleLimit(spec: TradingStrategySpec): number {
  return tradingSpecWarmupBars(spec) + TRADING_MAX_CATCH_UP_BARS + 1;
}

function fxStampOf(fx: FxRateQuote): TradingFxStamp {
  return { fxRate: fx.rate, fxDate: fx.date, fxSource: fx.source };
}

/**
 * The USD side of a strategy's accounting (DUR-5001). Strategies are scored
 * in USD so the NOK rate creates no fake gains or losses; the NOK columns are
 * the display/tax view. A row a pre-0262 build wrote (during a deploy
 * overlap) has no USD figures yet and is read back at the old fixed 11.5,
 * which is exactly what that build converted at.
 */
function usdSideOf(row: TradingStrategyRow) {
  const r = TRADING_ESTIMATED_USD_NOK_RATE;
  return {
    startingCashUsd: row.startingCashUsd ?? row.startingCashNok / r,
    cashUsd: row.cashUsd ?? row.cashNok / r,
    peakEquityUsd: row.peakEquityUsd ?? row.peakEquityNok / r,
    startingQuoteUsd: row.startingQuoteUsd ?? (row.startingQuoteNok !== null ? row.startingQuoteNok / r : null),
  };
}

export function tradingService(db: Db, deps: TradingServiceDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const marketData = deps.marketData ?? ccxtTradingMarketData();
  const fxRates = deps.fxRates ?? fxRatesService(db);
  const ledger = tradingLedgerService(db);
  const approvalsSvc = approvalService(db);
  const versions = tradingVersionsService(db, { rawDb: deps.rawDb, now: deps.now });

  /** The strategy as the tick must see it: the risk config comes from the active version, never from the cache column. */
  function readingVersion<T extends TradingStrategyRow>(row: T, spec: TradingStrategySpec): T {
    return { ...row, riskConfig: deriveTradingRiskConfig(spec) };
  }

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
    const fx = await fxRates.current(now);
    const startingQuoteUsd = isTradingMarketDataError(quote) ? null : quote.bidUsd;
    const startingQuoteNok = startingQuoteUsd === null ? null : startingQuoteUsd * fx.rate;
    const startingCashUsd = input.startingCashNok / fx.rate;
    if (actor.actorType !== "user") throw unprocessable("Only a person can create a trading strategy.");
    // The owner/admin who creates it approves its first version by creating it:
    // the rules go in as version 1 and the strategy's cache columns are written
    // from that version in the same transaction.
    const book = {
      spec: legacySmaCrossoverSpec({ name: input.name, asset: input.asset, timeframe: input.timeframe, rule: input.ruleConfig, risk: input.riskConfig }),
      guidelines: "",
    };
    return versions.inTransaction(companyId, async (tx) => {
      const [created] = await tx
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
          startingQuoteUsd,
          startingCashUsd,
          cashNok: input.startingCashNok,
          cashUsd: startingCashUsd,
          peakEquityNok: input.startingCashNok,
          peakEquityUsd: startingCashUsd,
          createdByUserId: actor.actorId,
        })
        .returning();
      await versions.createInitialVersion(tx, created!, book, actor.actorId);
      // Born on the daily rate, so the boot-time valuation switch (which resets
      // the drawdown peak) must never touch it: without this note a restart
      // would release a drawdown stop on any strategy created after the deploy.
      await tradingLedgerService(tx).writeLedgerEntry({
        companyId,
        strategyId: created!.id,
        eventType: "reconciliation",
        detail: {
          reason: "valuation_switch",
          note: "strategy created on the daily Norges Bank rate; no valuation switch needed",
          created: true,
          rate: fx.rate,
          rateDate: fx.date,
          rateSource: fx.source,
        },
      });
      const [row] = await tx.select().from(tradingStrategies).where(eq(tradingStrategies.id, created!.id));
      return row!;
    });
  }

  /**
   * Name and check interval are changed directly. A change to the rule or the
   * risk limits NEVER writes the strategy: it becomes a draft version plus an
   * approval card (an owner or admin approves it on the card), and the row
   * comes back unchanged with `pendingVersion` describing the draft. This
   * closes the bypass through the editor, the CLI or a bare API call.
   */
  async function updateStrategy(
    companyId: string,
    strategyId: string,
    input: UpdateTradingStrategyInput,
    actor: { actorType: "user" | "agent"; actorId: string },
  ): Promise<TradingStrategyRow & { pendingVersion?: TradingPendingVersion }> {
    const existing = await requireStrategy(companyId, strategyId);
    let pendingVersion: TradingPendingVersion | undefined;
    if (input.ruleConfig !== undefined || input.riskConfig !== undefined) {
      const { version: active, spec: activeSpec } = await versions.ensureActiveVersion(existing);
      const risk = input.riskConfig ?? deriveTradingRiskConfig(activeSpec);
      const spec =
        input.ruleConfig !== undefined
          ? legacySmaCrossoverSpec({ name: existing.name, asset: existing.asset as TradingAsset, timeframe: existing.timeframe as TradingTimeframe, rule: input.ruleConfig, risk })
          : tradingStrategySpecSchema.parse({ ...activeSpec, neverDo: risk });
      const proposer: TradingProposer = { type: actor.actorType, id: actor.actorId };
      const result = await versions.proposeVersion(companyId, strategyId, { spec, guidelines: active.guidelines }, proposer);
      if (result.outcome !== "unchanged") {
        pendingVersion = { outcome: result.outcome, versionId: result.version.id, versionNumber: result.version.version, approvalId: result.approvalId };
      }
    }
    const direct = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.checkEveryMinutes !== undefined ? { checkEveryMinutes: input.checkEveryMinutes } : {}),
    };
    const [row] =
      Object.keys(direct).length > 0
        ? await db
            .update(tradingStrategies)
            .set({ ...direct, updatedAt: new Date() })
            .where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)))
            .returning()
        : [await requireStrategy(companyId, strategyId)];
    return pendingVersion ? { ...row!, pendingVersion } : row!;
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

  /**
   * The one-time switch to the daily Norges Bank rate (DUR-5001). Per
   * strategy, once: reset peak equity to current equity and write a ledger
   * note. Without the reset a rate below 11.5 could look like a drawdown right
   * after the deploy and trip the limit. Current equity is cash + the open
   * position at the live bid; if the quote cannot be fetched it is cash + the
   * position at cost, so the peak can never end up above what the strategy
   * really holds. A strategy whose USD figures a pre-0262 build left empty is
   * filled in at the old 11.5 first. Call once at boot, before the tick timer
   * is armed; re-running it changes nothing for a strategy already noted.
   * Strategies created after the switch get the note at creation, so only
   * strategies that existed at the deploy are ever reset.
   */
  async function applyValuationSwitch(): Promise<{ switched: number }> {
    const rows = await db.select().from(tradingStrategies);
    const now = nowOf();
    const fx = await fxRates.current(now);
    let switched = 0;
    for (const row of rows) {
      if (await ledger.hasValuationSwitchNote({ companyId: row.companyId, strategyId: row.id })) continue;
      const usd = usdSideOf(row);
      const quote = await marketData.fetchQuote(row.asset as TradingAsset, now);
      const positionValueUsd = isTradingMarketDataError(quote) ? await ledger.openPositionCostUsd(row.id) : row.positionQuantity * quote.bidUsd;
      const equityUsd = usd.cashUsd + positionValueUsd;
      await db
        .update(tradingStrategies)
        .set({
          startingCashUsd: usd.startingCashUsd,
          cashUsd: usd.cashUsd,
          startingQuoteUsd: usd.startingQuoteUsd,
          peakEquityUsd: equityUsd,
          peakEquityNok: equityUsd * fx.rate,
          updatedAt: now,
        })
        .where(eq(tradingStrategies.id, row.id));
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        eventType: "reconciliation",
        detail: {
          reason: "valuation_switch",
          note: "valuation switched to the daily Norges Bank rate",
          peakEquityBeforeNok: row.peakEquityNok,
          peakEquityAfterUsd: equityUsd,
          rate: fx.rate,
          rateDate: fx.date,
          rateSource: fx.source,
          positionValuedAt: isTradingMarketDataError(quote) ? "cost" : "live_bid",
        },
      });
      switched++;
    }
    return { switched };
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
    const fx = await fxRates.current(now);
    const usd = usdSideOf(row);
    const bidUsd = isTradingMarketDataError(quote) ? null : quote.bidUsd;
    const quoteNok = bidUsd === null ? null : bidUsd * fx.rate;
    const positionValueNok = quoteNok !== null ? row.positionQuantity * quoteNok : row.positionCostNok;
    const positionValueUsd = bidUsd !== null ? row.positionQuantity * bidUsd : await ledger.openPositionCostUsd(row.id);
    const equityUsd = usd.cashUsd + positionValueUsd;
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
      // Buy-and-hold is the asset's own USD move applied to the starting cash,
      // so it does not change with the NOK rate (and is identical to the
      // old fixed-11.5 figure for a strategy created before the daily rate).
      buyAndHoldValueNok: bidUsd !== null && usd.startingQuoteUsd !== null ? row.startingCashNok * (bidUsd / usd.startingQuoteUsd) : null,
      feesPaidNok: totalFees,
      startingCashUsd: usd.startingCashUsd,
      cashUsd: usd.cashUsd,
      equityUsd,
      totalPnlUsd: equityUsd - usd.startingCashUsd,
      buyAndHoldValueUsd: bidUsd !== null && usd.startingQuoteUsd !== null ? usd.startingCashUsd * (bidUsd / usd.startingQuoteUsd) : null,
      fxRate: fx.rate,
      fxDate: fx.date,
      fxSource: fx.source,
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

  /**
   * "Entries halted" (DUR-5000): a daily-loss, drawdown or price-jump trip. The
   * strategy stays `running` -- buys are blocked by the entry gate, exits keep
   * being evaluated -- and the reason is kept in pauseReason until an operator
   * resumes it (a daily-loss halt also lifts itself on the next UTC day). Until
   * the vigilance-alerts card exists the alert is a circuit_breaker ledger row
   * plus a log line.
   */
  async function haltEntries(row: TradingStrategyRow, cause: "daily_loss_limit" | "drawdown_limit" | "circuit_breaker", now: Date, detail: Record<string, unknown>) {
    await db
      .update(tradingStrategies)
      .set({ pauseReason: cause satisfies TradingPauseReason, updatedAt: now })
      .where(and(eq(tradingStrategies.id, row.id), eq(tradingStrategies.status, "running")));
    await ledger.writeLedgerEntry({
      companyId: row.companyId,
      strategyId: row.id,
      eventType: "circuit_breaker",
      detail: { alert: "entries_halted", cause, note: "New buys are stopped; exits for an open position keep being evaluated.", ...detail },
    });
    logger.warn({ strategyId: row.id, companyId: row.companyId, cause, ...detail }, "trading: entries halted");
  }

  async function clearEntriesHalt(row: TradingStrategyRow, now: Date, detail: Record<string, unknown>) {
    await db
      .update(tradingStrategies)
      .set({ pauseReason: null, updatedAt: now })
      .where(and(eq(tradingStrategies.id, row.id), eq(tradingStrategies.status, "running")));
    await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, eventType: "reconciliation", detail: { reason: "entries_halt_lifted", ...detail } });
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

  async function fillBuy(row: TradingStrategyRow, quantity: number, priceUsd: number, fx: FxRateQuote, ruleVersion: string, signalPriceNok: number, now: Date, stamp: FillStamp, evaluatedBarAt?: Date) {
    const riskConfig = row.riskConfig as TradingRiskConfig;
    const priceNok = priceUsd * fx.rate;
    const orderValueUsd = quantity * priceUsd;
    const orderValueNok = quantity * priceNok;
    const fee = tradingFeeNok(orderValueNok, riskConfig.feeRatePct);
    const feeUsd = tradingFeeNok(orderValueUsd, riskConfig.feeRatePct);
    const fxStamp = fxStampOf(fx);
    const [order] = await db
      .insert(tradingOrders)
      .values({
        companyId: row.companyId,
        strategyId: row.id,
        side: "buy",
        status: "filled",
        ruleVersion,
        strategyVersionId: stamp.versionId,
        signalPriceNok,
        requestedQuantity: quantity,
        filledQuantity: quantity,
        filledPriceNok: priceNok,
        feeNok: fee,
        ...fxStamp,
      })
      .returning();
    await ledger.addFifoLot({ companyId: row.companyId, strategyId: row.id, sourceOrderId: order!.id, quantity, costNokPerUnit: (orderValueNok + fee) / quantity, acquiredAt: now, fx: fxStamp });
    await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, orderId: order!.id, strategyVersionId: stamp.versionId, eventType: "order_filled", nokValue: orderValueNok, feeNok: fee, detail: { side: "buy", quantity, priceNok, priceUsd, ...fxStamp } });
    const counters = dayCounters(row, now);
    await ledger.recordDailyStat({ companyId: row.companyId, strategyId: row.id, at: now, feesDeltaNok: fee, ordersDelta: 1 });
    await db
      .update(tradingStrategies)
      .set({
        cashNok: row.cashNok - orderValueNok - fee,
        cashUsd: usdSideOf(row).cashUsd - orderValueUsd - feeUsd,
        positionQuantity: row.positionQuantity + quantity,
        positionCostNok: row.positionCostNok + orderValueNok + fee,
        // Protective levels of the new position (null when the approval card delayed the fill: the next tick derives them from the active version).
        positionLevels: stamp.levels,
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

  async function fillSell(row: TradingStrategyRow, quantity: number, priceUsd: number, fx: FxRateQuote, ruleVersion: string, signalPriceNok: number, now: Date, stamp: FillStamp, evaluatedBarAt?: Date) {
    const riskConfig = row.riskConfig as TradingRiskConfig;
    const priceNok = priceUsd * fx.rate;
    const orderValueUsd = quantity * priceUsd;
    const orderValueNok = quantity * priceNok;
    const fee = tradingFeeNok(orderValueNok, riskConfig.feeRatePct);
    const feeUsd = tradingFeeNok(orderValueUsd, riskConfig.feeRatePct);
    const fxStamp = fxStampOf(fx);
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
        strategyVersionId: stamp.versionId,
        signalPriceNok,
        requestedQuantity: quantity,
        filledQuantity: consumed.quantityConsumed,
        filledPriceNok: priceNok,
        feeNok: fee,
        realizedPnlNok,
        ...fxStamp,
      })
      .returning();
    await ledger.writeLedgerEntry({
      companyId: row.companyId,
      strategyId: row.id,
      orderId: order!.id,
      strategyVersionId: stamp.versionId,
      eventType: "order_filled",
      nokValue: orderValueNok,
      feeNok: fee,
      fifoCostNok: consumed.costNokConsumed,
      realizedPnlNok,
      detail: { side: "sell", quantity: consumed.quantityConsumed, priceNok, priceUsd, realizedPnlUsd: orderValueUsd - feeUsd - consumed.costUsdConsumed, ...fxStamp },
    });
    const counters = dayCounters(row, now);
    await ledger.recordDailyStat({ companyId: row.companyId, strategyId: row.id, at: now, realizedPnlDeltaNok: realizedPnlNok, feesDeltaNok: fee, ordersDelta: 1 });
    await db
      .update(tradingStrategies)
      .set({
        cashNok: row.cashNok + proceedsNok,
        cashUsd: usdSideOf(row).cashUsd + orderValueUsd - feeUsd,
        positionQuantity: Math.max(0, row.positionQuantity - consumed.quantityConsumed),
        positionCostNok: Math.max(0, row.positionCostNok - consumed.costNokConsumed),
        positionLevels: Math.max(0, row.positionQuantity - consumed.quantityConsumed) > 1e-12 ? row.positionLevels : null,
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

  /**
   * Where the strategy's open position stands, for the engine. The levels are
   * kept on the strategy row from the moment the position opened; when they
   * are missing (a fill delayed by an approval card) or belong to an older
   * version (a new version went live while the position was open), they are
   * derived again from the active version, measured from the position's own
   * entry price, and saved.
   */
  async function positionStateFor(row: TradingStrategyRow, version: TradingStrategyVersionRow, spec: TradingStrategySpec, bars: readonly TradingEngineBar[], now: Date): Promise<TradingPositionState> {
    const timeframeMs = tradingTimeframeMs(row.timeframe as TradingTimeframe);
    if (row.positionQuantity <= 1e-12) {
      const cooldown = spec.stayOut.cooldownAfterLosses;
      if (!cooldown) return { kind: "flat" };
      const sells = await db
        .select({ realizedPnlNok: tradingOrders.realizedPnlNok, createdAt: tradingOrders.createdAt })
        .from(tradingOrders)
        .where(and(eq(tradingOrders.strategyId, row.id), eq(tradingOrders.side, "sell"), eq(tradingOrders.status, "filled")))
        .orderBy(desc(tradingOrders.createdAt))
        .limit(Math.max(20, cooldown.losses));
      let consecutiveLosses = 0;
      for (const sell of sells) {
        if ((sell.realizedPnlNok ?? 0) < 0) consecutiveLosses++;
        else break;
      }
      const lastClose = bars.length > 0 ? bars[bars.length - 1]!.openTime.getTime() + timeframeMs : now.getTime();
      const barsSinceExit = sells[0] ? Math.max(0, Math.floor((lastClose - sells[0].createdAt.getTime()) / timeframeMs)) : null;
      return { kind: "flat", consecutiveLosses, barsSinceExit };
    }
    const stored = row.positionLevels as TradingPositionLevelsRecord | null;
    let record: TradingPositionLevelsRecord;
    if (stored && stored.versionId === version.id) {
      record = stored;
    } else {
      const entryPrice = stored?.entryPrice ?? (await ledger.openPositionCostUsd(row.id)) / row.positionQuantity;
      let entryAt: Date;
      if (stored) entryAt = new Date(stored.entryAt);
      else {
        const [lot] = await db
          .select({ acquiredAt: tradingFifoLots.acquiredAt })
          .from(tradingFifoLots)
          .where(and(eq(tradingFifoLots.strategyId, row.id), gt(tradingFifoLots.quantityRemaining, 0)))
          .orderBy(asc(tradingFifoLots.acquiredAt))
          .limit(1);
        entryAt = lot?.acquiredAt ?? now;
      }
      const levels = bars.length > 0 ? computeTradingEntryLevels(spec, bars, bars.length - 1, entryPrice) : { stopPrice: null, targetPrice: null };
      record = {
        versionId: version.id,
        entryPrice,
        entryAt: entryAt.toISOString(),
        stopPrice: levels.stopPrice,
        targetPrice: levels.targetPrice,
        highestPrice: Math.max(stored?.highestPrice ?? entryPrice, entryPrice),
      };
      await db.update(tradingStrategies).set({ positionLevels: record }).where(eq(tradingStrategies.id, row.id));
    }
    return { kind: "long", entryPrice: record.entryPrice, entryAt: new Date(record.entryAt), stopPrice: record.stopPrice, targetPrice: record.targetPrice, highestPrice: record.highestPrice };
  }

  async function tickOne(claimed: TradingStrategyRow, now: Date): Promise<"filled" | "blocked" | "approval_requested" | "no_action" | "error" | "halted"> {
    // The tick reads only the active version: its rules, and the risk limits derived from it.
    const active = await versions.ensureActiveVersion(claimed);
    const version = active.version;
    const spec = active.spec;
    const row = readingVersion(active.strategy, spec);
    const asset = row.asset as Parameters<TradingMarketDataSource["fetchQuote"]>[0];
    const riskConfig = row.riskConfig as TradingRiskConfig;

    const timeframe = row.timeframe as TradingTimeframe;
    const raw = await marketData.fetchCandles(asset, timeframe, candleLimit(spec), now);
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

    // One rate for the whole tick, stamped on whatever fills. Equity, the
    // drawdown peak and order sizing are all in USD (the market's own
    // currency), so a move in the NOK rate can never look like a gain or a
    // loss; NOK only prices the order for display, the caps and the tax ledger.
    const fx = await fxRates.current(now);
    const usd = usdSideOf(row);
    const quoteBidNok = quote.bidUsd * fx.rate;
    const quoteAskNok = quote.askUsd * fx.rate;
    const currentEquityUsd = usd.cashUsd + row.positionQuantity * quote.bidUsd;
    const peakEquityUsd = Math.max(usd.peakEquityUsd, currentEquityUsd);
    if (peakEquityUsd !== row.peakEquityUsd) {
      await db.update(tradingStrategies).set({ peakEquityUsd, peakEquityNok: peakEquityUsd * fx.rate }).where(eq(tradingStrategies.id, row.id));
    }

    // Entries-halt state: daily-loss, drawdown and price-jump trips block new
    // buys (the entry gate) but never exits. A daily-loss halt lifts itself once
    // the day's loss counter resets; the others wait for an operator.
    const counters = dayCounters(row, now);
    let entriesHalt = tradingEntriesHaltedReason(row.status, row.pauseReason);
    const trip = evaluateEntriesHaltTrip({ riskConfig, realizedPnlTodayNok: counters.realizedPnlTodayNok, peakEquity: peakEquityUsd, currentEquity: currentEquityUsd });
    if (entriesHalt === "daily_loss_limit" && trip?.cause !== "daily_loss_limit") {
      await clearEntriesHalt(row, now, { cause: "daily_loss_limit", note: "A new day began; the daily loss limit no longer applies." });
      entriesHalt = null;
    }
    if (entriesHalt === null && trip) {
      await haltEntries(row, trip.cause, now, { reason: trip.reason, realizedPnlTodayNok: counters.realizedPnlTodayNok, peakEquityUsd, currentEquityUsd });
      entriesHalt = trip.cause;
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
        strategyVersionId: version.id,
        eventType: "reconciliation",
        detail: { reason: "catch_up_gap", missedBars: newBarCount, maxCatchUpBars: TRADING_MAX_CATCH_UP_BARS, timeframe, skippedThrough: latestBar.openTime.toISOString() },
      });
      await markNoAction(row, now, latestBar.openTime);
      return "no_action";
    }

    const jumpPct = singleTickPriceJumpPct(candles.closes);
    const jumpThresholdPct = tradingPriceJumpThresholdPct(timeframe);
    // A jump during a daily-loss halt must not be lost: that halt lifts itself
    // on the next UTC day, so upgrade it to the sticky circuit_breaker (operator
    // review) -- otherwise buys resume once the jump bar has aged out of the
    // last two closes. Drawdown and circuit_breaker halts are already sticky.
    if (jumpPct !== null && jumpPct > jumpThresholdPct && (entriesHalt === null || entriesHalt === "daily_loss_limit")) {
      await haltEntries(row, "circuit_breaker", now, { reason: "single_tick_price_jump", jumpPct, jumpThresholdPct, timeframe, ...(entriesHalt ? { replacedHalt: entriesHalt } : {}) });
      entriesHalt = "circuit_breaker";
    }

    // Evaluate every new closed bar in order, each with its own history, with
    // a virtual position that follows the decisions. An older bar's decision
    // only acts if what it announced still holds on the latest closed bar;
    // everything else is logged, not silently dropped.
    const position = await positionStateFor(row, version, spec, bars, now);
    const catchUp = evaluateTradingCatchUp(spec, bars, firstNewIndex, position);
    if (position.kind === "long") {
      let highest = position.highestPrice;
      for (let i = firstNewIndex; i <= latestIndex; i++) highest = Math.max(highest, bars[i]!.high);
      if (highest > position.highestPrice) {
        const stored = row.positionLevels as TradingPositionLevelsRecord | null;
        const base = stored ?? { versionId: version.id, entryPrice: position.entryPrice, entryAt: position.entryAt.toISOString(), stopPrice: position.stopPrice, targetPrice: position.targetPrice };
        await db
          .update(tradingStrategies)
          .set({ positionLevels: { ...base, versionId: version.id, highestPrice: highest } })
          .where(eq(tradingStrategies.id, row.id));
      }
    }
    const acting = catchUp.acting;
    for (const d of catchUp.decisions) {
      if (d === acting) continue;
      await ledger.writeLedgerEntry({
        companyId: row.companyId,
        strategyId: row.id,
        strategyVersionId: version.id,
        eventType: "signal",
        detail: {
          kind: "missed_while_not_checking",
          side: d.decision.action === "enter" ? "buy" : "sell",
          barOpenTime: bars[d.index]!.openTime.toISOString(),
          reasonCodes: d.decision.reasonCodes,
          reason: d.stillHolds ? "superseded_by_later_signal" : "no_longer_holds",
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
        strategyVersionId: version.id,
        eventType: "signal",
        detail: {
          kind: "caught_up_entry",
          side: acting.decision.action === "enter" ? "buy" : "sell",
          reasonCodes: acting.decision.reasonCodes,
          barOpenTime: bars[acting.index]!.openTime.toISOString(),
          stillHoldsOn: latestBar.openTime.toISOString(),
        },
      });
    }

    const decision = acting.decision;
    const lastCloseNok = latestBar.close * fx.rate;
    const evaluatedBarAt = latestBar.openTime;

    const ruleVersion = tradingVersionLabel(version, TRADING_ENGINE_VERSION);
    const side = decision.action === "enter" ? "buy" : "sell";
    const quotePriceNok = side === "buy" ? quoteAskNok : quoteBidNok;
    const quotePriceUsd = side === "buy" ? quote.askUsd : quote.bidUsd;
    // A spec never adds to an open position (the old rule bought again on a second cross-up).
    const requestedQuantity = side === "buy" ? (row.positionQuantity > 1e-12 ? 0 : ((decision.sizeFractionOfCash ?? 0) * usd.cashUsd) / quotePriceUsd) : row.positionQuantity;

    if (requestedQuantity <= 0) {
      await markNoAction(row, now, evaluatedBarAt);
      return "no_action";
    }

    // The spec's own spread rule, checked against the live quote (the bars have no spread).
    const spreadPct = ((quote.askUsd - quote.bidUsd) / ((quote.askUsd + quote.bidUsd) / 2)) * 100;
    const spreadBlock =
      side === "buy" && spec.stayOut.maxSpreadPct !== undefined && spreadPct > spec.stayOut.maxSpreadPct
        ? { kind: "block" as const, reason: `The spread (${spreadPct.toFixed(2)}%) is wider than this strategy's limit (${spec.stayOut.maxSpreadPct}%).` }
        : null;

    // Sells go through the exit gate: it refuses only impossible input and
    // never applies the price band, order count, loss or drawdown blocks, nor
    // asks for a card an unanswered 5-minute timeout would strand.
    const verdict =
      spreadBlock ??
      (side === "sell"
        ? evaluateTradingExitGate({ requestedQuantity, positionQuantity: row.positionQuantity, quotePriceNok })
        : evaluateTradingEntryGate({
            side,
            signalPriceNok: lastCloseNok,
            quotePriceNok,
            requestedQuantity,
            riskConfig,
            cashNok: usd.cashUsd * fx.rate,
            positionQuantity: row.positionQuantity,
            positionCostNok: row.positionCostNok,
            ordersToday: counters.ordersToday,
            realizedPnlTodayNok: counters.realizedPnlTodayNok,
            peakEquity: peakEquityUsd,
            currentEquity: currentEquityUsd,
            entriesHaltedReason: entriesHalt ? describeTradingPauseReason(entriesHalt) : null,
          }));

    if (verdict.kind === "block") {
      const [order] = await db
        .insert(tradingOrders)
        .values({ companyId: row.companyId, strategyId: row.id, strategyVersionId: version.id, side, status: "rejected", ruleVersion, signalPriceNok: lastCloseNok, requestedQuantity, rejectionReason: verdict.reason })
        .returning();
      await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, strategyVersionId: version.id, orderId: order!.id, eventType: "risk_block", detail: { side, reason: verdict.reason, reasonCodes: decision.reasonCodes } });
      await markNoAction(row, now, evaluatedBarAt);
      return "blocked";
    }

    if (verdict.kind === "needs_approval") {
      const expiresAt = new Date(now.getTime() + TRADING_TRADE_APPROVAL_EXPIRY_MS);
      const [order] = await db
        .insert(tradingOrders)
        .values({ companyId: row.companyId, strategyId: row.id, strategyVersionId: version.id, side, status: "pending_approval", ruleVersion, signalPriceNok: lastCloseNok, requestedQuantity, approvalExpiresAt: expiresAt, ...fxStampOf(fx) })
        .returning();
      const approvalId = await createTradeApproval(row, order!.id, verdict.reasonForOperator, expiresAt);
      await db.update(tradingOrders).set({ approvalId }).where(eq(tradingOrders.id, order!.id));
      await ledger.writeLedgerEntry({ companyId: row.companyId, strategyId: row.id, strategyVersionId: version.id, orderId: order!.id, eventType: "signal", detail: { side, reason: "needs_approval", approvalId, reasonCodes: decision.reasonCodes } });
      await markNoAction(row, now, evaluatedBarAt);
      return "approval_requested";
    }

    if (side === "buy") {
      const levels: TradingPositionLevelsRecord = {
        versionId: version.id,
        entryPrice: quotePriceUsd,
        entryAt: now.toISOString(),
        stopPrice: decision.levels?.stopPrice ?? null,
        targetPrice: decision.levels?.targetPrice ?? null,
        highestPrice: Math.max(quotePriceUsd, decision.highestPrice ?? quotePriceUsd),
      };
      await fillBuy(row, requestedQuantity, quotePriceUsd, fx, ruleVersion, lastCloseNok, now, { versionId: version.id, levels }, evaluatedBarAt);
    } else {
      await fillSell(row, requestedQuantity, quotePriceUsd, fx, ruleVersion, lastCloseNok, now, { versionId: version.id, levels: null }, evaluatedBarAt);
    }
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
        // Close the board card too: no dead card stays in "Needs you", and a late approve of the stale card is refused (a cancelled approval cannot be approved).
        if (order.approvalId) {
          try {
            await approvalsSvc.withdraw(order.approvalId, "Expired: nobody answered in time, so the trade was skipped.");
          } catch (err) {
            logger.warn({ err, approvalId: order.approvalId, orderId: order.id }, "trading: could not close the expired trade card (already decided?)");
          }
        }
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
        // The owner's pause / kill switch and the data-error halt stop everything; a halted-entries state stops buys only (exits still run).
        const entriesHalt = tradingEntriesHaltedReason(row.status, row.pauseReason);
        if (row.status !== "running" || (order.side === "buy" && entriesHalt !== null)) {
          await db.update(tradingOrders).set({ status: "rejected", rejectionReason: row.status !== "running" ? "The strategy was paused or halted before the approved trade could be placed." : "New buys were halted before the approved trade could be placed." }).where(eq(tradingOrders.id, order.id));
          await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: row.status !== "running" ? "strategy_not_running_after_approval" : "entries_halted_after_approval" } });
          resolved++;
          continue;
        }
        const asset = row.asset as Parameters<TradingMarketDataSource["fetchQuote"]>[0];
        const quote = await marketData.fetchQuote(asset, now);
        // Risk limits come from the active version, like everywhere else on the order path.
        const activeForRisk = await versions.ensureActiveVersion(row);
        const riskConfig = deriveTradingRiskConfig(activeForRisk.spec);
        if (isTradingMarketDataError(quote)) {
          await db.update(tradingOrders).set({ status: "rejected", rejectionReason: quote.message }).where(eq(tradingOrders.id, order.id));
          await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "quote_unavailable_after_approval" } });
          resolved++;
          continue;
        }
        const fx = await fxRates.current(now);
        const priceUsd = order.side === "buy" ? quote.askUsd : quote.bidUsd;
        // Compare in USD: the signal price was converted at the rate stamped on
        // the pending order, so a new day's rate cannot look like price drift.
        const signalPriceUsd = order.signalPriceNok / (order.fxRate ?? TRADING_ESTIMATED_USD_NOK_RATE);
        const drift = Math.abs(priceUsd - signalPriceUsd) / signalPriceUsd;
        if (order.side === "buy" && drift * 100 > riskConfig.priceBandPct) {
          await db.update(tradingOrders).set({ status: "rejected", rejectionReason: "The price moved too far while the approval was pending." }).where(eq(tradingOrders.id, order.id));
          await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "order_rejected", detail: { reason: "price_drift_after_approval" } });
          resolved++;
          continue;
        }
        if (order.side === "buy") {
          // The approval card was raised on an earlier tick, and the halt state is
          // only written by tickOne, so re-run the whole entry gate on fresh
          // numbers (drawdown, daily loss, order count, cash, position caps).
          // The gate asks for approval above the threshold; this card is that
          // approval, so needs_approval passes.
          const usd = usdSideOf(row);
          const counters = dayCounters(row, now);
          const currentEquityUsd = usd.cashUsd + row.positionQuantity * quote.bidUsd;
          const gate = evaluateTradingEntryGate({
            side: "buy",
            signalPriceNok: signalPriceUsd * fx.rate,
            quotePriceNok: priceUsd * fx.rate,
            requestedQuantity: order.requestedQuantity,
            riskConfig,
            cashNok: usd.cashUsd * fx.rate,
            positionQuantity: row.positionQuantity,
            positionCostNok: row.positionCostNok,
            ordersToday: counters.ordersToday,
            realizedPnlTodayNok: counters.realizedPnlTodayNok,
            peakEquity: Math.max(usd.peakEquityUsd, currentEquityUsd),
            currentEquity: currentEquityUsd,
            entriesHaltedReason: null,
          });
          if (gate.kind === "block") {
            await db.update(tradingOrders).set({ status: "rejected", rejectionReason: `Not placed after approval: ${gate.reason}` }).where(eq(tradingOrders.id, order.id));
            await ledger.writeLedgerEntry({ companyId: order.companyId, strategyId: order.strategyId, orderId: order.id, eventType: "risk_block", detail: { side: "buy", reason: gate.reason, stage: "after_approval" } });
            resolved++;
            continue;
          }
        }
        await db.update(tradingOrders).set({ status: "rejected" }).where(eq(tradingOrders.id, order.id)); // superseded by the fresh fill row fillBuy/fillSell inserts
        const fillRow = readingVersion(activeForRisk.strategy, activeForRisk.spec);
        const fillStamp: FillStamp = { versionId: order.strategyVersionId ?? activeForRisk.version.id, levels: null };
        if (order.side === "buy") await fillBuy(fillRow, order.requestedQuantity, priceUsd, fx, order.ruleVersion, order.signalPriceNok, now, fillStamp);
        else await fillSell(fillRow, order.requestedQuantity, priceUsd, fx, order.ruleVersion, order.signalPriceNok, now, fillStamp);
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
    versions,
    setStatus,
    reconcileOnBoot,
    noteEngineVersion,
    applyValuationSwitch,
    verifyMarketsOnBoot,
    dashboard,
    tick,
    listLedgerEntries: (companyId: string, strategyId: string, limit = 200) => ledger.listLedgerEntries({ companyId, strategyId, limit }),
    listOrders: (companyId: string, strategyId: string) => db.select().from(tradingOrders).where(and(eq(tradingOrders.companyId, companyId), eq(tradingOrders.strategyId, strategyId))).orderBy(asc(tradingOrders.createdAt)),
  };
}
