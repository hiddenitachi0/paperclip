import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  tradingBacktestRuns,
  tradingEvaluatorState,
  tradingLedgerEntries,
  tradingOrders,
  tradingPredictionVerdicts,
  tradingPredictions,
  tradingStrategies,
  tradingStrategyVersions,
  type Db,
} from "@paperclipai/db";
import {
  TRADING_BASELINE_KEYS,
  TRADING_RESOLVER_VERSION,
  atrSeries,
  baselineCall,
  blockBootstrapInterval,
  ccxtSymbolFor,
  computeTradingEntryLevels,
  computeTradingRegime,
  computeTradingVerdict,
  coverage,
  dropFormingCandles,
  effectiveSampleSize,
  evaluateForwardCriteria,
  evaluateTradingSpec,
  expectedHitRateFromBaseRate,
  isIndependentCall,
  probabilityScores,
  realizedUpShare,
  resolveTradingPrediction,
  returnVsBuyAndHold,
  riskAdjustedReturns,
  runningTimeMs,
  scoreByRegime,
  summarizeHitRate,
  tradeMetrics,
  tradingCandleMarket,
  tradingStrategySpecSchema,
  tradingTimeframeMs,
  trailingBaseRateUp,
  verdictPlanOf,
  verdictStatus,
  type GapInterval,
  type RoundTrip,
  type ScoredPrediction,
  type TradingAsset,
  type TradingCandle,
  type TradingStrategySpec,
  type TradingTimeframe,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { ccxtTradingMarketData, isTradingMarketDataError, type TradingMarketDataSource } from "./trading-market-data.js";
import { tradingLedgerService } from "./trading-ledger.js";
import { listCandles } from "./trading-candle-store.js";

/**
 * DUR-5010: the prediction evaluator and resolver.
 *
 * A separate scheduler chain from the paper order path. It runs every live
 * strategy's rules and the three baselines (always up, persistence, coin flip)
 * on each newly closed bar, writes the calls to the append-only
 * trading_predictions table BEFORE the outcome is known, and later resolves
 * them from closed candles. It places no orders, files no cards, and never
 * reads or writes a position: the only strategy table it touches is read-only.
 *
 * Restarts. The order path pauses on restart (reconcileOnBoot, DUR-4171); this
 * chain starts by itself. `boot()` reads the last heartbeat, writes an
 * `evaluator_gap` ledger entry per strategy covering the time since, and
 * remembers the boot time: a bar that closed before it is never predicted
 * (the outcome would already be partly known). Running time of a test is its
 * calendar time minus those gaps.
 *
 * What a fixed rule "calls". The rule is run on the newest closed bar twice,
 * independent of any real position: as if flat (an entry is an "up" call) and
 * as if long with only the rule exits armed (an exit-rule is a "down" call).
 * Stops, targets and trailing are trade management and are scored in the trade
 * metrics, not as forecasts. If both fire on the same bar the rule has no call.
 * Fixed rules carry no probability.
 */

const BAR_FETCH_LIMIT = 720;
const RULE_KEY = "rule";
const RESOLVE_BATCH = 1000;
const ATR_PERIOD = 14;

type StrategyRow = typeof tradingStrategies.$inferSelect;
type VersionRow = typeof tradingStrategyVersions.$inferSelect;

export interface TradingEvaluatorDeps {
  marketData?: TradingMarketDataSource;
  now?: () => Date;
}

export interface TradingEvaluatorTickResult {
  strategies: number;
  predictionsWritten: number;
  resolved: number;
  verdictsWritten: number;
  skipped: number;
}

interface LiveStrategy {
  strategy: StrategyRow;
  version: VersionRow;
  spec: TradingStrategySpec;
}

function metaOf(p: typeof tradingPredictions.$inferSelect): { baseRateUp: number | null; reasonCodes: string[] } {
  const snap = (p.indicatorSnapshot ?? {}) as { baseRateUp?: number | null; reasonCodes?: string[] };
  return { baseRateUp: typeof snap.baseRateUp === "number" ? snap.baseRateUp : null, reasonCodes: snap.reasonCodes ?? [] };
}

function toScored(p: typeof tradingPredictions.$inferSelect): ScoredPrediction {
  const regime = (p.regime ?? null) as { trend?: string | null } | null;
  return {
    forecasterKey: p.forecasterKey,
    asset: p.asset,
    barCloseAt: p.barCloseAt,
    resolvesAt: p.resolvesAt,
    direction: p.direction as ScoredPrediction["direction"],
    probability: p.probability,
    outcome: (p.outcome ?? null) as ScoredPrediction["outcome"],
    realizedReturn: p.realizedReturn,
    independent: p.independent,
    baseRateUp: metaOf(p).baseRateUp,
    regime: regime?.trend ?? null,
  };
}

export function tradingEvaluatorService(db: Db, deps: TradingEvaluatorDeps = {}) {
  const marketData = deps.marketData ?? ccxtTradingMarketData();
  const nowOf = () => deps.now?.() ?? new Date();
  const ledger = tradingLedgerService(db);
  /** Set by boot(); the earliest closing time a bar may have to be predicted by this process. */
  let bootedAt: Date | null = null;

  // ─── Live strategies ──────────────────────────────────────────────────

  async function liveStrategies(): Promise<LiveStrategy[]> {
    const rows = await db
      .select({ strategy: tradingStrategies, version: tradingStrategyVersions })
      .from(tradingStrategies)
      .innerJoin(tradingStrategyVersions, eq(tradingStrategies.activeVersionId, tradingStrategyVersions.id));
    const out: LiveStrategy[] = [];
    for (const row of rows) {
      if (row.version.status !== "approved") continue;
      const parsed = tradingStrategySpecSchema.safeParse(row.version.spec);
      if (!parsed.success) {
        logger.warn({ strategyId: row.strategy.id, versionId: row.version.id }, "trading evaluator: stored rules no longer validate, skipping");
        continue;
      }
      out.push({ strategy: row.strategy, version: row.version, spec: parsed.data });
    }
    return out;
  }

  // ─── Boot and heartbeat ───────────────────────────────────────────────

  /**
   * Called once at process start. Writes one gap event per live strategy for
   * the time since the last heartbeat (none on the very first start) and
   * records this boot. Never throws into the caller's boot path beyond a DB
   * failure, which the caller logs.
   */
  async function boot(now: Date = nowOf()): Promise<{ gapMs: number; gapFrom: Date | null; strategies: number }> {
    const [state] = await db.select().from(tradingEvaluatorState).where(eq(tradingEvaluatorState.id, "evaluator"));
    const gapFrom = state?.lastHeartbeatAt ?? null;
    const gapMs = gapFrom ? Math.max(0, now.getTime() - gapFrom.getTime()) : 0;
    const strategies = await liveStrategies();
    if (gapFrom && gapMs > 0) {
      for (const live of strategies) {
        await ledger.writeLedgerEntry({
          companyId: live.strategy.companyId,
          strategyId: live.strategy.id,
          strategyVersionId: live.version.id,
          eventType: "evaluator_gap",
          detail: { from: gapFrom.toISOString(), to: now.toISOString(), seconds: Math.round(gapMs / 1000), note: "The prediction evaluator was not running. Bars that closed in this time get no predictions and count as a gap." },
        });
      }
    }
    await db
      .insert(tradingEvaluatorState)
      .values({ id: "evaluator", lastHeartbeatAt: now, bootAt: now })
      .onConflictDoUpdate({ target: tradingEvaluatorState.id, set: { lastHeartbeatAt: now, bootAt: now, updatedAt: now } });
    bootedAt = now;
    return { gapMs, gapFrom, strategies: strategies.length };
  }

  async function heartbeat(now: Date) {
    await db.update(tradingEvaluatorState).set({ lastHeartbeatAt: now, updatedAt: now }).where(eq(tradingEvaluatorState.id, "evaluator"));
  }

  async function bootTime(): Promise<Date> {
    if (bootedAt) return bootedAt;
    // A tick before boot() (a test, or the boot hook failed): fall back to the stored boot, or "now".
    const [state] = await db.select().from(tradingEvaluatorState).where(eq(tradingEvaluatorState.id, "evaluator"));
    bootedAt = state?.bootAt ?? nowOf();
    return bootedAt;
  }

  // ─── Candles ──────────────────────────────────────────────────────────

  type ClosedBars = { bars: TradingCandle[]; lastCloseAt: Date } | { error: string };
  const barCache = new Map<string, ClosedBars>();

  async function closedBars(asset: TradingAsset, timeframe: TradingTimeframe, now: Date): Promise<ClosedBars> {
    const key = `${asset}|${timeframe}|${now.getTime()}`;
    const cached = barCache.get(key);
    if (cached) return cached;
    if (barCache.size > 64) barCache.clear();
    const raw = await marketData.fetchCandles(asset, timeframe, BAR_FETCH_LIMIT, now);
    let result: ClosedBars;
    if (isTradingMarketDataError(raw)) {
      result = { error: raw.message };
    } else {
      // Not prepareClosedCandles: its freshness limit is for trading. A late bar here only delays a prediction.
      const bars = dropFormingCandles(raw.candles, timeframe, now);
      const last = bars[bars.length - 1];
      result = last ? { bars, lastCloseAt: new Date(last.openTime.getTime() + tradingTimeframeMs(timeframe)) } : { error: `No closed ${timeframe} candle for ${ccxtSymbolFor(asset)}.` };
    }
    barCache.set(key, result);
    return result;
  }

  // ─── Evaluating ───────────────────────────────────────────────────────

  function atrAt(bars: readonly TradingCandle[]): number | null {
    const series = atrSeries(bars, ATR_PERIOD);
    const last = series[series.length - 1];
    return last ?? null;
  }

  async function evaluateStrategy(live: LiveStrategy, now: Date): Promise<number> {
    const { strategy, version, spec } = live;
    const timeframe = spec.universe.decisionTimeframe as TradingTimeframe;
    const asset = strategy.asset as TradingAsset;
    const tf = tradingTimeframeMs(timeframe);
    const expectedClose = new Date(Math.floor(now.getTime() / tf) * tf);
    const boot = await bootTime();
    // A bar that closed before this process started is never predicted.
    if (expectedClose.getTime() <= boot.getTime()) return 0;
    const [done] = await db
      .select({ id: tradingPredictions.id })
      .from(tradingPredictions)
      .where(
        and(
          eq(tradingPredictions.forecasterKey, TRADING_BASELINE_KEYS[0]),
          eq(tradingPredictions.strategyId, strategy.id),
          eq(tradingPredictions.specVersion, version.version),
          eq(tradingPredictions.asset, asset),
          eq(tradingPredictions.barCloseAt, expectedClose),
        ),
      )
      .limit(1);
    if (done) return 0;

    const loaded = await closedBars(asset, timeframe, now);
    if ("error" in loaded) {
      logger.warn({ strategyId: strategy.id, error: loaded.error }, "trading evaluator: no candles this tick");
      return 0;
    }
    if (loaded.lastCloseAt.getTime() < expectedClose.getTime()) return 0; // the exchange has not published the bar yet; the next tick tries again
    const bars = loaded.bars;
    const lastIndex = bars.length - 1;
    const last = bars[lastIndex]!;
    const barCloseAt = loaded.lastCloseAt;
    if (barCloseAt.getTime() <= boot.getTime()) return 0;
    const previous = bars[lastIndex - 1] ?? null;

    const horizon = spec.prediction.horizonBars;
    const resolvesAt = new Date(barCloseAt.getTime() + horizon * tf);
    const flatBandPct = spec.prediction.flatBandPct;
    const base = trailingBaseRateUp(bars.slice(0, lastIndex + 1), timeframe, horizon, flatBandPct, barCloseAt);
    const regime = computeTradingRegime(bars);
    const common = {
      companyId: strategy.companyId,
      strategyId: strategy.id,
      specVersion: version.version,
      asset,
      timeframe,
      barCloseAt,
      dataCutoffAt: barCloseAt,
      horizonBars: horizon,
      resolvesAt,
      referencePrice: last.close,
      flatBandPct,
    };

    const rows: Array<typeof tradingPredictions.$inferInsert> = [];

    // The rule's call.
    const flatProbe = evaluateTradingSpec(spec, bars, { kind: "flat" });
    const longProbe = evaluateTradingSpec(spec, bars, { kind: "long", entryPrice: last.close, entryAt: barCloseAt, stopPrice: null, targetPrice: null, highestPrice: last.close });
    const wantsUp = flatProbe.action === "enter";
    const wantsDown = longProbe.action === "exit" && longProbe.reasonCodes.includes("exit_rule");
    if (wantsUp !== wantsDown) {
      const direction = wantsUp ? "up" : "down";
      const levels = computeTradingEntryLevels(spec, bars, lastIndex);
      const atr = atrAt(bars);
      const rDistance = (spec.prediction.rUnit === "stop_distance" ? levels.stopDistance : atr) ?? atr;
      const needsLevels = spec.prediction.kind === "target_before_stop";
      if (!needsLevels || (direction === "up" && levels.stopPrice !== null && levels.targetPrice !== null)) {
        const decision = wantsUp ? flatProbe : longProbe;
        rows.push({
          ...common,
          forecasterKind: "rule",
          forecasterKey: RULE_KEY,
          kind: spec.prediction.kind,
          direction,
          targetPrice: needsLevels ? levels.targetPrice : null,
          stopPrice: needsLevels ? levels.stopPrice : null,
          rDistance: rDistance !== null && rDistance > 0 ? rDistance : null,
          regime: { trend: regime.trend, volatility: regime.volatility, squeeze: regime.squeeze },
          indicatorSnapshot: { indicators: decision.indicatorSnapshot, baseRateUp: base.baseRateUp, baseRateSamples: base.up + base.down, reasonCodes: decision.reasonCodes },
        });
      }
    }

    // The baselines call every bar. Always written, so they also mark the bar as evaluated.
    for (const key of TRADING_BASELINE_KEYS) {
      rows.push({
        ...common,
        forecasterKind: "baseline",
        forecasterKey: key,
        kind: "direction",
        direction: baselineCall(key, { asset, barCloseAt, lastClose: last.close, previousClose: previous?.close ?? null }),
        rDistance: null,
        regime: { trend: regime.trend, volatility: regime.volatility, squeeze: regime.squeeze },
        indicatorSnapshot: { baseRateUp: base.baseRateUp, baseRateSamples: base.up + base.down },
      });
    }

    const inserted = await db.insert(tradingPredictions).values(rows).onConflictDoNothing().returning({ id: tradingPredictions.id });
    return inserted.length;
  }

  // ─── Resolving ────────────────────────────────────────────────────────

  async function barsForResolution(asset: TradingAsset, timeframe: TradingTimeframe, earliest: Date, now: Date): Promise<TradingCandle[]> {
    const merged = new Map<number, TradingCandle>();
    const live = await closedBars(asset, timeframe, now);
    if (!("error" in live)) for (const bar of live.bars) merged.set(bar.openTime.getTime(), bar);
    const first = "error" in live ? null : live.bars[0]?.openTime ?? null;
    if (first === null || earliest.getTime() < first.getTime()) {
      // Older than the live window (a long outage): the candle store holds closed bars for the same exchange.
      try {
        const stored = await listCandles(db, { source: "kraken", market: tradingCandleMarket("kraken", asset), timeframe: timeframe as never, from: earliest, to: now, limit: 5000 });
        for (const bar of stored) if (!merged.has(bar.openTime.getTime())) merged.set(bar.openTime.getTime(), { ...bar });
      } catch (err) {
        logger.warn({ err }, "trading evaluator: candle store lookup failed");
      }
    }
    return [...merged.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }

  async function resolveDue(now: Date): Promise<number> {
    const due = await db
      .select()
      .from(tradingPredictions)
      .where(and(isNull(tradingPredictions.resolvedAt), lte(tradingPredictions.resolvesAt, now)))
      .orderBy(asc(tradingPredictions.barCloseAt))
      .limit(RESOLVE_BATCH);
    if (due.length === 0) return 0;
    const groups = new Map<string, typeof due>();
    for (const p of due) {
      const key = `${p.asset}|${p.timeframe}`;
      const list = groups.get(key);
      if (list) list.push(p);
      else groups.set(key, [p]);
    }
    const previousIndependent = new Map<string, Date | null>();
    let resolved = 0;
    for (const list of groups.values()) {
      const first = list[0]!;
      const bars = await barsForResolution(first.asset as TradingAsset, first.timeframe as TradingTimeframe, first.barCloseAt, now);
      for (const p of list) {
        const result = resolveTradingPrediction(
          {
            direction: p.direction as "up" | "down" | "flat",
            kind: p.kind as "direction" | "target_before_stop",
            referencePrice: p.referencePrice,
            flatBandPct: p.flatBandPct,
            barCloseAt: p.barCloseAt,
            resolvesAt: p.resolvesAt,
            targetPrice: p.targetPrice,
            stopPrice: p.stopPrice,
          },
          bars,
          p.timeframe as TradingTimeframe,
        );
        if (result.status === "pending") continue;
        const seriesKey = `${p.strategyId}|${p.specVersion}|${p.forecasterKey}|${p.asset}`;
        if (!previousIndependent.has(seriesKey)) {
          const [row] = await db
            .select({ latest: sql<Date | null>`max(${tradingPredictions.resolvesAt})` })
            .from(tradingPredictions)
            .where(
              and(
                eq(tradingPredictions.strategyId, p.strategyId),
                eq(tradingPredictions.specVersion, p.specVersion),
                eq(tradingPredictions.forecasterKey, p.forecasterKey),
                eq(tradingPredictions.asset, p.asset),
                eq(tradingPredictions.independent, true),
              ),
            );
          previousIndependent.set(seriesKey, row?.latest ? new Date(row.latest) : null);
        }
        const independent = result.outcome !== "void" && isIndependentCall(p.barCloseAt, previousIndependent.get(seriesKey) ?? null);
        const updated = await db
          .update(tradingPredictions)
          .set({ resolvedAt: now, outcome: result.outcome, realizedReturn: result.realizedReturn, mfe: result.mfe, mae: result.mae, resolverVersion: TRADING_RESOLVER_VERSION, independent })
          .where(and(eq(tradingPredictions.id, p.id), isNull(tradingPredictions.resolvedAt)))
          .returning({ id: tradingPredictions.id });
        if (updated.length > 0) {
          resolved++;
          if (independent) previousIndependent.set(seriesKey, p.resolvesAt);
        }
      }
    }
    return resolved;
  }

  // ─── Running time ─────────────────────────────────────────────────────

  async function gapsFor(strategyId: string): Promise<GapInterval[]> {
    const entries = await db
      .select({ detail: tradingLedgerEntries.detail })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.strategyId, strategyId), eq(tradingLedgerEntries.eventType, "evaluator_gap")));
    const gaps: GapInterval[] = [];
    for (const entry of entries) {
      const d = entry.detail as { from?: string; to?: string } | null;
      if (d?.from && d?.to) gaps.push({ from: new Date(d.from), to: new Date(d.to) });
    }
    return gaps;
  }

  // ─── The verdict, computed once ───────────────────────────────────────

  async function seriesRows(strategyId: string, specVersion: number) {
    return db
      .select()
      .from(tradingPredictions)
      .where(and(eq(tradingPredictions.strategyId, strategyId), eq(tradingPredictions.specVersion, specVersion)))
      .orderBy(asc(tradingPredictions.barCloseAt));
  }

  /** Hit rate of each baseline over exactly the bars where the rule made a call. */
  function baselinesOnSameBars(rows: readonly (typeof tradingPredictions.$inferSelect)[], callTimes: ReadonlySet<number>): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const key of TRADING_BASELINE_KEYS) {
      const subset = rows.filter((r) => r.forecasterKey === key && callTimes.has(r.barCloseAt.getTime())).map(toScored);
      out[key] = summarizeHitRate(subset).hitRate;
    }
    return out;
  }

  async function computeVerdicts(now: Date): Promise<number> {
    let written = 0;
    for (const live of await liveStrategies()) {
      const { strategy, version, spec } = live;
      const plan = verdictPlanOf(spec.prediction);
      const [existing] = await db
        .select({ id: tradingPredictionVerdicts.id })
        .from(tradingPredictionVerdicts)
        .where(and(eq(tradingPredictionVerdicts.strategyId, strategy.id), eq(tradingPredictionVerdicts.specVersion, version.version), eq(tradingPredictionVerdicts.forecasterKey, RULE_KEY)));
      if (existing) continue;
      const [counted] = await db
        .select({ n: sql<number>`count(*)::int`, first: sql<Date | null>`min(${tradingPredictions.barCloseAt})` })
        .from(tradingPredictions)
        .where(
          and(
            eq(tradingPredictions.strategyId, strategy.id),
            eq(tradingPredictions.specVersion, version.version),
            eq(tradingPredictions.forecasterKey, RULE_KEY),
            eq(tradingPredictions.independent, true),
          ),
        );
      if (!counted || counted.n < plan.targetSamples || !counted.first) continue; // cheap exit: collecting
      const rows = await seriesRows(strategy.id, version.version);
      const rule = rows.filter((r) => r.forecasterKey === RULE_KEY).map(toScored);
      const independentCalls = rule.filter((r) => r.independent && r.outcome !== null && r.outcome !== "void");
      const time = runningTimeMs(new Date(counted.first), now, await gapsFor(strategy.id));
      const status = verdictStatus({ independentResolved: independentCalls.length, runningMs: time.runningMs, calendarMs: time.calendarMs, plan });
      if (status.status !== "ready") continue;
      const callTimes = new Set(independentCalls.map((c) => c.barCloseAt.getTime()));
      const verdict = computeTradingVerdict({ independentCalls, baselinesOnSameBars: baselinesOnSameBars(rows, callTimes), horizonBars: spec.prediction.horizonBars });
      try {
        const inserted = await db
          .insert(tradingPredictionVerdicts)
          .values({
            companyId: strategy.companyId,
            strategyId: strategy.id,
            specVersion: version.version,
            forecasterKey: RULE_KEY,
            targetSamples: plan.targetSamples,
            minRunningDays: plan.minRunningDays,
            samplesCounted: independentCalls.length,
            runningMs: time.runningMs,
            calendarMs: time.calendarMs,
            computedAt: now,
            verdict: { ...verdict, plan, independentCalls: independentCalls.length, effectiveSampleSize: effectiveSampleSize(independentCalls), gapMs: time.gapMs, resolverVersion: TRADING_RESOLVER_VERSION },
          })
          .onConflictDoNothing()
          .returning({ id: tradingPredictionVerdicts.id });
        written += inserted.length;
      } catch (err) {
        // The database refuses a verdict before N and the minimum period; its clock is the final word.
        logger.info({ err, strategyId: strategy.id }, "trading evaluator: verdict not yet allowed by the database");
      }
    }
    return written;
  }

  // ─── The tick ─────────────────────────────────────────────────────────

  async function tick(now: Date = nowOf()): Promise<TradingEvaluatorTickResult> {
    await heartbeat(now);
    const strategies = await liveStrategies();
    const result: TradingEvaluatorTickResult = { strategies: strategies.length, predictionsWritten: 0, resolved: 0, verdictsWritten: 0, skipped: 0 };
    for (const live of strategies) {
      try {
        result.predictionsWritten += await evaluateStrategy(live, now);
      } catch (err) {
        result.skipped++;
        logger.error({ err, strategyId: live.strategy.id }, "trading evaluator: evaluating a strategy failed");
      }
    }
    try {
      result.resolved = await resolveDue(now);
    } catch (err) {
      logger.error({ err }, "trading evaluator: resolving failed");
    }
    try {
      result.verdictsWritten = await computeVerdicts(now);
    } catch (err) {
      logger.error({ err }, "trading evaluator: verdict step failed");
    }
    await heartbeat(now);
    return result;
  }

  // ─── The scoreboard (read side) ───────────────────────────────────────

  async function roundTrips(strategyId: string): Promise<RoundTrip[]> {
    const orders = await db
      .select()
      .from(tradingOrders)
      .where(and(eq(tradingOrders.strategyId, strategyId), eq(tradingOrders.status, "filled")))
      .orderBy(asc(tradingOrders.createdAt));
    const trips: RoundTrip[] = [];
    let qty = 0;
    let cost = 0;
    let fees = 0;
    let openedAt: Date | null = null;
    let proceeds = 0;
    let sold = 0;
    const usd = (nok: number | null, rate: number | null) => (nok ?? 0) / (rate ?? 11.5);
    for (const o of orders) {
      const q = o.filledQuantity ?? 0;
      const priceUsd = usd(o.filledPriceNok, o.fxRate);
      const feeUsd = usd(o.feeNok, o.fxRate);
      if (q <= 0) continue;
      if (o.side === "buy") {
        if (qty <= 1e-12) {
          openedAt = o.createdAt;
          cost = 0;
          qty = 0;
          fees = 0;
          proceeds = 0;
          sold = 0;
        }
        qty += q;
        cost += q * priceUsd;
        fees += feeUsd;
      } else if (qty > 1e-12 && openedAt) {
        const take = Math.min(q, qty);
        const avgEntry = cost / qty;
        proceeds += take * priceUsd;
        sold += take;
        cost -= take * avgEntry;
        qty -= take;
        fees += feeUsd;
        if (qty <= 1e-12) {
          trips.push({ openedAt, closedAt: o.createdAt, entryPrice: avgEntry, exitPrice: proceeds / sold, quantity: sold, feesUsd: fees, rDistance: null });
          openedAt = null;
        }
      }
    }
    return trips;
  }

  async function scoreboard(companyId: string, strategyId: string, requestedVersion?: number) {
    const [strategy] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!strategy) throw notFound("Trading strategy not found.");
    let versionRow: VersionRow | undefined;
    if (requestedVersion !== undefined) {
      [versionRow] = await db.select().from(tradingStrategyVersions).where(and(eq(tradingStrategyVersions.strategyId, strategyId), eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.version, requestedVersion)));
    } else if (strategy.activeVersionId) {
      [versionRow] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, strategy.activeVersionId));
    }
    if (!versionRow) return { strategyId, version: null, status: { status: "collecting" as const, samples: 0, targetSamples: verdictPlanOf(undefined).targetSamples, runningMs: 0, minRunningMs: 0, calendarMs: 0 }, forecasters: [], verdict: null };
    const parsed = tradingStrategySpecSchema.safeParse(versionRow.spec);
    const spec = parsed.success ? parsed.data : null;
    const plan = verdictPlanOf(spec?.prediction);
    const now = nowOf();
    const rows = await seriesRows(strategyId, versionRow.version);
    const [verdictRow] = await db
      .select()
      .from(tradingPredictionVerdicts)
      .where(and(eq(tradingPredictionVerdicts.strategyId, strategyId), eq(tradingPredictionVerdicts.specVersion, versionRow.version), eq(tradingPredictionVerdicts.forecasterKey, RULE_KEY)));

    const ruleScored = rows.filter((r) => r.forecasterKey === RULE_KEY).map(toScored);
    const independentResolved = ruleScored.filter((r) => r.independent && r.outcome !== null && r.outcome !== "void");
    const firstCall = rows[0]?.barCloseAt ?? null;
    const time = firstCall ? runningTimeMs(firstCall, now, await gapsFor(strategyId)) : { runningMs: 0, calendarMs: 0, gapMs: 0 };
    const status = verdictStatus({ independentResolved: independentResolved.length, runningMs: time.runningMs, calendarMs: time.calendarMs, plan });
    const horizon = spec?.prediction.horizonBars ?? rows[0]?.horizonBars ?? 1;
    const flatBandPct = spec?.prediction.flatBandPct ?? rows[0]?.flatBandPct ?? 0;
    const tf = spec ? tradingTimeframeMs(spec.universe.decisionTimeframe as TradingTimeframe) : 4 * 3_600_000;
    const barsRunning = time.runningMs / tf;

    const keys = [...new Set(rows.map((r) => r.forecasterKey))].sort();
    const callTimes = new Set(ruleScored.map((c) => c.barCloseAt.getTime()));
    const forecasters = keys.map((key) => {
      const scored = rows.filter((r) => r.forecasterKey === key).map(toScored);
      const summary = summarizeHitRate(scored);
      // No running verdict while collecting: the interval and the headline hit rate are shown only once the status is ready.
      const shown = status.status === "ready";
      const interval = shown ? blockBootstrapInterval(scored.filter((s) => s.outcome === "hit" || s.outcome === "miss"), (s) => summarizeHitRate(s).hitRate, { horizonBars: horizon, iterations: 500 }) : null;
      const sameBars = scored.filter((s) => callTimes.has(s.barCloseAt.getTime()));
      return {
        forecasterKey: key,
        calls: scored.length,
        resolved: summary.resolved,
        pending: summary.pending,
        flats: summary.flats,
        voids: summary.voids,
        independentResolved: scored.filter((s) => s.independent && s.outcome !== null && s.outcome !== "void").length,
        effectiveSampleSize: effectiveSampleSize(scored),
        coverage: coverage(scored.length, barsRunning),
        hitRate: shown ? summary.hitRate : null,
        hitRateInterval: interval ? { lower: interval.lower, upper: interval.upper, blocks: interval.blocks, blockLength: interval.blockLength } : null,
        hitRateOnRuleBars: shown && key !== RULE_KEY ? summarizeHitRate(sameBars).hitRate : null,
        expectedHitRateFromBaseRate: shown ? expectedHitRateFromBaseRate(scored) : null,
        realizedUpShare: shown ? realizedUpShare(scored, flatBandPct) : null,
        probability: shown ? probabilityScores(scored, flatBandPct) : null,
        byRegime: shown ? scoreByRegime(scored) : null,
      };
    });

    const trips = await roundTrips(strategyId);
    const startingEquityUsd = strategy.startingCashUsd ?? strategy.startingCashNok / 11.5;
    const trades = tradeMetrics(trips, startingEquityUsd);
    const daily = new Map<string, number>();
    for (const t of trips) {
      const day = t.closedAt.toISOString().slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + ((t.exitPrice - t.entryPrice) * t.quantity - t.feesUsd) / startingEquityUsd);
    }
    // The written pass/fail criteria (DUR-5011), read from the shared constant. Nothing beyond the
    // two counters is judged while the version is still collecting.
    const ruleForecaster = forecasters.find((f) => f.forecasterKey === RULE_KEY);
    const ready = status.status === "ready";
    const probability = ready ? probabilityScores(ruleScored, flatBandPct) : null;
    let pastDataExpectancyR: number | null = null;
    if (ready) {
      const [gateRun] = await db
        .select({ report: tradingBacktestRuns.report })
        .from(tradingBacktestRuns)
        .where(and(eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.versionId, versionRow.id), eq(tradingBacktestRuns.purpose, "gate"), eq(tradingBacktestRuns.status, "succeeded")))
        .orderBy(desc(tradingBacktestRuns.finishedAt))
        .limit(1);
      const headline = (gateRun?.report as { headline?: { outOfSample?: { fees2x?: { expectancyR?: unknown } } } } | null | undefined)?.headline;
      const value = headline?.outOfSample?.fees2x?.expectancyR;
      pastDataExpectancyR = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    const drawdownCap = (strategy.riskConfig as { maxDrawdownPct?: unknown } | null)?.maxDrawdownPct;
    const criteria = evaluateForwardCriteria({
      samples: ruleForecaster?.independentResolved ?? 0,
      targetSamples: plan.targetSamples,
      runningDays: time.runningMs / 86_400_000,
      minRunningDays: plan.minRunningDays,
      brierSkill: probability?.brierSkill ?? null,
      hasRealProbabilities: probability !== null,
      forwardExpectancyR: trades.expectancyR,
      pastDataExpectancyR,
      forwardDrawdownPct: trades.maxDrawdownPct,
      drawdownCapPct: typeof drawdownCap === "number" ? drawdownCap : null,
    });
    return {
      strategyId,
      version: versionRow.version,
      plan,
      status,
      criteria,
      time: { runningMs: time.runningMs, calendarMs: time.calendarMs, gapMs: time.gapMs },
      forecasters,
      trades: status.status === "ready" || trips.length > 0 ? { ...trades, ...riskAdjustedReturns([...daily.values()]), vsBuyAndHold: rows.length > 0 ? returnVsBuyAndHold(trades.netPnlUsd / startingEquityUsd, rows[0]!.referencePrice, rows[rows.length - 1]!.referencePrice) : null } : null,
      verdict: verdictRow ? { computedAt: verdictRow.computedAt, samplesCounted: verdictRow.samplesCounted, ...(verdictRow.verdict as Record<string, unknown>) } : null,
    };
  }

  return { boot, tick, scoreboard, resolveDue, computeVerdicts };
}

export type TradingEvaluatorService = ReturnType<typeof tradingEvaluatorService>;
