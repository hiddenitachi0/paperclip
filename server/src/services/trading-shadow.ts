import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { tradingShadowCells, tradingShadowTrades, tradingStrategies, type Db } from "@paperclipai/db";
import {
  TRADING_ASSETS,
  TRADING_BACKTEST_COSTS,
  TRADING_CANDLE_TIMEFRAMES,
  TRADING_ELIGIBILITY_MATRIX_V1,
  TRADING_ESTIMATED_USD_NOK_RATE,
  TRADING_REGIME_RULES_VERSION,
  dropFormingCandles,
  shadowEligibility,
  tradingCandleMarket,
  tradingCellKey,
  tradingTemplates,
  tradingTimeframeMs,
  type TradingAsset,
  type TradingCandle,
  type TradingTimeframe,
  type TradingTemplate,
  type TradingWeatherKey,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { listCandles } from "./trading-candle-store.js";
import { regimeAsOf } from "./trading-regimes.js";
import { BACKTEST_DEFAULT_COSTS, backtestWarmupBars, simulateWindow, specDecider } from "./trading-backtest-engine.js";

/**
 * DUR-5015: the shadow tournament.
 *
 * Every eligible template runs on the same closed bars as the prediction
 * evaluator, in every company that trades, whatever the strategy list says. It
 * logs simulated trades and nothing else: this file imports no order, ledger,
 * balance or approval code and writes only trading_shadow_cells and
 * trading_shadow_trades. It runs on the evaluator's scheduler chain, so, like
 * the evaluator, it starts by itself on boot and a bar that closed before the
 * process started is never used (its next open would already be known).
 *
 * One function decides: a signal is the template's own rules run on the newest
 * closed bar as if flat, and a trade is closed by the same simulator the
 * past-data tests use (simulateWindow), at the paper fee (0.40% per side) and
 * again at double the fee, which is what the selector tests. The simulated
 * fill is the next bar's open.
 */

export const TRADING_SHADOW_ENGINE_VERSION = 1;
const BAR_LIMIT = 1500;
/** A shadow account is the size of a default paper strategy, so the templates' own position caps behave as they would on paper. */
const SHADOW_START_CASH_USD = 3_000 / TRADING_ESTIMATED_USD_NOK_RATE;
const DONE_MEMORY = 4096;
/** Newest bars to look at when a trade's signal bar is not in them: after this many bars it is given up. */
const GIVE_UP_AFTER_BARS = 600;
/** How many open trades one tick looks at, and how many orphans one tick may give up. */
const RESOLVE_WINDOW = 2000;
const ORPHAN_BATCH = 500;

export interface TradingShadowDeps {
  now?: () => Date;
  /** The process start. A bar that closed at or before it is never signalled. */
  bootedAt?: Date;
  /** Closed bars of a coin, oldest first. Tests inject candles; the default reads the candle store. */
  loadBars?: (asset: TradingAsset, timeframe: ShadowTimeframe, now: Date) => Promise<TradingCandle[]>;
  templates?: readonly TradingTemplate[];
}

export interface TradingShadowTickResult {
  companies: number;
  cellsRegistered: number;
  signals: number;
  opened: number;
  closed: number;
  voided: number;
}

/** A decision timeframe the candle store holds (the 15-minute bars are for research only). */
type ShadowTimeframe = Exclude<TradingTimeframe, "15m">;
const isCandleTimeframe = (tf: string): tf is ShadowTimeframe => tf !== "15m" && (TRADING_CANDLE_TIMEFRAMES as readonly string[]).includes(tf);

export function tradingShadowService(db: Db, deps: TradingShadowDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const bootedAt = deps.bootedAt ?? nowOf();
  const matrix = TRADING_ELIGIBILITY_MATRIX_V1;
  const done = new Set<string>();
  const cellIds = new Map<string, string>();

  const competing = (): TradingTemplate[] => (deps.templates ?? tradingTemplates()).filter((t) => !t.controlKind && t.spec.meta.family !== "control" && t.requiresData.length === 0);

  async function loadBars(asset: TradingAsset, timeframe: ShadowTimeframe, now: Date): Promise<TradingCandle[]> {
    if (deps.loadBars) return deps.loadBars(asset, timeframe, now);
    const tf = tradingTimeframeMs(timeframe);
    const stored = await listCandles(db, {
      source: "kraken",
      market: tradingCandleMarket("kraken", asset),
      timeframe,
      from: new Date(now.getTime() - BAR_LIMIT * tf),
      to: now,
      limit: BAR_LIMIT,
    });
    return dropFormingCandles(stored as TradingCandle[], timeframe, now);
  }

  async function tradingCompanyIds(): Promise<string[]> {
    const rows = await db.selectDistinct({ companyId: tradingStrategies.companyId }).from(tradingStrategies);
    return rows.map((r) => r.companyId);
  }

  async function ensureCell(companyId: string, template: TradingTemplate, weather: TradingWeatherKey, asset: TradingAsset): Promise<{ id: string; created: boolean }> {
    const key = `${companyId}|${tradingCellKey({ templateKey: `${template.key}@${template.templateVersion}`, weather, asset })}`;
    const known = cellIds.get(key);
    if (known) return { id: known, created: false };
    const inserted = await db
      .insert(tradingShadowCells)
      .values({ companyId, templateKey: template.key, templateVersion: template.templateVersion, family: template.spec.meta.family, weather, asset })
      .onConflictDoNothing()
      .returning({ id: tradingShadowCells.id });
    let id = inserted[0]?.id;
    if (!id) {
      const [row] = await db
        .select({ id: tradingShadowCells.id })
        .from(tradingShadowCells)
        .where(and(eq(tradingShadowCells.companyId, companyId), eq(tradingShadowCells.templateKey, template.key), eq(tradingShadowCells.templateVersion, template.templateVersion), eq(tradingShadowCells.weather, weather), eq(tradingShadowCells.asset, asset)));
      id = row!.id;
    }
    cellIds.set(key, id);
    return { id, created: inserted.length > 0 };
  }

  /** New closed bars: register cells, record signals. */
  async function evaluate(now: Date, result: TradingShadowTickResult): Promise<void> {
    const companyIds = await tradingCompanyIds();
    result.companies = companyIds.length;
    if (companyIds.length === 0) return;
    const templates = competing().filter((t) => isCandleTimeframe(t.spec.universe.decisionTimeframe));
    const timeframes = [...new Set(templates.map((t) => t.spec.universe.decisionTimeframe as ShadowTimeframe))];
    for (const timeframe of timeframes) {
      const tf = tradingTimeframeMs(timeframe);
      const expectedClose = new Date(Math.floor(now.getTime() / tf) * tf);
      if (expectedClose.getTime() <= bootedAt.getTime()) continue;
      for (const asset of TRADING_ASSETS) {
        const doneKey = `${timeframe}|${asset}|${expectedClose.getTime()}`;
        if (done.has(doneKey)) continue;
        try {
          const bars = await loadBars(asset, timeframe, now);
          const last = bars[bars.length - 1];
          // The store has not caught up with this bar yet; the next tick tries again.
          if (!last || last.openTime.getTime() + tf < expectedClose.getTime()) continue;
          const barCloseAt = new Date(last.openTime.getTime() + tf);
          if (barCloseAt.getTime() <= bootedAt.getTime()) continue;
          const label = await regimeAsOf(db, asset, barCloseAt);
          if (!label) continue; // no market-weather label for this coin yet
          const lastIndex = bars.length - 1;
          for (const template of templates.filter((t) => t.spec.universe.decisionTimeframe === timeframe)) {
            const eligibility = shadowEligibility(template, label, matrix);
            if (!eligibility.eligible) continue;
            const decision = specDecider(template.spec)(bars, lastIndex, { kind: "flat" }, { join: () => null });
            for (const companyId of companyIds) {
              const cell = await ensureCell(companyId, template, eligibility.weather, asset);
              if (cell.created) result.cellsRegistered++;
              if (decision.action !== "enter") continue;
              result.signals++;
              const inserted = await db
                .insert(tradingShadowTrades)
                .values({
                  companyId,
                  cellId: cell.id,
                  templateKey: template.key,
                  templateVersion: template.templateVersion,
                  asset,
                  timeframe,
                  weather: eligibility.weather,
                  signalBarCloseAt: barCloseAt,
                  weatherLabel: {
                    day: label.day,
                    availableAt: label.availableAt.toISOString(),
                    trend: label.trend,
                    volatility: label.volatility,
                    squeeze: label.squeeze,
                    spellNo: label.spellNo,
                    regimeRulesVersion: TRADING_REGIME_RULES_VERSION,
                    matrixVersion: matrix.version,
                    reasonCodes: decision.reasonCodes,
                  },
                })
                .onConflictDoNothing()
                .returning({ id: tradingShadowTrades.id });
              result.opened += inserted.length;
            }
          }
          done.add(doneKey);
          if (done.size > DONE_MEMORY) done.clear();
        } catch (err) {
          logger.error({ err, asset, timeframe }, "trading shadow: evaluating a coin failed");
        }
      }
    }
  }

  /**
   * An open trade the resolver can never close: its template version is no longer
   * competing, or its timeframe is not one the candle store holds. Such a row is
   * kept out of the resolve window (it would otherwise sit at the front, oldest
   * first, and starve the real rows) and is given up after the same grace a
   * trade with no bars gets. Only these are expired by age: a real trade that is
   * still being held is never voided for being old, which would bias the record.
   */
  function realTradeFilter(): SQL {
    const known = competing().map((t) => and(eq(tradingShadowTrades.templateKey, t.key), eq(tradingShadowTrades.templateVersion, t.templateVersion)));
    return and(or(...known) ?? sql`false`, inArray(tradingShadowTrades.timeframe, [...TRADING_CANDLE_TIMEFRAMES])) ?? sql`false`;
  }

  async function expireOrphans(now: Date, result: TradingShadowTickResult): Promise<void> {
    const orphans = await db
      .select()
      .from(tradingShadowTrades)
      .where(and(eq(tradingShadowTrades.status, "open"), isNull(tradingShadowTrades.resolvedAt), sql`NOT (${realTradeFilter()})`))
      .orderBy(asc(tradingShadowTrades.signalBarCloseAt))
      .limit(ORPHAN_BATCH);
    for (const trade of orphans) {
      try {
        // A timeframe the service does not know has no bar length; the longest decision bar stands in for it.
        const barMs = isCandleTimeframe(trade.timeframe) ? tradingTimeframeMs(trade.timeframe) : tradingTimeframeMs("1d");
        if (now.getTime() - trade.signalBarCloseAt.getTime() <= GIVE_UP_AFTER_BARS * barMs) continue;
        result.voided += await voidTrade(trade.id, "Nothing can resolve this trade any more: its template version or timeframe is no longer run.", now, now);
      } catch (err) {
        logger.error({ err, tradeId: trade.id }, "trading shadow: giving up an orphaned trade failed");
      }
    }
  }

  /** Closes open trades whose exit has now happened on closed bars. */
  async function resolveOpen(now: Date, result: TradingShadowTickResult): Promise<void> {
    await expireOrphans(now, result);
    const open = await db
      .select()
      .from(tradingShadowTrades)
      .where(and(eq(tradingShadowTrades.status, "open"), isNull(tradingShadowTrades.resolvedAt), realTradeFilter()))
      // Never-checked rows first, then the longest-unchecked: a row that was just looked at and could not close yet goes to the back, so no group of stuck rows can fill the window.
      .orderBy(sql`${tradingShadowTrades.lastCheckedBarAt} ASC NULLS FIRST`, asc(tradingShadowTrades.signalBarCloseAt))
      .limit(RESOLVE_WINDOW);
    if (open.length === 0) return;
    const byStream = new Map<string, typeof open>();
    for (const trade of open) {
      const key = `${trade.asset}|${trade.timeframe}`;
      const list = byStream.get(key);
      if (list) list.push(trade);
      else byStream.set(key, [trade]);
    }
    const templates = new Map(competing().map((t) => [`${t.key}@${t.templateVersion}`, t]));
    for (const trades of byStream.values()) {
      const first = trades[0]!;
      if (!isCandleTimeframe(first.timeframe)) continue;
      const timeframe = first.timeframe;
      const tf = tradingTimeframeMs(timeframe);
      let bars: TradingCandle[];
      try {
        bars = await loadBars(first.asset as TradingAsset, timeframe, now);
      } catch (err) {
        logger.error({ err, asset: first.asset }, "trading shadow: loading bars to close trades failed");
        continue;
      }
      const lastBar = bars[bars.length - 1];
      if (!lastBar) continue;
      const lastCloseAt = new Date(lastBar.openTime.getTime() + tf);
      for (const trade of trades) {
        try {
          if (trade.lastCheckedBarAt && trade.lastCheckedBarAt.getTime() >= lastCloseAt.getTime()) continue;
          const template = templates.get(`${trade.templateKey}@${trade.templateVersion}`);
          if (!template) continue; // a template version that is gone: leave it open rather than guess
          const signalOpen = trade.signalBarCloseAt.getTime() - tf;
          const signalIndex = bars.findIndex((b) => b.openTime.getTime() === signalOpen);
          if (signalIndex < 0) {
            if (bars.length > 0 && bars[0]!.openTime.getTime() > signalOpen && lastCloseAt.getTime() - trade.signalBarCloseAt.getTime() > GIVE_UP_AFTER_BARS * tf) {
              result.voided += await voidTrade(trade.id, "The bars around the signal are no longer available.", lastCloseAt, now);
            }
            continue;
          }
          if (bars.length - signalIndex < 2) continue; // the fill bar has not closed yet
          const run = (feeMultiplier: number) =>
            simulateWindow({
              spec: template.spec,
              coin: trade.asset,
              bars,
              start: signalIndex,
              end: bars.length,
              costs: { ...BACKTEST_DEFAULT_COSTS, feeRatePct: BACKTEST_DEFAULT_COSTS.feeRatePct * feeMultiplier },
              startingCashUsd: SHADOW_START_CASH_USD,
            });
          const [at1, at2] = [run(1), run(TRADING_BACKTEST_COSTS.gateFeeMultiplier)];
          const t1 = at1.trades[0];
          const t2 = at2.trades[0];
          if (!t1 || !t2) {
            // No fill after the signal bar although the fill bar has closed: the simulator's own gates refused the entry.
            if (bars.length - signalIndex >= 3) result.voided += await voidTrade(trade.id, "The simulator did not enter at this signal.", lastCloseAt, now);
            else await markChecked(trade.id, lastCloseAt);
            continue;
          }
          const entryMs = Date.parse(t1.entryAt);
          if (entryMs < trade.signalBarCloseAt.getTime() || entryMs > trade.signalBarCloseAt.getTime() + tf) {
            result.voided += await voidTrade(trade.id, "The simulator entered on a later bar than the signal.", lastCloseAt, now);
            continue;
          }
          if (t1.exitReason === "window_end" || t2.exitReason === "window_end") {
            await markChecked(trade.id, lastCloseAt);
            continue;
          }
          const updated = await db
            .update(tradingShadowTrades)
            .set({
              status: "closed",
              entryAt: new Date(t1.entryAt),
              exitAt: new Date(t1.exitAt),
              entryPrice: t1.entryPrice,
              exitPrice: t1.exitPrice,
              exitReason: t1.exitReason,
              barsHeld: t1.bars,
              r1x: t1.r,
              r2x: t2.r,
              netReturn1x: t1.netReturn,
              netReturn2x: t2.netReturn,
              resolvedAt: now,
              lastCheckedBarAt: lastCloseAt,
              engineVersion: TRADING_SHADOW_ENGINE_VERSION,
            })
            .where(and(eq(tradingShadowTrades.id, trade.id), eq(tradingShadowTrades.status, "open")))
            .returning({ id: tradingShadowTrades.id });
          result.closed += updated.length;
        } catch (err) {
          logger.error({ err, tradeId: trade.id }, "trading shadow: closing a trade failed");
        }
      }
    }
  }

  async function markChecked(id: string, at: Date): Promise<void> {
    await db
      .update(tradingShadowTrades)
      .set({ lastCheckedBarAt: at })
      .where(and(eq(tradingShadowTrades.id, id), eq(tradingShadowTrades.status, "open")));
  }

  async function voidTrade(id: string, reason: string, checkedAt: Date, now: Date): Promise<number> {
    const updated = await db
      .update(tradingShadowTrades)
      .set({ status: "void", voidReason: reason, resolvedAt: now, lastCheckedBarAt: checkedAt, engineVersion: TRADING_SHADOW_ENGINE_VERSION })
      .where(and(eq(tradingShadowTrades.id, id), eq(tradingShadowTrades.status, "open")))
      .returning({ id: tradingShadowTrades.id });
    return updated.length;
  }

  async function tick(now: Date = nowOf()): Promise<TradingShadowTickResult> {
    const result: TradingShadowTickResult = { companies: 0, cellsRegistered: 0, signals: 0, opened: 0, closed: 0, voided: 0 };
    await evaluate(now, result);
    await resolveOpen(now, result);
    return result;
  }

  return { tick, evaluate, resolveOpen };
}

export type TradingShadowService = ReturnType<typeof tradingShadowService>;
