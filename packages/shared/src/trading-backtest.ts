import { z } from "zod";
import { TRADING_PASS_FAIL_CRITERIA } from "./trading-criteria.js";
import { canonicalTradingJson, deriveTradingRiskConfig, tradingRiskLoosenings, type TradingStrategySpec } from "./trading-spec.js";

/**
 * DUR-5008: the past-data test ("backtest") — everything that is pure maths or
 * pure rules, shared by the worker that runs it, the start gate that reads it
 * and (later) the report page.
 *
 * Design source: the plan document on DUR-4889, section 5. Nothing here is
 * copied from an AGPL or GPL project: Wilson, Sharpe, Sortino, the Deflated
 * Sharpe ratio (Bailey & López de Prado, 2014) and the walk-forward layout are
 * textbook formulas written out from their definitions.
 *
 * Every number the gate compares against is a named constant below. The plan
 * says its default numbers "are assumptions": they live in TRADING_START_GATE
 * so changing one is a visible, reviewed edit, and each run stores the
 * thresholds it was judged by.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Costs. The fee is the paper fee of decision 5; the gate run is at 2x of it. */
export const TRADING_BACKTEST_COSTS = {
  /** 0.40% per side (decision 5). */
  feeRatePct: 0.4,
  /** The full bid/ask spread as % of the price; a fill pays half of it. "Roughly 0.1%" in the plan. */
  spreadPct: 0.1,
  /** Extra adverse move on every fill, as % of the price. */
  slippagePct: 0.05,
  /** Every past-data test also runs at these multiples of the fee; the LAST one is the gate. */
  feeMultipliers: [1, TRADING_PASS_FAIL_CRITERIA.pastData.gateFeeMultiplier] as const,
  gateFeeMultiplier: TRADING_PASS_FAIL_CRITERIA.pastData.gateFeeMultiplier,
} as const;

/** Walk-forward layout (plan section 5, item 4). */
export const TRADING_BACKTEST_WALK_FORWARD = {
  tuneMonths: 24,
  testMonths: 3,
  rollMonths: 3,
  holdoutMonths: 12,
  /** Once this much new data exists since a lineage's last holdout read, that stretch is a fresh holdout. */
  freshHoldoutMonths: 6,
} as const;

/** Compute caps: a past-data test never runs away (plan section 5, item 12). */
export const TRADING_BACKTEST_LIMITS = {
  maxVariants: 25,
  /** Tests waiting or running for one company at once. */
  maxActiveRunsPerCompany: 10,
  /** Wall-clock limit for one run in its worker. */
  maxWallMs: 20 * 60_000,
  /** Random-entry runs per coin for the baseline. */
  randomEntryRuns: 300,
} as const;

/** The gate's thresholds (plan section 5, item 10). Defaults are assumptions, stored with every run. */
export const TRADING_START_GATE = {
  /** The headline gate uses these coins only; every other coin is flagged "chosen with hindsight". */
  headlineCoins: ["BTC", "ETH"] as const,
  minOutOfSampleTrades: TRADING_PASS_FAIL_CRITERIA.pastData.minOutOfSampleTrades,
  /** Share of out-of-sample windows that must be positive. A window with no trades is not positive. */
  minPositiveWindowShare: TRADING_PASS_FAIL_CRITERIA.pastData.minPositiveWindowShare,
  /** The strategy's per-trade net return must beat this share of the random-entry runs. */
  randomEntryQuantile: TRADING_PASS_FAIL_CRITERIA.pastData.randomEntryQuantile,
  /** Share of neighbouring parameter sets that must also be positive out of sample. */
  minPlateauShare: 0.75,
  /** A market state counts as covered by a coin's out-of-sample windows with at least this many days of it. */
  minRegimeDays: 30,
  /** The candle source a strategy trades live; a gate run must use it. */
  liveSource: "kraken",
} as const;

export const TRADING_BACKTEST_PURPOSES = ["explore", "gate"] as const;
export type TradingBacktestPurpose = (typeof TRADING_BACKTEST_PURPOSES)[number];

export const queueTradingBacktestSchema = z
  .object({
    /** Defaults to the strategy's active version. */
    versionId: z.string().uuid().optional(),
    /** 'gate' (default) reads the holdout and can clear the start gate; 'explore' never does. */
    purpose: z.enum(TRADING_BACKTEST_PURPOSES).optional(),
    /** 'base' tests the rules as written (the only choice for a gate run); 'best_in_sample' re-picks the best variant per window. */
    selection: z.enum(["base", "best_in_sample"]).optional(),
    maxVariants: z.number().int().min(1).max(TRADING_BACKTEST_LIMITS.maxVariants).optional(),
  })
  .strict();
export type QueueTradingBacktestInput = z.infer<typeof queueTradingBacktestSchema>;

export const TRADING_BACKTEST_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type TradingBacktestStatus = (typeof TRADING_BACKTEST_STATUSES)[number];

/** bull/bear/range as the plan names them, from the engine's trend label (up/down/range). */
export const TRADING_BACKTEST_REGIMES = ["bull", "bear", "range"] as const;
export type TradingBacktestRegime = (typeof TRADING_BACKTEST_REGIMES)[number];

export function backtestRegimeOfTrend(trend: "up" | "down" | "range" | "unclear" | null | undefined): TradingBacktestRegime | null {
  if (trend === "up") return "bull";
  if (trend === "down") return "bear";
  if (trend === "range") return "range";
  return null;
}

// ─── Calendar helpers (UTC months, no local time anywhere) ───────────────────

export function addUtcMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n - 1). 0 for fewer than two values. */
export function sampleStd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return Math.sqrt(sum / (values.length - 1));
}

export function skewness(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  let m2 = 0;
  let m3 = 0;
  for (const v of values) {
    m2 += (v - m) ** 2;
    m3 += (v - m) ** 3;
  }
  m2 /= n;
  m3 /= n;
  return m2 === 0 ? 0 : m3 / m2 ** 1.5;
}

/** Plain (not excess) kurtosis: 3 for a normal distribution. */
export function kurtosis(values: readonly number[]): number {
  const n = values.length;
  if (n < 4) return 3;
  const m = mean(values);
  let m2 = 0;
  let m4 = 0;
  for (const v of values) {
    m2 += (v - m) ** 2;
    m4 += (v - m) ** 4;
  }
  m2 /= n;
  m4 /= n;
  return m2 === 0 ? 3 : m4 / (m2 * m2);
}

/** Standard normal CDF through the error function (Abramowitz & Stegun 7.1.26; error below 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Inverse of normalCdf by bisection: deterministic, no tables. p must be in (0, 1). */
export function normalInverseCdf(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  let low = -10;
  let high = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (normalCdf(mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Wilson score interval for a hit rate (95% by default). With no trades it is the whole range, never a number from nothing. */
export function wilsonInterval(wins: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Bars per year for a decision timeframe, counting every calendar day (crypto never closes): the "365" in Sharpe/Sortino (365). */
export function barsPerYear(timeframeMs: number): number {
  return (365 * 24 * 3_600_000) / timeframeMs;
}

/** Per-bar Sharpe ratio (mean / sample std of the bar returns); not annualised. */
export function periodicSharpe(returns: readonly number[]): number {
  const sd = sampleStd(returns);
  return sd === 0 ? 0 : mean(returns) / sd;
}

export function annualisedSharpe(returns: readonly number[], periodsPerYear: number): number {
  return periodicSharpe(returns) * Math.sqrt(periodsPerYear);
}

/** Sortino against a zero target: mean / downside deviation, annualised. */
export function annualisedSortino(returns: readonly number[], periodsPerYear: number): number {
  if (returns.length < 2) return 0;
  let down = 0;
  for (const r of returns) if (r < 0) down += r * r;
  const dd = Math.sqrt(down / returns.length);
  return dd === 0 ? 0 : (mean(returns) / dd) * Math.sqrt(periodsPerYear);
}

/** Largest peak-to-trough fall of an equity series, as a positive %. */
export function maxDrawdownPct(equity: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.max(worst, ((peak - value) / peak) * 100);
  }
  return worst;
}

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * The Deflated Sharpe ratio (Bailey & López de Prado): the probability that
 * the observed Sharpe ratio beats the best Sharpe one would expect from the
 * same number of luckless trials. All Sharpe values are per bar, not
 * annualised. With one trial the benchmark is 0 and this is the Probabilistic
 * Sharpe ratio against zero.
 */
export function deflatedSharpe(input: {
  observedSharpe: number;
  observations: number;
  skew: number;
  kurt: number;
  /** Every variant ever tried in the lineage, this one included. */
  trials: number;
  /** Variance of the trials' Sharpe ratios. */
  trialSharpeVariance: number;
}): { probability: number; benchmarkSharpe: number } {
  const { observedSharpe: sr, observations: t, skew, kurt, trials, trialSharpeVariance } = input;
  if (t < 3) return { probability: 0, benchmarkSharpe: 0 };
  let benchmark = 0;
  if (trials > 1 && trialSharpeVariance > 0) {
    benchmark = Math.sqrt(trialSharpeVariance) * ((1 - EULER_MASCHERONI) * normalInverseCdf(1 - 1 / trials) + EULER_MASCHERONI * normalInverseCdf(1 - 1 / (trials * Math.E)));
  }
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(denom > 0)) return { probability: 0, benchmarkSharpe: benchmark };
  const z = ((sr - benchmark) * Math.sqrt(t - 1)) / Math.sqrt(denom);
  return { probability: normalCdf(z), benchmarkSharpe: benchmark };
}

/** A 32-bit seed from text (FNV-1a), so a run's random numbers follow from its own parameters. */
export function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ─── Trades and metrics ──────────────────────────────────────────────────────

export interface BacktestTrade {
  coin: string;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  /** Bars held at the decision timeframe. */
  bars: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  /** Net result over the money put in (entry cost plus both fees), as a fraction. */
  netReturn: number;
  /** Net result in units of the initial risk (the spec's R unit); null when the risk could not be measured. */
  r: number | null;
  exitReason: string;
  /** The market state when the entry was decided, from the trend label. */
  regime: TradingBacktestRegime | null;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  hitRate: number | null;
  hitRateLow: number;
  hitRateHigh: number;
  /** Mean R over the trades whose risk could be measured. */
  expectancyR: number | null;
  tradesWithR: number;
  profitFactor: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  netPnlUsd: number;
  grossPnlUsd: number;
  feesUsd: number;
  /** Fees as % of gross profit; null when there was no gross profit to compare against. */
  feesPctOfGross: number | null;
  /** Mean net return per trade, as a fraction. */
  meanTradeReturn: number | null;
  maxDrawdownPct: number;
  sharpe365: number | null;
  sortino365: number | null;
  /** Share of bars spent in a position. */
  exposure: number;
  bars: number;
}

export interface EquitySlice {
  /** Equity at each bar close, USD. */
  equity: readonly number[];
  /** True for bars at which a position was held. */
  inPosition: readonly boolean[];
  timeframeMs: number;
}

function avg(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

/** Per-bar returns of an equity series; the first bar has none. */
export function equityReturns(equity: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    out.push(prev > 0 ? equity[i]! / prev - 1 : 0);
  }
  return out;
}

export function summarizeBacktest(trades: readonly BacktestTrade[], slice: EquitySlice | null): BacktestMetrics {
  const wins = trades.filter((t) => t.netPnlUsd > 0);
  const losses = trades.filter((t) => t.netPnlUsd <= 0);
  const withR = trades.filter((t) => t.r !== null).map((t) => t.r as number);
  const grossProfit = wins.reduce((s, t) => s + t.netPnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netPnlUsd, 0);
  const grossPnl = trades.reduce((s, t) => s + t.grossPnlUsd, 0);
  const fees = trades.reduce((s, t) => s + t.feesUsd, 0);
  const interval = wilsonInterval(wins.length, trades.length);
  const returns = slice ? equityReturns(slice.equity) : [];
  const perYear = slice ? barsPerYear(slice.timeframeMs) : 0;
  const bars = slice?.equity.length ?? 0;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: trades.length === 0 ? null : wins.length / trades.length,
    hitRateLow: interval.low,
    hitRateHigh: interval.high,
    expectancyR: avg(withR),
    tradesWithR: withR.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWinPct: avg(wins.map((t) => t.netReturn * 100)),
    avgLossPct: avg(losses.map((t) => t.netReturn * 100)),
    avgWinR: avg(wins.filter((t) => t.r !== null).map((t) => t.r as number)),
    avgLossR: avg(losses.filter((t) => t.r !== null).map((t) => t.r as number)),
    netPnlUsd: trades.reduce((s, t) => s + t.netPnlUsd, 0),
    grossPnlUsd: grossPnl,
    feesUsd: fees,
    feesPctOfGross: grossPnl > 0 ? (fees / grossPnl) * 100 : null,
    meanTradeReturn: avg(trades.map((t) => t.netReturn)),
    maxDrawdownPct: slice ? maxDrawdownPct(slice.equity) : 0,
    sharpe365: slice && returns.length >= 2 ? annualisedSharpe(returns, perYear) : null,
    sortino365: slice && returns.length >= 2 ? annualisedSortino(returns, perYear) : null,
    exposure: slice && bars > 0 ? slice.inPosition.filter(Boolean).length / bars : 0,
    bars,
  };
}

// ─── Walk-forward windows and the holdout ────────────────────────────────────

export interface WalkForwardWindow {
  index: number;
  tuneStart: string;
  tuneEnd: string;
  /** The gap of one prediction horizon sits between tuneEnd and testStart. */
  testStart: string;
  testEnd: string;
}

/**
 * Tune on 24 months, skip a gap one horizon long, test on the rest of the next
 * 3 months, roll everything forward 3 months; stop when a test window would
 * reach into the holdout (or past the data).
 */
export function walkForwardWindows(input: { dataStart: Date; walkForwardEnd: Date; horizonMs: number }): WalkForwardWindow[] {
  const { tuneMonths, testMonths, rollMonths } = TRADING_BACKTEST_WALK_FORWARD;
  const out: WalkForwardWindow[] = [];
  for (let k = 0; ; k++) {
    const tuneStart = addUtcMonths(input.dataStart, k * rollMonths);
    const tuneEnd = addUtcMonths(tuneStart, tuneMonths);
    const testEndNominal = addUtcMonths(tuneEnd, testMonths);
    if (testEndNominal.getTime() > input.walkForwardEnd.getTime()) break;
    const testStart = new Date(tuneEnd.getTime() + input.horizonMs);
    out.push({ index: k, tuneStart: tuneStart.toISOString(), tuneEnd: tuneEnd.toISOString(), testStart: testStart.toISOString(), testEnd: testEndNominal.toISOString() });
  }
  return out;
}

export interface HoldoutRead {
  runId: string;
  holdoutStart: string;
  holdoutEnd: string;
}

export interface HoldoutPlan {
  /** The stretch reserved for the holdout read; walk-forward uses only data before it. */
  start: string;
  end: string;
  /** How many earlier reads of this lineage overlap this stretch. 0 = a clean read. */
  seenCount: number;
  /** True when the stretch is new data that no earlier read touched. */
  fresh: boolean;
  label: string;
}

/**
 * Where the holdout is and how often it has been read (plan section 5, item
 * 5). The default holdout is the last 12 months. After a read, once 6 months
 * or more of data exist beyond its end, that newer stretch becomes a fresh
 * holdout of its own (a clean read again); until then a new read overlaps the
 * old one and is labelled "holdout already seen k times".
 */
export function planHoldout(input: { dataEnd: Date; priorReads: readonly HoldoutRead[] }): HoldoutPlan {
  const { holdoutMonths, freshHoldoutMonths } = TRADING_BACKTEST_WALK_FORWARD;
  const defaultStart = addUtcMonths(input.dataEnd, -holdoutMonths);
  let lastReadEnd: Date | null = null;
  for (const read of input.priorReads) {
    const end = new Date(read.holdoutEnd);
    if (lastReadEnd === null || end.getTime() > lastReadEnd.getTime()) lastReadEnd = end;
  }
  if (lastReadEnd !== null && lastReadEnd.getTime() <= addUtcMonths(input.dataEnd, -freshHoldoutMonths).getTime()) {
    const start = lastReadEnd.getTime() > defaultStart.getTime() ? lastReadEnd : defaultStart;
    return { start: start.toISOString(), end: input.dataEnd.toISOString(), seenCount: 0, fresh: true, label: "fresh holdout: data that no earlier read of this strategy has touched" };
  }
  const overlapping = input.priorReads.filter((read) => new Date(read.holdoutEnd).getTime() > defaultStart.getTime() && new Date(read.holdoutStart).getTime() < input.dataEnd.getTime());
  const seenCount = overlapping.length;
  return {
    start: defaultStart.toISOString(),
    end: input.dataEnd.toISOString(),
    seenCount,
    fresh: false,
    label: seenCount === 0 ? "clean holdout: the first read" : `holdout already seen ${seenCount} time${seenCount === 1 ? "" : "s"}`,
  };
}

// ─── The start gate ──────────────────────────────────────────────────────────

export interface BacktestGateItem {
  key: string;
  label: string;
  /** null = could not be judged (and so does not pass). */
  passed: boolean | null;
  detail: string;
}

export interface BacktestGateResult {
  passed: boolean;
  items: BacktestGateItem[];
  thresholds: typeof TRADING_START_GATE & { gateFeeMultiplier: number };
  /** What a person reading the verdict should know first. */
  summary: string;
}

/** The facts the orchestrator computes; the gate only compares them with the thresholds. */
export interface BacktestGateFacts {
  purpose: TradingBacktestPurpose;
  source: string;
  headlineCoinsTested: readonly string[];
  /** Out-of-sample, at the gate fee multiple, on the headline coins only. */
  outOfSample: {
    trades: number;
    expectancyR: number | null;
    meanTradeReturn: number | null;
    windowsPositive: number;
    windowsTotal: number;
    worstDrawdownPct: number | null;
    drawdownCapPct: number;
    /** Share of random-entry runs the strategy beat, 0..1; null when it could not be measured. */
    beatRandomShare: number | null;
  };
  plateau: { applicable: boolean; neighbours: number; positive: number };
  coverage: Array<{ coin: string; missing: TradingBacktestRegime[] }>;
  integrity: { lookAheadPassed: boolean | null; pointInTimePassed: boolean | null };
  holdout: { read: boolean; seenCount: number; label: string; positive: boolean | null; trades: number };
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
const num = (value: number | null, digits = 3) => (value === null ? "n/a" : String(Math.round(value * 10 ** digits) / 10 ** digits));

export function evaluateBacktestGate(facts: BacktestGateFacts): BacktestGateResult {
  const t = TRADING_START_GATE;
  const o = facts.outOfSample;
  const items: BacktestGateItem[] = [];
  const add = (key: string, label: string, passed: boolean | null, detail: string) => items.push({ key, label, passed, detail });

  add(
    "gate_run",
    "A full gate run on the live price source",
    facts.purpose === "gate" && facts.source === t.liveSource,
    facts.purpose !== "gate" ? "This was an exploration run: it never read the holdout, so it cannot start a strategy." : facts.source !== t.liveSource ? `Tested on ${facts.source}, but the strategy trades on ${t.liveSource}.` : `Tested on ${t.liveSource}, the same source the live signals use.`,
  );
  add(
    "headline_coins",
    "Tested on the headline coins (BTC and ETH)",
    facts.headlineCoinsTested.length > 0,
    facts.headlineCoinsTested.length > 0 ? `Headline coins tested: ${facts.headlineCoinsTested.join(", ")}. Other coins are shown as "chosen with hindsight".` : "The strategy trades neither BTC nor ETH, so no headline result exists.",
  );
  add(
    "expectancy",
    "Out-of-sample expectancy above 0 at 2x fees",
    o.expectancyR !== null ? o.expectancyR > 0 : o.meanTradeReturn !== null ? o.meanTradeReturn > 0 : null,
    `Expectancy ${num(o.expectancyR)} R per trade (mean net return per trade ${o.meanTradeReturn === null ? "n/a" : pct(o.meanTradeReturn)}) at double fees.`,
  );
  add("trades", `At least ${t.minOutOfSampleTrades} out-of-sample trades`, o.trades >= t.minOutOfSampleTrades, `${o.trades} out-of-sample trades.`);
  add(
    "windows",
    `Positive in at least ${pct(t.minPositiveWindowShare)} of windows`,
    o.windowsTotal > 0 && o.windowsPositive / o.windowsTotal >= t.minPositiveWindowShare,
    o.windowsTotal === 0 ? "There was not enough history for even one out-of-sample window." : `${o.windowsPositive} of ${o.windowsTotal} windows were positive at double fees (a window with no trades is not positive).`,
  );
  add(
    "random_entry",
    "Beats random entry with the same exposure",
    o.beatRandomShare === null ? null : o.beatRandomShare >= t.randomEntryQuantile,
    o.beatRandomShare === null ? "The random-entry baseline could not be measured." : `Beat ${pct(o.beatRandomShare)} of the random-entry runs; ${pct(t.randomEntryQuantile)} is needed.`,
  );
  add(
    "drawdown",
    "Drawdown within the strategy's own cap",
    o.worstDrawdownPct === null ? null : o.worstDrawdownPct <= o.drawdownCapPct,
    o.worstDrawdownPct === null ? "No drawdown could be measured." : `Worst window drawdown ${num(o.worstDrawdownPct, 1)}% against a cap of ${o.drawdownCapPct}%.`,
  );
  add(
    "plateau",
    "Neighbouring parameters are also positive",
    facts.plateau.applicable ? facts.plateau.neighbours > 0 && facts.plateau.positive / facts.plateau.neighbours >= t.minPlateauShare : true,
    facts.plateau.applicable ? `${facts.plateau.positive} of ${facts.plateau.neighbours} neighbouring parameter sets were positive out of sample.` : "The rules have no number to nudge, so there is no neighbourhood to check.",
  );
  const missing = facts.coverage.filter((c) => c.missing.length > 0);
  add(
    "regimes",
    "Tested across bull, bear and range, per coin",
    facts.coverage.length > 0 && missing.length === 0,
    facts.coverage.length === 0 ? "No coin had out-of-sample windows." : missing.length === 0 ? "Every headline coin's out-of-sample windows cover bull, bear and range." : missing.map((c) => `${c.coin} was never tested in ${c.missing.map((m) => `a ${m === "range" ? "range" : m} market`).join(" or ")}`).join("; ") + ".",
  );
  add("look_ahead", "Look-ahead check: signals on truncated data are identical", facts.integrity.lookAheadPassed, facts.integrity.lookAheadPassed === null ? "The look-ahead check did not run." : facts.integrity.lookAheadPassed ? "Signals computed on truncated data were identical." : "Signals changed when later data was cut off: the rules look into the future.");
  add("point_in_time", "Point in time: every joined input was known at decision time", facts.integrity.pointInTimePassed, facts.integrity.pointInTimePassed === null ? "The point-in-time check did not run." : facts.integrity.pointInTimePassed ? "Every joined input was available at or before its decision time (or none were used)." : "A joined input was used before it was available.");
  const holdoutPassed = facts.holdout.read && facts.holdout.seenCount === 0 && facts.holdout.positive === true;
  add(
    "holdout",
    "A clean holdout read (or confirmation on paper)",
    facts.holdout.read ? holdoutPassed : false,
    !facts.holdout.read
      ? "The holdout was not read."
      : facts.holdout.seenCount > 0
        ? `${facts.holdout.label}. A repeated read cannot pass the gate alone; forward paper data decides.`
        : facts.holdout.positive === true
          ? `${facts.holdout.label}: positive at double fees over ${facts.holdout.trades} trades.`
          : `${facts.holdout.label}: not positive at double fees (${facts.holdout.trades} trades).`,
  );

  const passed = items.every((item) => item.passed === true);
  const failing = items.filter((item) => item.passed !== true).map((item) => item.label);
  return {
    passed,
    items,
    thresholds: { ...t, gateFeeMultiplier: TRADING_BACKTEST_COSTS.gateFeeMultiplier },
    summary: passed ? "Passed every check of the start gate." : `Did not pass: ${failing.join("; ")}.`,
  };
}

/** The coins a gate result may be headlined on. */
export function isHeadlineCoin(coin: string): boolean {
  return (TRADING_START_GATE.headlineCoins as readonly string[]).includes(coin);
}

export const TRADING_HINDSIGHT_FLAG = "coin chosen with hindsight";

/**
 * Does the new version change nothing but make the strategy safer? True when
 * the entry and exit logic, the indicators, the regime gate, the stay-out
 * rules, the prediction and the universe are exactly the same, the risk limits
 * only tighten, and the order size is not larger. Such a version takes over
 * the earlier version's clearance for the start gate (plan section 8: changes
 * "that only make the strategy safer can skip" the past-data test).
 */
export function tradingVersionOnlyTightens(previous: TradingStrategySpec, next: TradingStrategySpec): boolean {
  const strip = (spec: TradingStrategySpec) => {
    const { neverDo: _neverDo, sizing: _sizing, ...rest } = spec;
    void _neverDo;
    void _sizing;
    return canonicalTradingJson(rest);
  };
  if (strip(previous) !== strip(next)) return false;
  if (tradingRiskLoosenings(deriveTradingRiskConfig(previous), deriveTradingRiskConfig(next)).length > 0) return false;
  if (previous.sizing.kind !== next.sizing.kind) return false;
  if (previous.sizing.kind === "fraction_of_cash" && next.sizing.kind === "fraction_of_cash") return next.sizing.fraction <= previous.sizing.fraction;
  if (previous.sizing.kind === "risk_per_trade" && next.sizing.kind === "risk_per_trade") return next.sizing.riskPerTradePct <= previous.sizing.riskPerTradePct;
  return false;
}
