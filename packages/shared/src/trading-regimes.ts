import { TRADING_ASSETS, type TradingAsset } from "./trading.js";

/**
 * Market weather (DUR-5013): one plain label per coin per day, computed from
 * CLOSED daily bars only.
 *
 * Everything here is pure (no clock, no database) so the same code backs the
 * scheduler, the tests and any future past-data test. The two rules that make
 * the labels safe to use as a prediction input:
 *
 *   1. Causal: the label for day D is a function of the bars up to and
 *      including D and nothing after it. Cutting the history at D and
 *      recomputing gives the identical label (tested).
 *   2. Available when the day closes: a label for day D carries
 *      `availableAt` = the close of D (= the open of D+1). A decision made at
 *      time T may read only a label whose `availableAt <= T`, so an intraday
 *      decision on day D reads D-1's label (`latestAvailableRegime`).
 */

export const TRADING_REGIME_RULES_VERSION = 1;

export const TRADING_REGIME_TRENDS = ["uptrend", "downtrend", "ranging"] as const;
export type TradingRegimeTrend = (typeof TRADING_REGIME_TRENDS)[number];
export const TRADING_REGIME_VOLATILITIES = ["low", "normal", "high"] as const;
export type TradingRegimeVolatility = (typeof TRADING_REGIME_VOLATILITIES)[number];

/** The thresholds from the card, in one place. */
export const TRADING_REGIME_PARAMS = {
  smaDays: 200,
  adxDays: 14,
  /** ADX above this is trending, below `adxRangingBelow` is ranging, in between keeps the current state. */
  adxTrendingAbove: 25,
  adxRangingBelow: 20,
  atrDays: 14,
  bollingerDays: 20,
  bollingerDeviations: 2,
  /** Percentiles are taken over this many closed days, today included. A label needs a full window. */
  percentileWindowDays: 365,
  volLowBelow: 30,
  volHighAbove: 70,
  squeezeBelow: 20,
  /** A flip needs this many closed days in a row that agree on the new state. */
  hysteresisDays: 3,
  /** A hole of more than this many missing days restarts the indicators. */
  maxFillableGapDays: 5,
} as const;

const DAY_MS = 86_400_000;

export interface RegimeBar {
  /** Open time of the daily bar (00:00 UTC). */
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradingRegimeLabel {
  /** The day the bar opened (UTC date, `YYYY-MM-DD`). */
  day: string;
  /** The close of that day: nothing decided before this may read the label. */
  availableAt: Date;
  trend: TradingRegimeTrend;
  volatility: TradingRegimeVolatility;
  squeeze: boolean;
  /** The numbers behind the label, for the "why" in the UI and for debugging. */
  close: number;
  sma200: number;
  adx: number;
  atrPct: number;
  atrPctPercentile: number;
  bbWidthPercentile: number;
  /** 1-based number of the spell (a run of days with the same trend + volatility + squeeze) this day is in. */
  spellNo: number;
  /** Day the current spell began (`YYYY-MM-DD`). */
  spellStartDay: string;
}

export function regimeDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The close of a daily bar. */
export function regimeAvailableAt(openTime: Date): Date {
  return new Date(openTime.getTime() + DAY_MS);
}

// ─── Indicators (each value uses only bars up to its own index) ───

/** Wilder's ADX; `adx[i]` is null until 2*period bars exist. */
export function wilderAdx(bars: readonly RegimeBar[], period: number): Array<number | null> {
  const out: Array<number | null> = bars.map(() => null);
  if (bars.length < period * 2) return out;
  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  let dxSum = 0;
  let adx = 0;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    const plus = upMove > downMove && upMove > 0 ? upMove : 0;
    const minus = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    if (i <= period) {
      smTr += tr;
      smPlus += plus;
      smMinus += minus;
    } else {
      smTr = smTr - smTr / period + tr;
      smPlus = smPlus - smPlus / period + plus;
      smMinus = smMinus - smMinus / period + minus;
    }
    if (i < period) continue;
    const plusDi = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const minusDi = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    const sum = plusDi + minusDi;
    const dx = sum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sum;
    if (i < period * 2 - 1) {
      dxSum += dx;
    } else if (i === period * 2 - 1) {
      dxSum += dx;
      adx = dxSum / period;
      out[i] = adx;
    } else {
      adx = (adx * (period - 1) + dx) / period;
      out[i] = adx;
    }
  }
  return out;
}

/** ATR as a percent of the close (Wilder smoothing); null until `period` true ranges exist. */
export function atrPercent(bars: readonly RegimeBar[], period: number): Array<number | null> {
  const out: Array<number | null> = bars.map(() => null);
  let atr = 0;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    if (i < period) atr += tr;
    else if (i === period) {
      atr = (atr + tr) / period;
      out[i] = (atr / cur.close) * 100;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      out[i] = (atr / cur.close) * 100;
    }
  }
  return out;
}

function simpleMovingAverage(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Bollinger band width: (upper - lower) / middle, population standard deviation. */
export function bollingerWidth(closes: readonly number[], period: number, deviations: number): Array<number | null> {
  const mean = simpleMovingAverage(closes, period);
  return closes.map((_, i) => {
    const mid = mean[i];
    if (mid === null || mid === undefined || mid === 0) return null;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j]! - mid) ** 2;
    return (2 * deviations * Math.sqrt(variance / period)) / mid;
  });
}

/**
 * Percent of the trailing window (today included) that is below today's value,
 * counting ties as half. Null until `window` values exist.
 */
export function trailingPercentile(values: ReadonlyArray<number | null>, window: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  for (let i = 0; i < values.length; i++) {
    const today = values[i];
    if (today === null || today === undefined || i < window - 1) continue;
    let less = 0;
    let equal = 0;
    let complete = true;
    for (let j = i - window + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || v === undefined) {
        complete = false;
        break;
      }
      if (v < today) less += 1;
      else if (v === today) equal += 1;
    }
    if (complete) out[i] = ((less + equal / 2) / window) * 100;
  }
  return out;
}

// ─── Hysteresis ───

/**
 * Holds a state until `needed` closed days in a row agree on a different one.
 * `next` may be null (no opinion: the dead zone), which keeps the state and
 * clears any pending flip. The first non-null value is adopted at once.
 */
export function hysteresisMachine<T>(needed: number): (next: T | null) => T | null {
  let state: T | null = null;
  let pending: T | null = null;
  let pendingDays = 0;
  return (next) => {
    if (next === null) {
      pending = null;
      pendingDays = 0;
      return state;
    }
    if (state === null || next === state) {
      state = state ?? next;
      pending = null;
      pendingDays = 0;
      return state;
    }
    if (pending === next) pendingDays += 1;
    else {
      pending = next;
      pendingDays = 1;
    }
    if (pendingDays >= needed) {
      state = next;
      pending = null;
      pendingDays = 0;
    }
    return state;
  };
}

// ─── The label series ───

/** Splits ascending daily bars into runs where no more than `maxFillableGapDays` days are missing. */
function contiguousRuns(bars: readonly RegimeBar[]): RegimeBar[][] {
  const runs: RegimeBar[][] = [];
  let current: RegimeBar[] = [];
  for (const bar of bars) {
    const last = current[current.length - 1];
    if (last) {
      const missing = Math.round((bar.openTime.getTime() - last.openTime.getTime()) / DAY_MS) - 1;
      if (missing < 0) continue; // out of order or duplicate: ignore, never reorder
      if (missing > TRADING_REGIME_PARAMS.maxFillableGapDays) {
        runs.push(current);
        current = [];
      }
    }
    current.push(bar);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function rawTrend(close: number, sma: number, adx: number): TradingRegimeTrend | null {
  const p = TRADING_REGIME_PARAMS;
  if (adx > p.adxTrendingAbove) return close >= sma ? "uptrend" : "downtrend";
  if (adx < p.adxRangingBelow) return "ranging";
  return null;
}

function rawVolatility(percentile: number): TradingRegimeVolatility {
  const p = TRADING_REGIME_PARAMS;
  if (percentile < p.volLowBelow) return "low";
  if (percentile > p.volHighAbove) return "high";
  return "normal";
}

/**
 * The daily label series for one coin. `bars` are CLOSED daily bars, oldest
 * first. A day gets a label only once every input has a full window (200 days
 * for the average, 365 for the percentiles), so a young coin starts labelled
 * about 14 months after it begins trading.
 */
export function computeRegimeLabels(bars: readonly RegimeBar[]): TradingRegimeLabel[] {
  const p = TRADING_REGIME_PARAMS;
  const labels: TradingRegimeLabel[] = [];
  let spellNo = 0;
  let spellStartDay = "";
  let spellKey = "";
  for (const run of contiguousRuns(bars)) {
    const closes = run.map((b) => b.close);
    const sma = simpleMovingAverage(closes, p.smaDays);
    const adx = wilderAdx(run, p.adxDays);
    const atr = atrPercent(run, p.atrDays);
    const atrPctile = trailingPercentile(atr, p.percentileWindowDays);
    const width = bollingerWidth(closes, p.bollingerDays, p.bollingerDeviations);
    const widthPctile = trailingPercentile(width, p.percentileWindowDays);
    const trendState = hysteresisMachine<TradingRegimeTrend>(p.hysteresisDays);
    const volState = hysteresisMachine<TradingRegimeVolatility>(p.hysteresisDays);
    const squeezeState = hysteresisMachine<boolean>(p.hysteresisDays);
    // A new run (after a long hole) starts its own spell; the state machines restart with it.
    spellKey = "";
    for (let i = 0; i < run.length; i++) {
      const s = sma[i];
      const a = adx[i];
      const ap = atrPctile[i];
      const wp = widthPctile[i];
      const atrToday = atr[i];
      if (s == null || a == null || ap == null || wp == null || atrToday == null) continue;
      const trend = trendState(rawTrend(run[i]!.close, s, a));
      const volatility = volState(rawVolatility(ap));
      const squeeze = squeezeState(wp < p.squeezeBelow);
      if (trend === null || volatility === null || squeeze === null) continue;
      const day = regimeDayOf(run[i]!.openTime);
      const key = `${trend}|${volatility}|${squeeze}`;
      if (key !== spellKey) {
        spellNo += 1;
        spellStartDay = day;
        spellKey = key;
      }
      labels.push({
        day,
        availableAt: regimeAvailableAt(run[i]!.openTime),
        trend,
        volatility,
        squeeze,
        close: run[i]!.close,
        sma200: s,
        adx: a,
        atrPct: atrToday,
        atrPctPercentile: ap,
        bbWidthPercentile: wp,
        spellNo,
        spellStartDay,
      });
    }
  }
  return labels;
}

// ─── Reading labels without peeking ───

/**
 * The newest label a decision made at `decisionAt` may read: the one with the
 * latest `availableAt <= decisionAt`. A decision at 12:00 on day D therefore
 * gets D-1's label, never D's (D's label is only available at D+1 00:00).
 * Works on any ascending-or-not list; does not trust the caller's order.
 */
export function latestAvailableRegime<T extends { availableAt: Date }>(labels: readonly T[], decisionAt: Date): T | null {
  let best: T | null = null;
  for (const label of labels) {
    if (label.availableAt.getTime() > decisionAt.getTime()) continue;
    if (!best || label.availableAt.getTime() > best.availableAt.getTime()) best = label;
  }
  return best;
}

export interface TradingRegimeSpell {
  spellNo: number;
  startDay: string;
  endDay: string;
  days: number;
  trend: TradingRegimeTrend;
  volatility: TradingRegimeVolatility;
  squeeze: boolean;
}

/** Collapses a label series into its spells (oldest first). */
export function regimeSpells(labels: ReadonlyArray<Pick<TradingRegimeLabel, "day" | "trend" | "volatility" | "squeeze" | "spellNo">>): TradingRegimeSpell[] {
  const spells: TradingRegimeSpell[] = [];
  for (const label of labels) {
    const last = spells[spells.length - 1];
    if (last && last.spellNo === label.spellNo) {
      last.endDay = label.day;
      last.days += 1;
    } else {
      spells.push({ spellNo: label.spellNo, startDay: label.day, endDay: label.day, days: 1, trend: label.trend, volatility: label.volatility, squeeze: label.squeeze });
    }
  }
  return spells;
}

export interface TradingRegimeFlipCounts {
  spells: number;
  trend: number;
  volatility: number;
  squeeze: number;
  days: number;
}

/** How often each part of the label changed over the series: the "are flips reasonable" check. */
export function regimeFlipCounts(labels: ReadonlyArray<Pick<TradingRegimeLabel, "trend" | "volatility" | "squeeze" | "spellNo">>): TradingRegimeFlipCounts {
  const counts: TradingRegimeFlipCounts = { spells: 0, trend: 0, volatility: 0, squeeze: 0, days: labels.length };
  const seen = new Set<number>();
  labels.forEach((label, i) => {
    seen.add(label.spellNo);
    const prev = labels[i - 1];
    if (!prev || prev.spellNo === label.spellNo) return;
    if (prev.trend !== label.trend) counts.trend += 1;
    if (prev.volatility !== label.volatility) counts.volatility += 1;
    if (prev.squeeze !== label.squeeze) counts.squeeze += 1;
  });
  counts.spells = seen.size;
  return counts;
}

// ─── UI-ready text ───

export const TRADING_ASSET_NAMES: Readonly<Record<TradingAsset, string>> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
  BNB: "BNB",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  TRX: "TRON",
  AVAX: "Avalanche",
  DOT: "Polkadot",
  LINK: "Chainlink",
  LTC: "Litecoin",
};

const TREND_WORDS: Record<TradingRegimeTrend, string> = { uptrend: "uptrend", downtrend: "downtrend", ranging: "sideways" };
const VOLATILITY_WORDS: Record<TradingRegimeVolatility, string> = { low: "calm swings", normal: "normal swings", high: "big swings" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `12 Oct`, or `12 Oct 2025` when the day is not in the same year as `now`. */
export function formatRegimeDay(day: string, now: Date): string {
  const [y, m, d] = day.split("-").map(Number);
  const text = `${d} ${MONTHS[(m ?? 1) - 1]}`;
  return y === now.getUTCFullYear() ? text : `${text} ${y}`;
}

/** e.g. `Bitcoin: uptrend, normal swings, since 12 Oct`. */
export function describeRegime(
  asset: TradingAsset,
  label: Pick<TradingRegimeLabel, "trend" | "volatility" | "squeeze" | "spellStartDay">,
  now: Date,
): string {
  const parts = [TREND_WORDS[label.trend], VOLATILITY_WORDS[label.volatility]];
  if (label.squeeze) parts.push("squeezing (quiet before a possible big move)");
  return `${TRADING_ASSET_NAMES[asset]}: ${parts.join(", ")}, since ${formatRegimeDay(label.spellStartDay, now)}`;
}

export function isTradingRegimeAsset(value: string): value is TradingAsset {
  return (TRADING_ASSETS as readonly string[]).includes(value);
}
