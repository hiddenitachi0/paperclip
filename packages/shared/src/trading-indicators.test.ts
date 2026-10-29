import { describe, expect, it } from "vitest";
import {
  adxSeries,
  atrSeries,
  bbWidthSeries,
  donchianSeries,
  emaSeries,
  rocSeries,
  rsiSeries,
  rvolSeries,
  smaSeries,
  swingHighSeries,
  swingLowSeries,
  vwapSeries,
  type IndicatorBar,
} from "./trading-indicators.js";

/** Deterministic pseudo-random OHLCV used to produce the reference numbers below (same generator ran against `trading-signals` 8.3.0, MIT). */
export function referenceBars(count = 120): IndicatorBar[] {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const bars: IndicatorBar[] = [];
  let c = 100;
  for (let i = 0; i < count; i++) {
    const o = c;
    c = Math.max(1, c * (1 + (rnd() - 0.5) * 0.04));
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    bars.push({ openTime: new Date(Date.UTC(2026, 0, 1) + i * 4 * 3_600_000), open: o, high: h, low: l, close: c, volume: 1000 + Math.floor(rnd() * 500) });
  }
  return bars;
}

const last = (s: Array<number | null>) => s[s.length - 1]!;

describe("indicators against trading-signals reference values", () => {
  const bars = referenceBars();
  const closes = bars.map((b) => b.close);
  it("SMA(20)", () => expect(last(smaSeries(closes, 20))).toBeCloseTo(114.24847217793601, 9));
  // The library seeds the EMA/ADX smoothing differently from the textbook SMA-seed used here; the gap decays with history, so these two agree to 4 decimals, not 9.
  it("EMA(20)", () => expect(last(emaSeries(closes, 20))).toBeCloseTo(114.15029899584356, 4));
  it("RSI(14)", () => expect(last(rsiSeries(closes, 14))).toBeCloseTo(72.96995675593314, 9));
  it("ATR(14)", () => expect(last(atrSeries(bars, 14))).toBeCloseTo(2.007796738066772, 9));
  it("ADX(14)", () => expect(Math.abs(last(adxSeries(bars, 14))! - 40.33367895891411)).toBeLessThan(0.01));
  it("Bollinger width (20, 2)", () => expect(last(bbWidthSeries(closes, 20, 2))).toBeCloseTo(0.10310490823775789, 9));
});

describe("RSI on the classic Wilder worked example", () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  it("matches the published first values", () => {
    const rsi = rsiSeries(closes, 14);
    expect(rsi.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(rsi[14]!).toBeCloseTo(70.53, 1);
    expect(rsi[15]!).toBeCloseTo(66.32, 1);
    expect(rsi[16]!).toBeCloseTo(66.55, 1);
  });
});

describe("hand-checked small cases", () => {
  it("SMA and EMA are null until warm", () => {
    expect(smaSeries([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
    const ema = emaSeries([1, 2, 3, 4], 3);
    expect(ema.slice(0, 2)).toEqual([null, null]);
    expect(ema[2]).toBe(2);
    expect(ema[3]).toBeCloseTo(3, 12); // 4 * 0.5 + 2 * 0.5
  });
  it("donchian, swing high/low look at the right bars", () => {
    const mk = (high: number, low: number): IndicatorBar => ({ openTime: new Date(0), open: low, high, low, close: high, volume: 1 });
    const bars = [mk(5, 1), mk(7, 2), mk(6, 3), mk(9, 4)];
    expect(donchianSeries(bars, 3, "upper")).toEqual([null, null, 7, 9]);
    expect(donchianSeries(bars, 3, "lower")).toEqual([null, null, 1, 2]);
    expect(donchianSeries(bars, 3, "mid")).toEqual([null, null, 4, 5.5]);
    expect(swingHighSeries(bars, 2)).toEqual([null, null, 7, 7]);
    expect(swingLowSeries(bars, 2)).toEqual([null, null, 1, 2]);
  });
  it("roc and rvol", () => {
    const roc = rocSeries([100, 110, 121], 1);
    expect(roc[0]).toBeNull();
    expect(roc[1]).toBeCloseTo(10, 12);
    expect(roc[2]).toBeCloseTo(10, 12);
    expect(rvolSeries([10, 10, 20], 2)).toEqual([null, null, 2]);
  });
  it("vwap resets at the UTC day", () => {
    const day = (h: number, d: number): IndicatorBar => ({ openTime: new Date(Date.UTC(2026, 0, d, h)), open: 10, high: 10, low: 10, close: 10, volume: 1 });
    const bars: IndicatorBar[] = [{ ...day(20, 1), high: 12, low: 8, close: 10 }, { ...day(23, 1), high: 14, low: 10, close: 12 }, day(2, 2)];
    const v = vwapSeries(bars, "utc_day");
    expect(v[0]).toBe(10);
    expect(v[1]).toBe(11); // (10 + 12) / 2
    expect(v[2]).toBe(10); // new day, only its own bar
  });
  it("same input gives the same output", () => {
    const bars = referenceBars(80);
    expect(adxSeries(bars, 14)).toEqual(adxSeries(bars, 14));
  });
});
