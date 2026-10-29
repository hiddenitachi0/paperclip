/**
 * DUR-5002: the indicator allow-list for StrategySpec v2.
 *
 * Our own implementations of textbook indicators (SMA, EMA, Wilder RSI/ATR/ADX,
 * Bollinger width, Donchian, anchored VWAP, relative volume, rate of change,
 * swing high/low). They are pure functions over plain number arrays, written
 * from the published definitions, with no code taken from any AGPL or GPL
 * project. packages/shared/src/trading-indicators.test.ts pins them against
 * reference values produced by the MIT-licensed `trading-signals` package
 * (used only to generate those numbers, never imported here) and against the
 * classic worked RSI example.
 *
 * Every function returns a series with the same length as its input: `null`
 * until the indicator has enough bars, then a number. No function reads a
 * clock, randomness or anything outside its arguments.
 */

export type Series = Array<number | null>;

/** The OHLCV shape the indicators read; the engine's bars satisfy it. */
export interface IndicatorBar {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function smaSeries(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values, smoothing 2 / (period + 1). */
export function emaSeries(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let ema = seed / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Wilder's smoothing (RMA) seeded with the mean of the first `period` values. */
function wilderSmooth(values: readonly number[], period: number, startIndex: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1 || values.length - startIndex < period) return out;
  let sum = 0;
  for (let i = startIndex; i < startIndex + period; i++) sum += values[i]!;
  let prev = sum / period;
  out[startIndex + period - 1] = prev;
  for (let i = startIndex + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI: first value after `period` changes, then Wilder-smoothed gains and losses. */
export function rsiSeries(closes: readonly number[], period: number): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (period < 1 || closes.length <= period) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  const avgGain = wilderSmooth(gains, period, 1);
  const avgLoss = wilderSmooth(losses, period, 1);
  for (let i = period; i < closes.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || g === undefined || l === null || l === undefined) continue;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

function trueRanges(bars: readonly IndicatorBar[]): number[] {
  return bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close))));
}

/** Wilder's ATR: the first value is the mean of the first `period` true ranges. */
export function atrSeries(bars: readonly IndicatorBar[], period: number): Series {
  return wilderSmooth(trueRanges(bars), period, 0);
}

/** Wilder's ADX (with +DI/-DI smoothing over `period`); first value after 2 * period - 1 bars. */
export function adxSeries(bars: readonly IndicatorBar[], period: number): Series {
  const n = bars.length;
  const out: Series = new Array(n).fill(null);
  if (period < 1 || n < period * 2) return out;
  const tr: number[] = [0];
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i]!.high - bars[i - 1]!.high;
    const down = bars[i - 1]!.low - bars[i]!.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(bars[i]!.high - bars[i]!.low, Math.abs(bars[i]!.high - bars[i - 1]!.close), Math.abs(bars[i]!.low - bars[i - 1]!.close)));
  }
  // Wilder sums: seed with the plain sum of the first `period` values, then sum - sum / period + value.
  const smoothSum = (values: number[]): Series => {
    const s: Series = new Array(n).fill(null);
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += values[i]!;
    s[period] = sum;
    for (let i = period + 1; i < n; i++) {
      sum = sum - sum / period + values[i]!;
      s[i] = sum;
    }
    return s;
  };
  const trS = smoothSum(tr);
  const plusS = smoothSum(plusDm);
  const minusS = smoothSum(minusDm);
  const dx: number[] = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    const t = trS[i]!;
    if (t === 0) continue;
    const plusDi = (100 * plusS[i]!) / t;
    const minusDi = (100 * minusS[i]!) / t;
    const total = plusDi + minusDi;
    dx[i] = total === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / total;
  }
  const first = period * 2 - 1;
  if (n <= first) return out;
  let adx = 0;
  for (let i = period; i <= first; i++) adx += dx[i]!;
  adx /= period;
  out[first] = adx;
  for (let i = first + 1; i < n; i++) {
    adx = (adx * (period - 1) + dx[i]!) / period;
    out[i] = adx;
  }
  return out;
}

/** Bollinger band width as a fraction of the middle band: (upper - lower) / middle, population standard deviation. */
export function bbWidthSeries(closes: readonly number[], period: number, stdDev: number): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (period < 2 || closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j]! - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    out[i] = mean === 0 ? null : (2 * stdDev * sd) / mean;
  }
  return out;
}

export type DonchianBand = "upper" | "lower" | "mid";

/** Donchian channel over the last `period` bars including the current one. */
export function donchianSeries(bars: readonly IndicatorBar[], period: number, band: DonchianBand): Series {
  const out: Series = new Array(bars.length).fill(null);
  if (period < 1 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j]!.high > hi) hi = bars[j]!.high;
      if (bars[j]!.low < lo) lo = bars[j]!.low;
    }
    out[i] = band === "upper" ? hi : band === "lower" ? lo : (hi + lo) / 2;
  }
  return out;
}

/** Highest high of the `lookback` bars BEFORE the current one (the current bar never counts as its own swing). */
export function swingHighSeries(bars: readonly IndicatorBar[], lookback: number): Series {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = lookback; i < bars.length; i++) {
    let hi = -Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j]!.high > hi) hi = bars[j]!.high;
    out[i] = hi;
  }
  return out;
}

/** Lowest low of the `lookback` bars BEFORE the current one. */
export function swingLowSeries(bars: readonly IndicatorBar[], lookback: number): Series {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = lookback; i < bars.length; i++) {
    let lo = Infinity;
    for (let j = i - lookback; j < i; j++) if (bars[j]!.low < lo) lo = bars[j]!.low;
    out[i] = lo;
  }
  return out;
}

/** Rate of change in percent: (close - close[period ago]) / close[period ago] * 100. */
export function rocSeries(closes: readonly number[], period: number): Series {
  const out: Series = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period]!;
    out[i] = base === 0 ? null : ((closes[i]! - base) / base) * 100;
  }
  return out;
}

/** Volume divided by the mean volume of the `period` bars before it. */
export function rvolSeries(volumes: readonly number[], period: number): Series {
  const out: Series = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += volumes[j]!;
    const mean = sum / period;
    out[i] = mean === 0 ? null : volumes[i]! / mean;
  }
  return out;
}

export type VwapAnchor = "utc_day" | "swing";

/** Bars the swing anchor looks back over to find the lowest low it anchors to. */
export const VWAP_SWING_ANCHOR_LOOKBACK = 50;

/**
 * Volume-weighted average price on the typical price (high + low + close) / 3.
 * "utc_day" restarts at each UTC midnight. "swing" is anchored at the bar with
 * the lowest low among the previous VWAP_SWING_ANCHOR_LOOKBACK bars (re-chosen
 * at every bar, so it is a function of the trailing window only).
 */
export function vwapSeries(bars: readonly IndicatorBar[], anchor: VwapAnchor): Series {
  const out: Series = new Array(bars.length).fill(null);
  const typical = (b: IndicatorBar) => (b.high + b.low + b.close) / 3;
  if (anchor === "utc_day") {
    let pv = 0;
    let vol = 0;
    let day = "";
    for (let i = 0; i < bars.length; i++) {
      const d = bars[i]!.openTime.toISOString().slice(0, 10);
      if (d !== day) {
        day = d;
        pv = 0;
        vol = 0;
      }
      pv += typical(bars[i]!) * bars[i]!.volume;
      vol += bars[i]!.volume;
      out[i] = vol === 0 ? null : pv / vol;
    }
    return out;
  }
  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - VWAP_SWING_ANCHOR_LOOKBACK + 1);
    let anchorIdx = from;
    for (let j = from; j <= i; j++) if (bars[j]!.low < bars[anchorIdx]!.low) anchorIdx = j;
    let pv = 0;
    let vol = 0;
    for (let j = anchorIdx; j <= i; j++) {
      pv += typical(bars[j]!) * bars[j]!.volume;
      vol += bars[j]!.volume;
    }
    out[i] = vol === 0 ? null : pv / vol;
  }
  return out;
}
