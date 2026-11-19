import type { TradingCandle, TradingTimeframe } from "./trading.js";
import { tradingTimeframeMs } from "./trading.js";
import { TRADING_PASS_FAIL_CRITERIA } from "./trading-criteria.js";

/**
 * Prediction ledger scoring (DUR-5010): the pure rules for resolving a call,
 * the baseline forecasters and every metric on the scoreboard. No I/O, no
 * clock, no Math.random: the same inputs always give the same numbers, which is
 * what lets the tests hold them to hand-computed fixtures.
 *
 * The definitions below are the ones stored with the strategy version before
 * any data is collected (plan section 6). Changing any of them is a new
 * RESOLVER_VERSION, stamped on every resolved row.
 *
 *   Resolution   the close at bar_close_at + horizon against the reference
 *                close at bar_close_at.
 *   Flat band    a move smaller than flatBandPct either way is "flat". Flat
 *                outcomes are left out of the hit rate and reported.
 *   Base rate    the share of "up" outcomes over the trailing 90 days, using
 *                only bars that had resolved before the decision.
 *   Direction    fixed rules are scored on direction only. Brier score, log
 *                loss and calibration exist only for forecasters that carry a
 *                real probability.
 *   R unit       the stop distance, or 1 ATR(14) at entry when there is none.
 */

export const TRADING_RESOLVER_VERSION = 1;
/** Decision 3: about 620 independent predictions per strategy version. */
export const TRADING_DEFAULT_TARGET_SAMPLES: number = TRADING_PASS_FAIL_CRITERIA.forward.targetSamples;
/** The minimum running time of a test, in days (3 months). */
export const TRADING_DEFAULT_MIN_RUNNING_DAYS: number = TRADING_PASS_FAIL_CRITERIA.forward.minRunningDays;
export const TRADING_BASE_RATE_DAYS = 90;
/** Decision 5: 0.40% fee per side. */
export const TRADING_DEFAULT_FEE_PCT_PER_SIDE = 0.4;
/** Assumed spread, % of price, for the default flat band. */
export const TRADING_ASSUMED_SPREAD_PCT = 0.1;
export const TRADING_BASELINE_KEYS = ["baseline:always_up", "baseline:persistence", "baseline:coin_flip"] as const;
export type TradingBaselineKey = (typeof TRADING_BASELINE_KEYS)[number];

/** Half the round-trip cost: two fees plus the assumed spread, halved. */
export function defaultFlatBandPct(feePctPerSide = TRADING_DEFAULT_FEE_PCT_PER_SIDE, spreadPct = TRADING_ASSUMED_SPREAD_PCT): number {
  return (2 * feePctPerSide + spreadPct) / 2;
}

// ─── Seeded randomness ──────────────────────────────────────────────────────

/** FNV-1a, 32 bit. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator returning [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Baselines ──────────────────────────────────────────────────────────────

export type TradingCall = "up" | "down";

/**
 * The three baselines every strategy is compared with. They call every bar:
 *   always up    "up" always;
 *   persistence  the direction of the bar that just closed (an unchanged close calls "up");
 *   coin flip    a fair coin, derived from a hash of the key, asset and bar so a rerun gives the same call.
 */
export function baselineCall(key: TradingBaselineKey, input: { asset: string; barCloseAt: Date; lastClose: number; previousClose: number | null }): TradingCall {
  switch (key) {
    case "baseline:always_up":
      return "up";
    case "baseline:persistence":
      return input.previousClose !== null && input.lastClose < input.previousClose ? "down" : "up";
    case "baseline:coin_flip":
      return seededRandom(fnv1a(`${key}|${input.asset}|${input.barCloseAt.toISOString()}`))() < 0.5 ? "up" : "down";
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolvablePrediction {
  direction: "up" | "down" | "flat";
  kind: "direction" | "target_before_stop";
  referencePrice: number;
  flatBandPct: number;
  barCloseAt: Date;
  resolvesAt: Date;
  targetPrice: number | null;
  stopPrice: number | null;
}

export type TradingResolution =
  | { status: "pending" }
  | { status: "resolved"; outcome: "hit" | "miss" | "flat" | "void"; realizedReturn: number | null; mfe: number | null; mae: number | null; reason?: string };

/**
 * Resolve one call from closed candles. `bars` are oldest-first closed bars of
 * the prediction's timeframe. Pending until the bar that closes at resolvesAt
 * is in `bars`; void when a bar inside the window is missing (the exchange or
 * the store has a hole, so the excursion cannot be measured honestly).
 *
 * Direction call: up wins when the return is above +flatBand, down when below
 * -flatBand, otherwise the outcome is "flat" (not a hit and not a miss).
 * MFE/MAE are measured in the called direction as fractions of the reference
 * price: favourable is >= 0, adverse is <= 0.
 */
export function resolveTradingPrediction(prediction: ResolvablePrediction, bars: readonly TradingCandle[], timeframe: TradingTimeframe): TradingResolution {
  const tf = tradingTimeframeMs(timeframe);
  const firstOpen = prediction.barCloseAt.getTime();
  const lastOpen = prediction.resolvesAt.getTime() - tf;
  const lastBar = bars[bars.length - 1];
  if (!lastBar || lastBar.openTime.getTime() < lastOpen) return { status: "pending" };
  const byOpen = new Map<number, TradingCandle>();
  for (const bar of bars) byOpen.set(bar.openTime.getTime(), bar);
  const window: TradingCandle[] = [];
  for (let t = firstOpen; t <= lastOpen; t += tf) {
    const bar = byOpen.get(t);
    if (!bar) return { status: "resolved", outcome: "void", realizedReturn: null, mfe: null, mae: null, reason: `missing_bar_${new Date(t).toISOString()}` };
    window.push(bar);
  }
  const ref = prediction.referencePrice;
  const finalClose = window[window.length - 1]!.close;
  const realizedReturn = finalClose / ref - 1;
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  const longCall = prediction.direction !== "down";
  const mfe = longCall ? Math.max(0, high / ref - 1) : Math.max(0, 1 - low / ref);
  const mae = longCall ? Math.min(0, low / ref - 1) : Math.min(0, 1 - high / ref);

  if (prediction.kind === "target_before_stop") {
    const { targetPrice: target, stopPrice: stop } = prediction;
    if (target === null || stop === null) return { status: "resolved", outcome: "void", realizedReturn, mfe, mae, reason: "levels_missing" };
    for (const bar of window) {
      const hitTarget = longCall ? bar.high >= target : bar.low <= target;
      const hitStop = longCall ? bar.low <= stop : bar.high >= stop;
      // Both inside one bar: the order is unknown, so count the stop first (the cautious reading).
      if (hitStop) return { status: "resolved", outcome: "miss", realizedReturn, mfe, mae };
      if (hitTarget) return { status: "resolved", outcome: "hit", realizedReturn, mfe, mae };
    }
    return { status: "resolved", outcome: "flat", realizedReturn, mfe, mae };
  }

  const flat = Math.abs(realizedReturn) * 100 < prediction.flatBandPct;
  let outcome: "hit" | "miss" | "flat";
  if (prediction.direction === "flat") outcome = flat ? "hit" : "miss";
  else if (flat) outcome = "flat";
  else outcome = (prediction.direction === "up") === realizedReturn > 0 ? "hit" : "miss";
  return { status: "resolved", outcome, realizedReturn, mfe, mae };
}

/**
 * Independent subset: calls whose horizon does not overlap the previous
 * independent call of the same series. Call in bar order; pass the previous
 * independent call's resolvesAt (null for the first).
 */
export function isIndependentCall(barCloseAt: Date, previousIndependentResolvesAt: Date | null): boolean {
  return previousIndependentResolvesAt === null || barCloseAt.getTime() >= previousIndependentResolvesAt.getTime();
}

/**
 * Base rate of "up" at decision time: over closed bars in the trailing window,
 * every bar whose horizon had fully closed by `cutoffAt` is classified up,
 * down or flat; the base rate is up / (up + down). Null when fewer than
 * `minCount` non-flat outcomes are known. Uses nothing from after cutoffAt.
 */
export function trailingBaseRateUp(
  bars: readonly TradingCandle[],
  timeframe: TradingTimeframe,
  horizonBars: number,
  flatBandPct: number,
  cutoffAt: Date,
  days = TRADING_BASE_RATE_DAYS,
  minCount = 30,
): { up: number; down: number; flat: number; baseRateUp: number | null } {
  const tf = tradingTimeframeMs(timeframe);
  const windowStart = cutoffAt.getTime() - days * 86_400_000;
  let up = 0;
  let down = 0;
  let flat = 0;
  for (let i = 0; i + horizonBars < bars.length; i++) {
    const start = bars[i]!;
    const end = bars[i + horizonBars]!;
    // Contiguous in time, closed by the cutoff, and inside the window.
    if (end.openTime.getTime() - start.openTime.getTime() !== horizonBars * tf) continue;
    const resolvedAt = end.openTime.getTime() + tf;
    if (resolvedAt > cutoffAt.getTime() || start.openTime.getTime() + tf < windowStart) continue;
    const ret = end.close / start.close - 1;
    if (Math.abs(ret) * 100 < flatBandPct) flat++;
    else if (ret > 0) up++;
    else down++;
  }
  return { up, down, flat, baseRateUp: up + down >= minCount ? up / (up + down) : null };
}

// ─── Metrics on predictions ─────────────────────────────────────────────────

export interface ScoredPrediction {
  forecasterKey: string;
  asset: string;
  barCloseAt: Date;
  resolvesAt: Date;
  direction: "up" | "down" | "flat";
  probability: number | null;
  outcome: "hit" | "miss" | "flat" | "void" | null;
  realizedReturn: number | null;
  independent: boolean;
  /** The trailing base rate of "up" known at decision time, if recorded. */
  baseRateUp?: number | null;
  /** Market-weather label at decision time (trend), if recorded. */
  regime?: string | null;
}

export interface HitRateSummary {
  resolved: number;
  hits: number;
  misses: number;
  flats: number;
  voids: number;
  pending: number;
  /** hits / (hits + misses); flats and voids are left out. Null when there is nothing to score. */
  hitRate: number | null;
  flatShare: number | null;
}

export function summarizeHitRate(predictions: readonly ScoredPrediction[]): HitRateSummary {
  let hits = 0;
  let misses = 0;
  let flats = 0;
  let voids = 0;
  let pending = 0;
  for (const p of predictions) {
    if (p.outcome === null) pending++;
    else if (p.outcome === "hit") hits++;
    else if (p.outcome === "miss") misses++;
    else if (p.outcome === "flat") flats++;
    else voids++;
  }
  const scored = hits + misses;
  const nonVoid = scored + flats;
  return { resolved: hits + misses + flats + voids, hits, misses, flats, voids, pending, hitRate: scored > 0 ? hits / scored : null, flatShare: nonVoid > 0 ? flats / nonVoid : null };
}

/**
 * Coverage: the share of the bars the forecaster was running for on which it
 * made a call. `barsRunning` is the running time divided by the bar length
 * (gaps excluded) times the number of coins.
 */
export function coverage(callCount: number, barsRunning: number): number | null {
  return barsRunning > 0 ? Math.min(1, callCount / barsRunning) : null;
}

/**
 * The hit rate a forecaster would get by chance given what was known when it
 * called: for each scored call, the decision-time base rate of its direction
 * (b for "up", 1 - b for "down"), averaged. Calls without a recorded base rate
 * are left out; null when none has one.
 */
export function expectedHitRateFromBaseRate(predictions: readonly ScoredPrediction[]): number | null {
  const values: number[] = [];
  for (const p of predictions) {
    if ((p.outcome !== "hit" && p.outcome !== "miss") || p.baseRateUp == null) continue;
    values.push(p.direction === "down" ? 1 - p.baseRateUp : p.baseRateUp);
  }
  return values.length > 0 ? mean(values) : null;
}

/** Share of non-flat outcomes that went up, from the realized returns (the base rate actually seen). */
export function realizedUpShare(predictions: readonly ScoredPrediction[], flatBandPct: number): number | null {
  let up = 0;
  let down = 0;
  for (const p of predictions) {
    if (p.realizedReturn === null || (p.outcome !== "hit" && p.outcome !== "miss")) continue;
    if (Math.abs(p.realizedReturn) * 100 < flatBandPct) continue;
    if (p.realizedReturn > 0) up++;
    else down++;
  }
  return up + down > 0 ? up / (up + down) : null;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export interface ProbabilityScores {
  n: number;
  brier: number;
  /** Brier score of always forecasting the decision-time base rate. Null when base rates were not recorded. */
  brierReference: number | null;
  /** 1 - brier / brierReference. Positive means better than the base-rate forecast. */
  brierSkill: number | null;
  logLoss: number;
  calibration: Array<{ bucket: number; from: number; to: number; count: number; meanForecast: number; observedUpShare: number }>;
}

/**
 * Brier score, log loss and calibration for forecasters with a real
 * probability of "up". Returns null when no call carries a probability: a
 * fixed rule's constant made-up probability would make these numbers
 * meaningless, so they are simply not computed for it.
 */
export function probabilityScores(predictions: readonly ScoredPrediction[], flatBandPct: number, buckets = 10): ProbabilityScores | null {
  const rows: Array<{ p: number; y: number; base: number | null }> = [];
  for (const q of predictions) {
    if (q.probability === null || q.realizedReturn === null) continue;
    if (q.outcome !== "hit" && q.outcome !== "miss") continue;
    if (Math.abs(q.realizedReturn) * 100 < flatBandPct) continue;
    rows.push({ p: q.probability, y: q.realizedReturn > 0 ? 1 : 0, base: q.baseRateUp ?? null });
  }
  if (rows.length === 0) return null;
  const brier = mean(rows.map((r) => (r.p - r.y) ** 2));
  const withBase = rows.filter((r) => r.base !== null);
  const brierReference = withBase.length === rows.length ? mean(rows.map((r) => (r.base! - r.y) ** 2)) : null;
  const eps = 1e-15;
  const logLoss = mean(rows.map((r) => -(r.y * Math.log(Math.min(1 - eps, Math.max(eps, r.p))) + (1 - r.y) * Math.log(Math.min(1 - eps, Math.max(eps, 1 - r.p))))));
  const calibration: ProbabilityScores["calibration"] = [];
  for (let b = 0; b < buckets; b++) {
    const from = b / buckets;
    const to = (b + 1) / buckets;
    const inBucket = rows.filter((r) => (b === buckets - 1 ? r.p >= from && r.p <= to : r.p >= from && r.p < to));
    if (inBucket.length === 0) continue;
    calibration.push({ bucket: b, from, to, count: inBucket.length, meanForecast: mean(inBucket.map((r) => r.p)), observedUpShare: mean(inBucket.map((r) => r.y)) });
  }
  return { n: rows.length, brier, brierReference, brierSkill: brierReference !== null && brierReference > 0 ? 1 - brier / brierReference : null, logLoss, calibration };
}

// ─── Independence, block bootstrap, regimes ─────────────────────────────────

/**
 * Group predictions into blocks by decision time. Coins that share a bar close
 * move together, so every call with the same barCloseAt is one block. Blocks
 * are returned in time order.
 */
export function blocksByDecisionTime<T extends { barCloseAt: Date }>(predictions: readonly T[]): T[][] {
  const map = new Map<number, T[]>();
  for (const p of predictions) {
    const key = p.barCloseAt.getTime();
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

/** Effective number of independent observations: distinct decision times among the independent calls. */
export function effectiveSampleSize(predictions: readonly ScoredPrediction[]): number {
  return blocksByDecisionTime(predictions.filter((p) => p.independent && p.outcome !== null && p.outcome !== "void")).length;
}

export interface BootstrapInterval {
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  /** Number of decision-time blocks resampled from. */
  blocks: number;
  blockLength: number;
  iterations: number;
}

/**
 * Moving-block bootstrap over decision time. Calls are grouped into blocks by
 * decision time (so coins sharing a timestamp stay together), the time-ordered
 * blocks are resampled in runs of `blockLength` consecutive blocks (default
 * the larger of the horizon and the cube root of the block count), and the
 * statistic is recomputed on each resample. Percentile interval, seeded so the
 * same data gives the same interval.
 */
export function blockBootstrapInterval<T extends { barCloseAt: Date }>(
  predictions: readonly T[],
  statistic: (sample: readonly T[]) => number | null,
  options: { horizonBars?: number; iterations?: number; confidence?: number; seed?: number; blockLength?: number } = {},
): BootstrapInterval {
  const blocks = blocksByDecisionTime(predictions);
  const estimate = predictions.length > 0 ? statistic(predictions) : null;
  const iterations = options.iterations ?? 1000;
  const blockLength = Math.max(1, options.blockLength ?? Math.max(options.horizonBars ?? 1, Math.ceil(Math.cbrt(blocks.length))));
  if (blocks.length < 2) return { estimate, lower: null, upper: null, blocks: blocks.length, blockLength, iterations: 0 };
  const rand = seededRandom(options.seed ?? 20_260_101);
  const values: number[] = [];
  const maxStart = blocks.length - 1;
  for (let it = 0; it < iterations; it++) {
    const sample: T[] = [];
    let taken = 0;
    while (taken < blocks.length) {
      const start = Math.floor(rand() * (maxStart + 1));
      for (let k = 0; k < blockLength && taken < blocks.length; k++) {
        const block = blocks[(start + k) % blocks.length]!;
        sample.push(...block);
        taken++;
      }
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return { estimate, lower: null, upper: null, blocks: blocks.length, blockLength, iterations };
  values.sort((a, b) => a - b);
  const alpha = (1 - (options.confidence ?? 0.95)) / 2;
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))]!;
  return { estimate, lower: at(alpha), upper: at(1 - alpha), blocks: blocks.length, blockLength, iterations };
}

export interface RegimeScore {
  regime: string;
  hitRate: number | null;
  scored: number;
  /** Separate regime spells (unbroken runs of the same label in time) behind this score. Labels need days to flip, so this is small. */
  spells: number;
}

/** Hit rate per market-weather label, with the number of separate spells each rests on. Calls without a label are grouped as "unlabelled". */
export function scoreByRegime(predictions: readonly ScoredPrediction[]): RegimeScore[] {
  const ordered = [...predictions].sort((a, b) => a.barCloseAt.getTime() - b.barCloseAt.getTime());
  const spells = new Map<string, number>();
  let previous: string | null = null;
  const seenTimes = new Set<number>();
  for (const p of ordered) {
    const label = p.regime ?? "unlabelled";
    const t = p.barCloseAt.getTime();
    if (seenTimes.has(t)) continue; // one label per decision time
    seenTimes.add(t);
    if (label !== previous) spells.set(label, (spells.get(label) ?? 0) + 1);
    previous = label;
  }
  const groups = new Map<string, ScoredPrediction[]>();
  for (const p of ordered) {
    const label = p.regime ?? "unlabelled";
    const list = groups.get(label);
    if (list) list.push(p);
    else groups.set(label, [p]);
  }
  return [...groups.entries()]
    .map(([regime, list]) => {
      const s = summarizeHitRate(list);
      return { regime, hitRate: s.hitRate, scored: s.hits + s.misses, spells: spells.get(regime) ?? 0 };
    })
    .sort((a, b) => a.regime.localeCompare(b.regime));
}

// ─── Trade metrics ──────────────────────────────────────────────────────────

export interface RoundTrip {
  openedAt: Date;
  closedAt: Date;
  /** Price per unit in USD. */
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  /** Fees on both fills, USD. */
  feesUsd: number;
  /** The R unit in USD per unit of the coin at entry (stop distance, or 1 ATR(14)). Null when not computable. */
  rDistance: number | null;
}

export interface TradeMetrics {
  trades: number;
  winRate: number | null;
  /** Mean net result per trade in R (after fees). Null when no trade has an R unit. */
  expectancyR: number | null;
  tradesWithR: number;
  profitFactor: number | null;
  averageWinUsd: number | null;
  averageLossUsd: number | null;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  /** Fees as % of gross profit made before fees. Null when gross is not positive. */
  feesPctOfGross: number | null;
  maxDrawdownPct: number | null;
  /** Longest stretch, ms, from an equity high to the next new high (or the end). */
  timeUnderWaterMs: number;
}

export function tradeMetrics(trades: readonly RoundTrip[], startingEquityUsd: number): TradeMetrics {
  const sorted = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  let gross = 0;
  let fees = 0;
  let winsSum = 0;
  let lossesSum = 0;
  let wins = 0;
  let losses = 0;
  const rs: number[] = [];
  let equity = startingEquityUsd;
  let peak = equity;
  let peakAt = sorted[0]?.openedAt.getTime() ?? 0;
  let maxDrawdown = 0;
  let longestUnderWater = 0;
  for (const t of sorted) {
    const g = (t.exitPrice - t.entryPrice) * t.quantity;
    const net = g - t.feesUsd;
    gross += g;
    fees += t.feesUsd;
    if (net > 0) {
      wins++;
      winsSum += net;
    } else if (net < 0) {
      losses++;
      lossesSum += net;
    }
    if (t.rDistance !== null && t.rDistance > 0 && t.quantity > 0) rs.push(net / (t.quantity * t.rDistance));
    equity += net;
    if (equity >= peak) {
      longestUnderWater = Math.max(longestUnderWater, t.closedAt.getTime() - peakAt);
      peak = equity;
      peakAt = t.closedAt.getTime();
    } else if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  const last = sorted[sorted.length - 1];
  if (last && equity < peak) longestUnderWater = Math.max(longestUnderWater, last.closedAt.getTime() - peakAt);
  const count = sorted.length;
  return {
    trades: count,
    winRate: count > 0 ? wins / count : null,
    expectancyR: rs.length > 0 ? mean(rs) : null,
    tradesWithR: rs.length,
    profitFactor: lossesSum < 0 ? winsSum / -lossesSum : null,
    averageWinUsd: wins > 0 ? winsSum / wins : null,
    averageLossUsd: losses > 0 ? lossesSum / losses : null,
    grossPnlUsd: gross,
    feesUsd: fees,
    netPnlUsd: gross - fees,
    feesPctOfGross: gross > 0 ? (fees / gross) * 100 : null,
    maxDrawdownPct: count > 0 ? maxDrawdown * 100 : null,
    timeUnderWaterMs: longestUnderWater,
  };
}

/** Annualised Sharpe and Sortino from daily returns, on a 365-day year (crypto trades every day). Sortino's downside deviation is against a 0 target. */
export function riskAdjustedReturns(dailyReturns: readonly number[]): { sharpe: number | null; sortino: number | null } {
  if (dailyReturns.length < 2) return { sharpe: null, sortino: null };
  const m = mean(dailyReturns);
  const variance = dailyReturns.reduce((acc, r) => acc + (r - m) ** 2, 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  const downside = Math.sqrt(dailyReturns.reduce((acc, r) => acc + Math.min(0, r) ** 2, 0) / dailyReturns.length);
  const k = Math.sqrt(365);
  return { sharpe: sd > 0 ? (m / sd) * k : null, sortino: downside > 0 ? (m / downside) * k : null };
}

/** Strategy return against holding the coin over the same period: both as fractions, and the difference. */
export function returnVsBuyAndHold(strategyReturn: number, firstPrice: number, lastPrice: number): { strategy: number; buyAndHold: number; difference: number } {
  const buyAndHold = lastPrice / firstPrice - 1;
  return { strategy: strategyReturn, buyAndHold, difference: strategyReturn - buyAndHold };
}

// ─── Running time and the verdict ───────────────────────────────────────────

export interface GapInterval {
  from: Date;
  to: Date;
}

/** Running time = calendar time from `start` to `end` minus the time covered by gap events (overlaps counted once). */
export function runningTimeMs(start: Date, end: Date, gaps: readonly GapInterval[]): { runningMs: number; calendarMs: number; gapMs: number } {
  const calendarMs = Math.max(0, end.getTime() - start.getTime());
  const clipped = gaps
    .map((g) => ({ from: Math.max(g.from.getTime(), start.getTime()), to: Math.min(g.to.getTime(), end.getTime()) }))
    .filter((g) => g.to > g.from)
    .sort((a, b) => a.from - b.from);
  let gapMs = 0;
  let cursor = -Infinity;
  for (const g of clipped) {
    const from = Math.max(g.from, cursor);
    if (g.to > from) gapMs += g.to - from;
    cursor = Math.max(cursor, g.to);
  }
  return { runningMs: calendarMs - gapMs, calendarMs, gapMs };
}

export interface VerdictPlan {
  targetSamples: number;
  minRunningDays: number;
}

export function verdictPlanOf(prediction: { targetSamples?: number; minRunningDays?: number } | undefined): VerdictPlan {
  return { targetSamples: prediction?.targetSamples ?? TRADING_DEFAULT_TARGET_SAMPLES, minRunningDays: prediction?.minRunningDays ?? TRADING_DEFAULT_MIN_RUNNING_DAYS };
}

export type VerdictStatus = { status: "collecting"; samples: number; targetSamples: number; runningMs: number; minRunningMs: number; calendarMs: number } | { status: "ready"; samples: number; targetSamples: number; runningMs: number; minRunningMs: number; calendarMs: number };

/**
 * "Collecting: x of N, no verdict yet" until BOTH the planned sample size and
 * the minimum running time are met, and nothing about the hit rate is part of
 * this status. Only 'ready' lets the verdict be computed, and only once.
 */
export function verdictStatus(input: { independentResolved: number; runningMs: number; calendarMs: number; plan: VerdictPlan }): VerdictStatus {
  const minRunningMs = input.plan.minRunningDays * 86_400_000;
  const reached = input.independentResolved >= input.plan.targetSamples && input.runningMs >= minRunningMs;
  return { status: reached ? "ready" : "collecting", samples: input.independentResolved, targetSamples: input.plan.targetSamples, runningMs: input.runningMs, minRunningMs, calendarMs: input.calendarMs };
}

export interface VerdictResult {
  result: "edge_in_direction" | "no_edge";
  hitRate: number | null;
  expectedHitRate: number | null;
  /** Lower end of the interval on (hit rate - expected hit rate). Above 0 means the edge over the base rate is not explained by luck. */
  excessLower: number | null;
  excessUpper: number | null;
  bestBaselineKey: string | null;
  bestBaselineHitRate: number | null;
  beatsBaselines: boolean;
}

/**
 * The verdict, computed once. An edge in direction needs the 90% one-sided
 * lower bound (5th percentile) of the hit rate above the decision-time base
 * rate to be positive AND the hit rate to beat every baseline on the same
 * bars. Anything else is "no edge found": a correct and useful result.
 */
export function computeTradingVerdict(input: {
  independentCalls: readonly ScoredPrediction[];
  baselinesOnSameBars: Readonly<Record<string, number | null>>;
  horizonBars: number;
  iterations?: number;
  seed?: number;
}): VerdictResult {
  const calls = input.independentCalls.filter((p) => p.outcome === "hit" || p.outcome === "miss");
  const excess = (sample: readonly ScoredPrediction[]) => {
    const h = summarizeHitRate(sample).hitRate;
    const e = expectedHitRateFromBaseRate(sample);
    return h === null || e === null ? null : h - e;
  };
  const interval = blockBootstrapInterval(calls, excess, { horizonBars: input.horizonBars, iterations: input.iterations, seed: input.seed, confidence: 0.9 });
  const hitRate = summarizeHitRate(calls).hitRate;
  let bestKey: string | null = null;
  let bestRate: number | null = null;
  for (const [key, rate] of Object.entries(input.baselinesOnSameBars)) {
    if (rate !== null && (bestRate === null || rate > bestRate)) {
      bestKey = key;
      bestRate = rate;
    }
  }
  const beats = hitRate !== null && (bestRate === null || hitRate > bestRate);
  return {
    result: interval.lower !== null && interval.lower > 0 && beats ? "edge_in_direction" : "no_edge",
    hitRate,
    expectedHitRate: expectedHitRateFromBaseRate(calls),
    excessLower: interval.lower,
    excessUpper: interval.upper,
    bestBaselineKey: bestKey,
    bestBaselineHitRate: bestRate,
    beatsBaselines: beats,
  };
}
