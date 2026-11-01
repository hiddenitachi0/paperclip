import { createHash } from "node:crypto";
import {
  TRADING_BACKTEST_COSTS,
  TRADING_BACKTEST_LIMITS,
  TRADING_BACKTEST_REGIMES,
  TRADING_ESTIMATED_USD_NOK_RATE,
  TRADING_HINDSIGHT_FLAG,
  TRADING_START_GATE,
  canonicalTradingJson,
  deflatedSharpe,
  deriveTradingRiskConfig,
  equityReturns,
  evaluateBacktestGate,
  isHeadlineCoin,
  kurtosis,
  periodicSharpe,
  planHoldout,
  sampleStd,
  seedFromText,
  skewness,
  summarizeBacktest,
  tradingSpecRequiredBars,
  tradingStrategySpecSchema,
  tradingTimeframeMs,
  walkForwardWindows,
  type BacktestGateResult,
  type BacktestMetrics,
  type BacktestTrade,
  type HoldoutPlan,
  type HoldoutRead,
  type TradingBacktestPurpose,
  type TradingBacktestRegime,
  type TradingCandleSource,
  type TradingEngineBar,
  type TradingStrategySpec,
  type WalkForwardWindow,
} from "@paperclipai/shared";
import {
  backtestWarmupBars,
  buyAndHoldReturn,
  randomEntryReplay,
  regimeLabels,
  simulateWindow,
  specDecider,
  type BacktestDecider,
  type JoinedInputs,
  type SignalEvent,
  type SimulationCosts,
  type SimulationResult,
} from "./trading-backtest-engine.js";

/**
 * DUR-5008: the walk-forward past-data test. Pure orchestration on top of the
 * simulation core: it takes the candles through a loader and returns the
 * report, the gate verdict and the trial/holdout bookkeeping; it writes
 * nothing and never reads the clock (the as-of time is part of the run's
 * parameters), so the same run twice gives the same bytes.
 *
 * What is reported (plan section 5):
 *   - per coin and per window, at 1x and 2x fees: hit rate (Wilson), expectancy
 *     in R, profit factor, average win and loss, max drawdown, Sharpe and
 *     Sortino (365), fees as % of gross profit, exposure; and the same per
 *     market state (bull, bear, range);
 *   - baselines: buy-and-hold, cash, random entry with the same exposure;
 *   - regime coverage per coin from its actual out-of-sample windows;
 *   - the look-ahead check, the point-in-time audit, the trial registry
 *     numbers (variants tried, Deflated Sharpe ratio, plateau check) and the
 *     holdout label.
 * Only BTC and ETH headline the gate; any other coin is flagged "coin chosen
 * with hindsight".
 */

export class BacktestRefusal extends Error {}
export class BacktestOutOfTime extends Error {}

export interface BacktestRunParams {
  schema: 1;
  /** The data horizon, pinned when the run was queued: candles that closed after it do not exist for this run. */
  asOf: string;
  source: TradingCandleSource;
  purpose: TradingBacktestPurpose;
  assets: string[];
  /** feeRatePct is the 1x fee; the gate run is at twice that. */
  costs: SimulationCosts;
  startingCashNok: number;
  /** 'base': the version's own numbers are tested on every window (what the gate needs). 'best_in_sample': each window first picks the best variant on its 24-month tune stretch (exploration). */
  selection: "base" | "best_in_sample";
  maxVariants: number;
  seed: number;
}

export interface TrialRecord {
  variantDigest: string;
  variantLabel: string;
  oosSharpe: number | null;
  oosObservations: number;
}

export interface BacktestInputs {
  spec: TradingStrategySpec;
  params: BacktestRunParams;
  /** Every stored closed bar of the coin at that timeframe up to `asOf` (the loader may return more; the run ignores anything later). */
  loadBars(coin: string, timeframe: "5m" | "1h" | "4h" | "1d"): Promise<TradingEngineBar[]>;
  priorReads: readonly HoldoutRead[];
  priorTrials: ReadonlyArray<{ variantDigest: string; oosSharpe: number | null }>;
  /** Tests plug a different decision function in here (a deliberately leaky one); production uses the spec engine. */
  makeDecider?: (spec: TradingStrategySpec) => BacktestDecider;
  joined?: JoinedInputs;
  /** Throws when the run's time is up. */
  checkpoint?: () => void;
}

export interface BacktestOutcome {
  report: Record<string, unknown>;
  gate: BacktestGateResult;
  resultDigest: string;
  trials: TrialRecord[];
  holdoutRead: { start: string; end: string; seenCount: number } | null;
  variantsTried: number;
}

// ─── Variants ────────────────────────────────────────────────────────────────

export interface BacktestVariant {
  index: number;
  label: string;
  digest: string;
  spec: TradingStrategySpec;
}

export function specVariantDigest(spec: TradingStrategySpec): string {
  return createHash("sha256").update(canonicalTradingJson(spec)).digest("hex");
}

/** The base spec plus its neighbours: every indicator length nudged down and up by a quarter. */
export function buildVariants(base: TradingStrategySpec, maxVariants: number): BacktestVariant[] {
  const cap = Math.max(1, Math.min(maxVariants, TRADING_BACKTEST_LIMITS.maxVariants));
  const variants: BacktestVariant[] = [{ index: 0, label: "your rules as written", digest: specVariantDigest(base), spec: base }];
  const seen = new Set([variants[0]!.digest]);
  const names = Object.keys(base.indicators).sort();
  for (const name of names) {
    const def = base.indicators[name]!;
    // A session range is anchored to an hour of the day: its neighbours are not "slightly longer", so it is left as written.
    const key = "period" in def ? "period" : def.kind === "vwap" ? (def.anchor === "swing" ? "lookback" : null) : def.kind === "session_range" ? null : "lookback";
    if (key === null) continue;
    const current = (def as unknown as Record<string, number>)[key]!;
    const down = Math.max(2, Math.round(current * 0.75));
    const up = Math.round(current * 1.25);
    const candidates = [down === current ? current - 1 : down, up === current ? current + 1 : up];
    for (const value of candidates) {
      if (variants.length >= cap) return variants;
      if (value < 2 || value === current) continue;
      const patched = JSON.parse(JSON.stringify(base)) as TradingStrategySpec;
      (patched.indicators[name] as unknown as Record<string, number>)[key] = value;
      // A longer indicator needs more history before it can decide: widen an explicit warm-up with it.
      if (patched.universe.warmupBars !== undefined) patched.universe.warmupBars = Math.max(patched.universe.warmupBars, tradingSpecRequiredBars(patched));
      const parsed = tradingStrategySpecSchema.safeParse(patched);
      if (!parsed.success) continue;
      const digest = specVariantDigest(parsed.data);
      if (seen.has(digest)) continue;
      seen.add(digest);
      variants.push({ index: variants.length, label: `${name} ${key} ${current} -> ${value}`, digest, spec: parsed.data });
    }
  }
  return variants;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const FX = TRADING_ESTIMATED_USD_NOK_RATE;

function lowerBound(bars: readonly TradingEngineBar[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.openTime.getTime() < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Non-finite numbers become null so a report is always valid JSON and hashes the same everywhere. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v))) as T;
}

interface Cell {
  coin: string;
  window: WalkForwardWindow;
  start: number;
  end: number;
  sim2: SimulationResult;
  sim1: SimulationResult | null;
  variantIndex: number;
}

function metricsOf(sim: SimulationResult, tfMs: number): BacktestMetrics {
  return summarizeBacktest(sim.trades, { equity: sim.equity, inPosition: sim.inPosition, timeframeMs: tfMs });
}

/** Joins the windows of a stream into one equity curve (each window starts where the last ended) so Sharpe, drawdown and exposure can be read over the whole stream. */
function pooled(cells: readonly Pick<Cell, "sim2">[], tfMs: number, which: "sim2" = "sim2"): { metrics: BacktestMetrics; returns: number[] } {
  const trades: BacktestTrade[] = [];
  const returns: number[] = [];
  const inPosition: boolean[] = [];
  for (const cell of cells) {
    const sim = cell[which];
    trades.push(...sim.trades);
    returns.push(...equityReturns(sim.equity));
    inPosition.push(...sim.inPosition);
  }
  const equity: number[] = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  const metrics = summarizeBacktest(trades, equity.length > 1 ? { equity, inPosition: inPosition.slice(0, equity.length), timeframeMs: tfMs } : null);
  return { metrics: { ...metrics, exposure: inPosition.length > 0 ? inPosition.filter(Boolean).length / inPosition.length : 0 }, returns };
}

function positive(metrics: BacktestMetrics): boolean {
  if (metrics.trades === 0) return false;
  if (metrics.expectancyR !== null) return metrics.expectancyR > 0;
  return metrics.meanTradeReturn !== null && metrics.meanTradeReturn > 0;
}

function byRegime(trades: readonly BacktestTrade[]): Record<string, BacktestMetrics> {
  const out: Record<string, BacktestMetrics> = {};
  for (const regime of [...TRADING_BACKTEST_REGIMES, "unclear"] as const) {
    out[regime] = summarizeBacktest(trades.filter((t) => (t.regime ?? "unclear") === regime), null);
  }
  return out;
}

function compareSignals(a: readonly SignalEvent[], b: readonly SignalEvent[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── The run ─────────────────────────────────────────────────────────────────

interface CoinData {
  coin: string;
  bars: TradingEngineBar[];
  fine: TradingEngineBar[];
  labels: Array<TradingBacktestRegime | null>;
}

export async function executeBacktest(input: BacktestInputs): Promise<BacktestOutcome> {
  const { spec, params } = input;
  const timeframe = spec.universe.decisionTimeframe;
  if (timeframe === "15m") {
    throw new BacktestRefusal("15-minute bars are for research only (decision 4): the candle store keeps 5-minute, 1-hour, 4-hour and daily bars, so a 15-minute strategy cannot be tested on past data yet.");
  }
  const tfMs = tradingTimeframeMs(timeframe);
  const asOf = new Date(params.asOf);
  const costs1 = params.costs;
  const costs2: SimulationCosts = { ...params.costs, feeRatePct: params.costs.feeRatePct * TRADING_BACKTEST_COSTS.gateFeeMultiplier };
  const startingCashUsd = params.startingCashNok / FX;
  const warm = backtestWarmupBars(spec);
  const horizonMs = spec.prediction.horizonBars * tfMs;
  const makeDecider = input.makeDecider ?? specDecider;
  const checkpoint = input.checkpoint;

  // 1. Load and clip. The data end is the earliest "newest bar" of any coin tested, so every coin is judged on the same calendar.
  const loaded: CoinData[] = [];
  const skippedCoins: Array<{ coin: string; reason: string }> = [];
  for (const coin of params.assets) {
    const raw = await input.loadBars(coin, timeframe);
    const bars = raw.filter((b) => b.openTime.getTime() + tfMs <= asOf.getTime());
    if (bars.length < warm + 10) {
      skippedCoins.push({ coin, reason: bars.length === 0 ? `no ${timeframe} candles stored on ${params.source}` : `only ${bars.length} ${timeframe} candles stored` });
      continue;
    }
    const fine = (await input.loadBars(coin, "5m")).filter((b) => b.openTime.getTime() + 300_000 <= asOf.getTime());
    loaded.push({ coin, bars, fine, labels: [] });
  }
  const dataEndMs = loaded.length === 0 ? asOf.getTime() : Math.min(...loaded.map((c) => c.bars[c.bars.length - 1]!.openTime.getTime() + tfMs));
  const dataEnd = new Date(dataEndMs);
  const coins: CoinData[] = loaded.map((c) => {
    const bars = c.bars.filter((b) => b.openTime.getTime() + tfMs <= dataEndMs);
    return { coin: c.coin, bars, fine: c.fine.filter((b) => b.openTime.getTime() + 300_000 <= dataEndMs), labels: regimeLabels(bars) };
  });

  // 2. The holdout, then the walk-forward windows before it.
  const plan: HoldoutPlan = planHoldout({ dataEnd, priorReads: input.priorReads });
  const holdoutStart = new Date(plan.start);
  const readsHoldout = params.purpose === "gate";
  const variants = buildVariants(spec, params.maxVariants);
  const base = variants[0]!;
  const deciders = variants.map((v) => makeDecider(v.spec));

  const windowsByCoin = new Map<string, WalkForwardWindow[]>();
  for (const c of coins) {
    const dataStart = new Date(c.bars[0]!.openTime.getTime() + warm * tfMs);
    windowsByCoin.set(c.coin, walkForwardWindows({ dataStart, walkForwardEnd: holdoutStart, horizonMs }));
  }

  // 3. Every variant on every test window at 2x fees (and the chosen stream also at 1x).
  const streams: Cell[][] = variants.map(() => []);
  const tuneScore = new Map<string, number>();
  for (const c of coins) {
    for (const w of windowsByCoin.get(c.coin)!) {
      const start = lowerBound(c.bars, new Date(w.testStart).getTime());
      const end = lowerBound(c.bars, new Date(w.testEnd).getTime());
      if (end - start < 2) continue;
      for (const v of variants) {
        checkpoint?.();
        const sim2 = simulateWindow({ spec: v.spec, coin: c.coin, bars: c.bars, fineBars: c.fine, start, end, costs: costs2, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[v.index]!, joined: input.joined, checkpoint });
        streams[v.index]!.push({ coin: c.coin, window: w, start, end, sim2, sim1: null, variantIndex: v.index });
        if (params.selection === "best_in_sample") {
          const tStart = lowerBound(c.bars, new Date(w.tuneStart).getTime());
          const tEnd = lowerBound(c.bars, new Date(w.tuneEnd).getTime());
          const tune = simulateWindow({ spec: v.spec, coin: c.coin, bars: c.bars, fineBars: c.fine, start: tStart, end: tEnd, costs: costs2, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[v.index]!, checkpoint });
          const m = metricsOf(tune, tfMs);
          tuneScore.set(`${c.coin}:${w.index}:${v.index}`, m.trades >= 5 && m.meanTradeReturn !== null ? m.meanTradeReturn : -Infinity);
        }
      }
    }
  }

  // The stream the report is about: the base rules on every window, or the in-sample winner of each window.
  const selectedCells: Cell[] = [];
  const baseCells = streams[0]!;
  baseCells.forEach((cell, k) => {
    let chosen = 0;
    if (params.selection === "best_in_sample") {
      let best = -Infinity;
      variants.forEach((v) => {
        const score = tuneScore.get(`${cell.coin}:${cell.window.index}:${v.index}`) ?? -Infinity;
        if (score > best) {
          best = score;
          chosen = v.index;
        }
      });
    }
    const picked = streams[chosen]![k]!;
    const c = coins.find((x) => x.coin === picked.coin)!;
    picked.sim1 = simulateWindow({ spec: variants[chosen]!.spec, coin: c.coin, bars: c.bars, fineBars: c.fine, start: picked.start, end: picked.end, costs: costs1, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[chosen]!, checkpoint });
    selectedCells.push({ ...picked, variantIndex: chosen });
  });

  // 4. Integrity checks on the base rules: a look-ahead test and the point-in-time audit.
  let lookAhead: { passed: boolean | null; checked: number; signalsCompared: number; detail: string };
  {
    let checked = 0;
    let compared = 0;
    let failure: string | null = null;
    for (const c of coins) {
      const windows = (windowsByCoin.get(c.coin) ?? []).slice(-4);
      if (windows.length === 0) continue;
      const start = lowerBound(c.bars, new Date(windows[0]!.testStart).getTime());
      const end = lowerBound(c.bars, new Date(windows[windows.length - 1]!.testEnd).getTime());
      if (end - start < 30) continue;
      const run = (barsEnd: number) => simulateWindow({ spec, coin: c.coin, bars: c.bars.slice(0, barsEnd), fineBars: c.fine.filter((b) => b.openTime.getTime() < c.bars[barsEnd - 1]!.openTime.getTime() + tfMs), start, end: barsEnd, costs: costs2, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[0]!, checkpoint });
      const full = run(end);
      for (const fraction of [0.6, 0.85]) {
        const cut = start + Math.floor((end - start) * fraction);
        const cutClose = c.bars[cut - 1]!.openTime.getTime() + tfMs;
        let truncated: SimulationResult;
        try {
          truncated = run(cut);
        } catch (err) {
          failure = `${c.coin}: the rules could not decide on truncated data (${err instanceof Error ? err.message : "error"}), which means they read bars that did not exist yet.`;
          break;
        }
        const expected = full.signals.filter((s) => new Date(s.at).getTime() <= cutClose);
        checked += 1;
        compared += expected.length;
        if (!compareSignals(expected, truncated.signals)) {
          failure = `${c.coin}: signals changed when the data was cut at ${new Date(cutClose).toISOString()} (${expected.length} signals with all the data, ${truncated.signals.length} with the cut data).`;
          break;
        }
      }
      if (failure) break;
    }
    lookAhead = failure
      ? { passed: false, checked, signalsCompared: compared, detail: failure }
      : checked === 0
        ? { passed: null, checked, signalsCompared: 0, detail: "There was not enough history to run the look-ahead check." }
        : { passed: true, checked, signalsCompared: compared, detail: `Signals on truncated data matched exactly in ${checked} cut${checked === 1 ? "" : "s"} (${compared} signals compared).` };
  }
  const allSims = [...streams.flat().map((c) => c.sim2)];
  const pitReads = allSims.reduce((s, x) => s + x.pointInTimeReads, 0);
  const pitViolations = allSims.reduce((s, x) => s + x.pointInTimeViolationCount, 0);
  const pitSample = allSims.flatMap((x) => x.pointInTimeViolations).slice(0, 20);

  // 5. Per-coin report, with regime coverage and baselines.
  const risk = deriveTradingRiskConfig(spec);
  const randomRuns = TRADING_BACKTEST_LIMITS.randomEntryRuns;
  const headlineRandom: Array<{ sum: number; count: number }> = Array.from({ length: randomRuns }, () => ({ sum: 0, count: 0 }));
  const coinReports: Array<Record<string, unknown>> = [];
  const headlineCells: Cell[] = [];
  const coverageFacts: Array<{ coin: string; missing: TradingBacktestRegime[] }> = [];
  for (const c of coins) {
    const cells = selectedCells.filter((x) => x.coin === c.coin);
    const headline = isHeadlineCoin(c.coin);
    if (headline) headlineCells.push(...cells);
    const days: Record<string, number> = { bull: 0, bear: 0, range: 0, unclear: 0 };
    for (const cell of cells) {
      for (let i = cell.start; i < cell.end; i++) days[c.labels[i] ?? "unclear"]! += tfMs / DAY_MS;
    }
    const missing = TRADING_BACKTEST_REGIMES.filter((r) => days[r]! < TRADING_START_GATE.minRegimeDays);
    if (headline) coverageFacts.push({ coin: c.coin, missing });
    const p2 = pooled(cells, tfMs);
    const p1 = pooled(cells.map((x) => ({ sim2: x.sim1! })), tfMs);
    const trades2 = cells.flatMap((x) => x.sim2.trades);
    const randomPerCoin = Array.from({ length: randomRuns }, () => ({ sum: 0, count: 0 }));
    cells.forEach((cell) => {
      const replay = randomEntryReplay({ bars: c.bars, start: cell.start, end: cell.end, heldBars: cell.sim2.trades.map((t) => t.bars), costs: costs2, runs: randomRuns, seed: seedFromText(`${params.seed}:${c.coin}:${cell.window.index}`) });
      replay.forEach((r, k) => {
        randomPerCoin[k]!.sum += r.sum;
        randomPerCoin[k]!.count += r.count;
        if (headline) {
          headlineRandom[k]!.sum += r.sum;
          headlineRandom[k]!.count += r.count;
        }
      });
    });
    const strategyMean = p2.metrics.meanTradeReturn;
    const runMeans = randomPerCoin.filter((r) => r.count > 0).map((r) => r.sum / r.count).sort((a, b) => a - b);
    const quantile = (q: number) => (runMeans.length === 0 ? null : runMeans[Math.min(runMeans.length - 1, Math.floor(q * (runMeans.length - 1)))]!);
    const windows = cells.map((cell) => ({
      index: cell.window.index,
      tuneStart: cell.window.tuneStart,
      tuneEnd: cell.window.tuneEnd,
      testStart: cell.window.testStart,
      testEnd: cell.window.testEnd,
      variant: variants[cell.variantIndex]!.label,
      fees2x: metricsOf(cell.sim2, tfMs),
      fees1x: metricsOf(cell.sim1!, tfMs),
      buyAndHold: { fees2x: buyAndHoldReturn(c.bars, cell.start, cell.end, costs2), fees1x: buyAndHoldReturn(c.bars, cell.start, cell.end, costs1) },
      cash: 0,
      blockedByLimits: cell.sim2.blockedCount,
      approvalsAssumed: cell.sim2.approvalAssumed,
      bars5mChecked: cell.sim2.intrabarBars,
      bars: cell.sim2.barsTotal,
    }));
    const dataFrom = c.bars[0]!.openTime.toISOString();
    coinReports.push({
      coin: c.coin,
      headline,
      flag: headline ? null : TRADING_HINDSIGHT_FLAG,
      dataFrom,
      dataTo: dataEnd.toISOString(),
      bars: c.bars.length,
      fineBars: c.fine.length,
      windows,
      outOfSample: { fees2x: p2.metrics, fees1x: p1.metrics, byRegime2x: byRegime(trades2) },
      regimeCoverage: { days, minDays: TRADING_START_GATE.minRegimeDays, missing },
      baselines: {
        cash: { returnPct: 0 },
        buyAndHold: windows.map((w) => ({ window: w.index, returnPct2x: w.buyAndHold.fees2x === null ? null : w.buyAndHold.fees2x * 100 })),
        randomEntry: {
          runs: runMeans.length,
          meanTradeReturnP05: quantile(0.05),
          meanTradeReturnMedian: quantile(0.5),
          meanTradeReturnP95: quantile(0.95),
          strategyMeanTradeReturn: strategyMean,
          beatShare: strategyMean === null || runMeans.length === 0 ? null : runMeans.filter((m) => m < strategyMean).length / runMeans.length,
        },
      },
    });
  }

  // 6. The holdout read (gate runs only): the base rules, one continuous account over the holdout stretch.
  let holdoutReport: Record<string, unknown> = { ...plan, read: false, label: "not read: an exploration run never touches the holdout" };
  let holdoutFacts = { read: false, seenCount: plan.seenCount, label: plan.label, positive: null as boolean | null, trades: 0 };
  let holdoutRead: BacktestOutcome["holdoutRead"] = null;
  if (readsHoldout) {
    const perCoin: Array<Record<string, unknown>> = [];
    const headlineTrades: BacktestTrade[] = [];
    let worstDd = 0;
    for (const c of coins) {
      const start = lowerBound(c.bars, holdoutStart.getTime());
      const end = c.bars.length;
      if (end - start < 2) {
        perCoin.push({ coin: c.coin, headline: isHeadlineCoin(c.coin), flag: isHeadlineCoin(c.coin) ? null : TRADING_HINDSIGHT_FLAG, bars: 0 });
        continue;
      }
      const sim2 = simulateWindow({ spec, coin: c.coin, bars: c.bars, fineBars: c.fine, start, end, costs: costs2, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[0]!, checkpoint });
      const sim1 = simulateWindow({ spec, coin: c.coin, bars: c.bars, fineBars: c.fine, start, end, costs: costs1, startingCashUsd, regimeAt: (i) => c.labels[i] ?? null, decide: deciders[0]!, checkpoint });
      const m2 = metricsOf(sim2, tfMs);
      if (isHeadlineCoin(c.coin)) {
        headlineTrades.push(...sim2.trades);
        worstDd = Math.max(worstDd, m2.maxDrawdownPct);
      }
      perCoin.push({ coin: c.coin, headline: isHeadlineCoin(c.coin), flag: isHeadlineCoin(c.coin) ? null : TRADING_HINDSIGHT_FLAG, bars: end - start, fees2x: m2, fees1x: metricsOf(sim1, tfMs), buyAndHold: { fees2x: buyAndHoldReturn(c.bars, start, end, costs2) } });
    }
    const summary = summarizeBacktest(headlineTrades, null);
    const headlinePositive = positive(summary) && worstDd <= risk.maxDrawdownPct;
    holdoutFacts = { read: true, seenCount: plan.seenCount, label: plan.label, positive: headlinePositive, trades: summary.trades };
    holdoutReport = { read: true, ...plan, headline: { fees2x: summary, worstDrawdownPct: worstDd, drawdownCapPct: risk.maxDrawdownPct, positive: headlinePositive }, coins: perCoin };
    holdoutRead = { start: plan.start, end: plan.end, seenCount: plan.seenCount };
  }

  // 7. The trial registry numbers: one Sharpe per variant, the Deflated Sharpe ratio of the base.
  const headlineCoinNames = coins.filter((c) => isHeadlineCoin(c.coin)).map((c) => c.coin);
  const sharpeCoins = headlineCoinNames.length > 0 ? new Set(headlineCoinNames) : new Set(coins.map((c) => c.coin));
  const trials: TrialRecord[] = variants.map((v) => {
    const cells = streams[v.index]!.filter((cell) => sharpeCoins.has(cell.coin));
    const { returns } = pooled(cells, tfMs);
    return { variantDigest: v.digest, variantLabel: v.label, oosSharpe: returns.length >= 2 ? periodicSharpe(returns) : null, oosObservations: returns.length };
  });
  const registry = new Map<string, number | null>();
  for (const t of input.priorTrials) registry.set(t.variantDigest, t.oosSharpe);
  for (const t of trials) if (!registry.has(t.variantDigest)) registry.set(t.variantDigest, t.oosSharpe);
  const registrySharpes = [...registry.values()].filter((x): x is number => x !== null);
  const trialVariance = registrySharpes.length >= 2 ? sampleStd(registrySharpes) ** 2 : 0;
  const baseCellsHeadline = baseCells.filter((cell) => sharpeCoins.has(cell.coin));
  const baseReturns = pooled(baseCellsHeadline, tfMs).returns;
  const dsr = deflatedSharpe({
    observedSharpe: baseReturns.length >= 2 ? periodicSharpe(baseReturns) : 0,
    observations: baseReturns.length,
    skew: skewness(baseReturns),
    kurt: kurtosis(baseReturns),
    trials: Math.max(1, registry.size),
    trialSharpeVariance: trialVariance,
  });

  // 8. Plateau: do the neighbouring parameter sets also work out of sample?
  const neighbourStats = variants.slice(1).map((v) => {
    const cells = streams[v.index]!.filter((cell) => cell.coin && isHeadlineCoin(cell.coin));
    const m = pooled(cells, tfMs).metrics;
    return { label: v.label, trades: m.trades, expectancyR: m.expectancyR, meanTradeReturn: m.meanTradeReturn, positive: positive(m) };
  });

  // 9. The headline numbers and the gate.
  const headlineSelected = pooled(headlineCells, tfMs);
  let windowsPositive = 0;
  let worstDrawdown: number | null = null;
  for (const cell of headlineCells) {
    if (positive(metricsOf(cell.sim2, tfMs))) windowsPositive += 1;
    const dd = metricsOf(cell.sim2, tfMs).maxDrawdownPct;
    worstDrawdown = worstDrawdown === null ? dd : Math.max(worstDrawdown, dd);
  }
  const headlineMeans = headlineRandom.filter((r) => r.count > 0).map((r) => r.sum / r.count);
  const strategyMean = headlineSelected.metrics.meanTradeReturn;
  const beatRandomShare = strategyMean === null || headlineMeans.length === 0 ? null : headlineMeans.filter((m) => m < strategyMean).length / headlineMeans.length;
  const gate = evaluateBacktestGate({
    purpose: params.purpose,
    source: params.source,
    headlineCoinsTested: headlineCoinNames,
    outOfSample: {
      trades: headlineSelected.metrics.trades,
      expectancyR: headlineSelected.metrics.expectancyR,
      meanTradeReturn: headlineSelected.metrics.meanTradeReturn,
      windowsPositive,
      windowsTotal: headlineCells.length,
      worstDrawdownPct: worstDrawdown,
      drawdownCapPct: risk.maxDrawdownPct,
      beatRandomShare,
    },
    plateau: { applicable: neighbourStats.length > 0, neighbours: neighbourStats.length, positive: neighbourStats.filter((n) => n.positive).length },
    coverage: coverageFacts,
    integrity: { lookAheadPassed: lookAhead.passed, pointInTimePassed: pitViolations === 0 },
    holdout: holdoutFacts,
  });
  // A past-data test with an honest "selection: best_in_sample" is an experiment about a tuning method, never a verdict on the written rules.
  if (params.selection !== "base" && gate.passed) {
    gate.passed = false;
    gate.items.unshift({ key: "selection", label: "The written rules were tested as they are", passed: false, detail: "Each window re-picked its best variant, so this tests the tuning method, not the rules as written." });
    gate.summary = "Did not pass: The written rules were tested as they are.";
  }

  const report = clean({
    schema: 1,
    asOf: params.asOf,
    source: params.source,
    purpose: params.purpose,
    selection: params.selection,
    timeframe,
    costs: { fees1x: costs1, fees2x: costs2, note: "A signal at a bar close fills at the next open, plus half the spread and slippage; fees are charged on both sides. The 2x run is the gate." },
    warmupBars: warm,
    horizonBars: spec.prediction.horizonBars,
    walkForward: { tuneMonths: 24, testMonths: 3, rollMonths: 3, gap: `${spec.prediction.horizonBars} bar${spec.prediction.horizonBars === 1 ? "" : "s"} (one prediction horizon)`, holdoutStart: plan.start, dataEnd: dataEnd.toISOString(), note: params.selection === "base" ? "The rules were not re-tuned: every test window runs the rules as written. The tune stretch is shown for the layout only." : "Each window picked its best variant on its tune stretch, then ran it on the test stretch." },
    skippedCoins,
    coins: coinReports,
    headline: {
      coins: headlineCoinNames,
      outOfSample: { fees2x: headlineSelected.metrics, byRegime2x: byRegime(headlineCells.flatMap((c) => c.sim2.trades)) },
      windows: { total: headlineCells.length, positive: windowsPositive },
      worstWindowDrawdownPct: worstDrawdown,
      drawdownCapPct: risk.maxDrawdownPct,
      beatRandomShare,
      note: `Headline results use ${TRADING_START_GATE.headlineCoins.join(" and ")} only. Other coins are shown flagged "${TRADING_HINDSIGHT_FLAG}".`,
    },
    holdout: holdoutReport,
    integrity: {
      lookAhead,
      pointInTime: { passed: pitViolations === 0, joinedReads: pitReads, violations: pitViolations, sample: pitSample, detail: pitReads === 0 ? "No joined inputs were used, so there was nothing to be early." : pitViolations === 0 ? "Every joined input was known at its decision time." : `${pitViolations} joined input${pitViolations === 1 ? " was" : "s were"} used before being available.` },
    },
    trials: {
      variantsInThisRun: variants.length,
      variantsInRegistry: registry.size,
      deflatedSharpeProbability: dsr.probability,
      benchmarkSharpePerBar: dsr.benchmarkSharpe,
      variants: trials.map((t) => ({ label: t.variantLabel, digest: t.variantDigest, oosSharpePerBar: t.oosSharpe, observations: t.oosObservations })),
      plateau: { applicable: neighbourStats.length > 0, neighbours: neighbourStats },
    },
    gate,
    thresholdsNote: "The gate's numbers are the plan's defaults and are assumptions; they are stored with each result.",
  });
  const resultDigest = createHash("sha256").update(canonicalTradingJson(report)).digest("hex");
  return { report, gate, resultDigest, trials, holdoutRead, variantsTried: variants.length };
}
