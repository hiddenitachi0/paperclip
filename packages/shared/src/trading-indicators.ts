import type { TradingCandle } from "./trading.js";

/**
 * DUR-5002: the indicator allow-list of the strategy rule book (StrategySpec
 * v2, trading-spec.ts). Every function here is pure and deterministic: same
 * bars in, same numbers out, no clock, no I/O, no randomness. The code is our
 * own (no third-party indicator library, nothing copied from AGPL/GPL
 * projects); the formulas are the textbook ones (Wilder smoothing for RSI,
 * ATR and ADX) and are pinned to hand-computed reference values in
 * trading-indicators.test.ts.
 *
 * Each series function returns one entry per input bar, `null` while the
 * indicator has not got enough bars yet. Bars are oldest-first CLOSED bars.
 */

export type IndicatorSeries = Array<number | null>;

type Bar = Pick<TradingCandle, "openTime" | "open" | "high" | "low" | "close" | "volume">;

function nulls(length: number): IndicatorSeries {
  return new Array<number | null>(length).fill(null);
}

export function smaSeries(values: readonly number[], period: number): IndicatorSeries {
  const out = nulls(values.length);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Seeded with the SMA of the first `period` values, then k = 2 / (period + 1). */
export function emaSeries(values: readonly number[], period: number): IndicatorSeries {
  const out = nulls(values.length);
  if (period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. First average gain/loss is the plain mean of the first `period` changes. A flat series (no gains, no losses) is 50. */
export function rsiSeries(closes: readonly number[], period: number): IndicatorSeries {
  const out = nulls(closes.length);
  if (period < 1 || closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function trueRanges(bars: readonly Bar[]): number[] {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1]!.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });
}

/** Wilder's ATR. The first value (at index period - 1) is the mean of the first `period` true ranges; the first true range is high - low. */
export function atrSeries(bars: readonly Bar[], period: number): IndicatorSeries {
  const out = nulls(bars.length);
  if (period < 1 || bars.length < period) return out;
  const tr = trueRanges(bars);
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i]!;
  atr /= period;
  out[period - 1] = atr;
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

export interface AdxSeries {
  adx: IndicatorSeries;
  plusDi: IndicatorSeries;
  minusDi: IndicatorSeries;
}

/** Wilder's ADX with +DI / -DI. DI values start at index `period`; the first ADX (mean of the first `period` DX values) is at index 2 * period - 1. */
export function adxSeries(bars: readonly Bar[], period: number): AdxSeries {
  const n = bars.length;
  const adx = nulls(n);
  const plusDi = nulls(n);
  const minusDi = nulls(n);
  if (period < 1 || n < period + 1) return { adx, plusDi, minusDi };
  const tr = trueRanges(bars);
  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i]!.high - bars[i - 1]!.high;
    const down = bars[i - 1]!.low - bars[i]!.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTr += tr[i]!;
    smPlus += plusDm[i]!;
    smMinus += minusDm[i]!;
  }
  const dx: Array<number | null> = nulls(n);
  const record = (i: number) => {
    const pdi = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const mdi = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  };
  record(period);
  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i]!;
    smPlus = smPlus - smPlus / period + plusDm[i]!;
    smMinus = smMinus - smMinus / period + minusDm[i]!;
    record(i);
  }
  if (n >= 2 * period) {
    let sum = 0;
    for (let i = period; i < 2 * period; i++) sum += dx[i]!;
    let value = sum / period;
    adx[2 * period - 1] = value;
    for (let i = 2 * period; i < n; i++) {
      value = (value * (period - 1) + dx[i]!) / period;
      adx[i] = value;
    }
  }
  return { adx, plusDi, minusDi };
}

/** (upper - lower) / middle of Bollinger bands, i.e. 2 * k * population standard deviation / SMA. */
export function bbWidthSeries(closes: readonly number[], period: number, stdDev: number): IndicatorSeries {
  const out = nulls(closes.length);
  if (period < 2 || closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j]! - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    out[i] = mean === 0 ? null : (2 * stdDev * sd) / mean;
  }
  return out;
}

/** Donchian channel over the `period` bars BEFORE the current one (the current bar is excluded, so a close above the upper band is a real breakout). */
export function donchianSeries(bars: readonly Bar[], period: number, band: "upper" | "lower" | "mid"): IndicatorSeries {
  const out = nulls(bars.length);
  if (period < 1) return out;
  for (let i = period; i < bars.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period; j < i; j++) {
      high = Math.max(high, bars[j]!.high);
      low = Math.min(low, bars[j]!.low);
    }
    out[i] = band === "upper" ? high : band === "lower" ? low : (high + low) / 2;
  }
  return out;
}

/** Highest high over the last `lookback` bars, INCLUDING the current bar. */
export function swingHighSeries(bars: readonly Bar[], lookback: number): IndicatorSeries {
  const out = nulls(bars.length);
  for (let i = lookback - 1; i < bars.length; i++) {
    let high = -Infinity;
    for (let j = i - lookback + 1; j <= i; j++) high = Math.max(high, bars[j]!.high);
    out[i] = high;
  }
  return out;
}

/** Lowest low over the last `lookback` bars, INCLUDING the current bar. */
export function swingLowSeries(bars: readonly Bar[], lookback: number): IndicatorSeries {
  const out = nulls(bars.length);
  for (let i = lookback - 1; i < bars.length; i++) {
    let low = Infinity;
    for (let j = i - lookback + 1; j <= i; j++) low = Math.min(low, bars[j]!.low);
    out[i] = low;
  }
  return out;
}

function utcDayKey(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

/**
 * Volume-weighted average price of the typical price ((h + l + c) / 3).
 *  - utc_day: restarts at 00:00 UTC.
 *  - swing: anchored at the lowest low of the last `lookback` bars (the latest one on a tie).
 * Null while the cumulative volume is zero.
 */
export function vwapSeries(bars: readonly Bar[], anchor: "utc_day" | "swing", lookback = 20): IndicatorSeries {
  const out = nulls(bars.length);
  const typical = (bar: Bar) => (bar.high + bar.low + bar.close) / 3;
  if (anchor === "utc_day") {
    let day = Number.NaN;
    let pv = 0;
    let volume = 0;
    for (let i = 0; i < bars.length; i++) {
      const key = utcDayKey(bars[i]!.openTime);
      if (key !== day) {
        day = key;
        pv = 0;
        volume = 0;
      }
      pv += typical(bars[i]!) * bars[i]!.volume;
      volume += bars[i]!.volume;
      out[i] = volume > 0 ? pv / volume : null;
    }
    return out;
  }
  for (let i = lookback - 1; i < bars.length; i++) {
    let anchorIndex = i - lookback + 1;
    for (let j = anchorIndex; j <= i; j++) if (bars[j]!.low <= bars[anchorIndex]!.low) anchorIndex = j;
    let pv = 0;
    let volume = 0;
    for (let j = anchorIndex; j <= i; j++) {
      pv += typical(bars[j]!) * bars[j]!.volume;
      volume += bars[j]!.volume;
    }
    out[i] = volume > 0 ? pv / volume : null;
  }
  return out;
}

/** Relative volume: this bar's volume divided by the mean volume of the `period` bars before it. Null when that mean is zero. */
export function rvolSeries(volumes: readonly number[], period: number): IndicatorSeries {
  const out = nulls(volumes.length);
  for (let i = period; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += volumes[j]!;
    const mean = sum / period;
    out[i] = mean > 0 ? volumes[i]! / mean : null;
  }
  return out;
}

/** Rate of change in percent: (close / close `period` bars ago - 1) * 100. */
export function rocSeries(closes: readonly number[], period: number): IndicatorSeries {
  const out = nulls(closes.length);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period]!;
    out[i] = base === 0 ? null : (closes[i]! / base - 1) * 100;
  }
  return out;
}
