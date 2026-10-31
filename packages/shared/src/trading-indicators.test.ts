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
} from "./trading-indicators.js";

/**
 * DUR-5002: the indicators are our own code, so they are pinned to reference
 * values: small series worked out by hand, the widely published Wilder RSI
 * worked example, and ATR / ADX / Bollinger width values from an independent
 * Python implementation of the same textbook formulas (written separately from
 * this code and run on the same bars).
 */

const T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, o: number, h: number, l: number, c: number, volume = 1) => ({ openTime: new Date(T0 + i * 4 * 3_600_000), open: o, high: h, low: l, close: c, volume });

// [open, high, low, close] x 40, produced by a fixed formula so the reference values below are reproducible.
const OHLC: Array<[number, number, number, number]> = [
  [100.1, 101.4, 99.1, 100.4], [101.2923, 102.6544, 100.1923, 101.4544], [103.216, 104.616, 101.8911, 103.0911], [105.4711, 106.4711, 103.8741, 105.1741],
  [107.014, 108.214, 105.8179, 106.8179], [108.4237, 109.9088, 107.3237, 108.5088], [109.7393, 111.0274, 108.5393, 110.0274], [111.6474, 113.0735, 110.3474, 111.8735],
  [113.2317, 114.6317, 112.1881, 113.1881], [114.1437, 115.1437, 112.7703, 113.8703], [114.1409, 115.3409, 112.6892, 113.8892], [112.5853, 113.9866, 111.2853, 112.5866],
  [110.5199, 111.773, 109.5199, 110.773], [108.3428, 109.815, 107.2428, 108.615], [106.9761, 108.4171, 105.7761, 107.0171], [105.7271, 106.7271, 104.1992, 105.4992],
  [104.5599, 105.7599, 103.2726, 104.2726], [103.5987, 104.9987, 102.4162, 103.5162], [102.4593, 103.6573, 101.2593, 102.6573], [102.161, 103.6576, 100.861, 102.4576],
  [102.7835, 104.3059, 101.7835, 102.9059], [104.7842, 105.7842, 103.5199, 104.6199], [107.0549, 108.2549, 105.5549, 106.7549], [109.2797, 110.6797, 107.8199, 109.1199],
  [111.3713, 112.4986, 110.3713, 111.4986], [112.6758, 114.1732, 111.5758, 112.9732], [113.8542, 115.4483, 112.6542, 114.0483], [114.6602, 115.6602, 113.2725, 114.5725],
  [115.4439, 116.6439, 114.1552, 115.1552], [115.3005, 116.7005, 113.9761, 115.0761], [114.3418, 115.388, 113.1418, 114.388], [112.9364, 114.4108, 111.6364, 113.2108],
  [110.7678, 112.418, 109.7678, 111.018], [108.722, 109.722, 107.618, 108.718], [106.7856, 107.9856, 105.331, 106.531], [105.6359, 107.0359, 104.0648, 105.3648],
  [104.73, 105.73, 103.6916, 104.6916], [104.4001, 105.8297, 103.3001, 104.6297], [104.9435, 106.63, 103.7435, 105.23], [105.6903, 106.7703, 104.3903, 105.7703],
];
const BARS = OHLC.map(([o, h, l, c], i) => bar(i, o, h, l, c));

describe("moving averages", () => {
  it("sma: first value at index period-1, rolling mean", () => {
    expect(smaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("sma: too short a series is all null", () => {
    expect(smaSeries([1, 2], 3)).toEqual([null, null]);
  });
  it("ema: seeded with the sma, k = 2/(period+1)", () => {
    // period 3: seed (1+2+3)/3 = 2, k = 0.5 -> 4*0.5+2*0.5 = 3, then 5*0.5+3*0.5 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});

describe("rsi (Wilder)", () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6409];
  it("matches the published 14-period worked example", () => {
    const rsi = rsiSeries(closes, 14);
    expect(rsi.slice(0, 14).every((v) => v === null)).toBe(true);
    const published = [70.53, 66.32, 66.55, 69.41, 66.36];
    published.forEach((expected, k) => expect(rsi[14 + k]!).toBeCloseTo(expected, 1));
  });
  it("is 100 on a series that only rises and 50 on a flat one", () => {
    expect(rsiSeries([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsiSeries([5, 5, 5, 5, 5, 5], 3)[5]).toBe(50);
  });
});

describe("atr, adx (Wilder) against the independent reference", () => {
  it("atr(5): first and last values", () => {
    const atr = atrSeries(BARS, 5);
    expect(atr[3]).toBeNull();
    expect(atr[4]!).toBeCloseTo(2.86872, 4);
    expect(atr[37]!).toBeCloseTo(2.771046, 4);
    expect(atr[38]!).toBeCloseTo(2.794137, 4);
    expect(atr[39]!).toBeCloseTo(2.711309, 4);
  });
  it("adx(5) and the directional indicators", () => {
    const { adx, plusDi, minusDi } = adxSeries(BARS, 5);
    expect(adx[8]).toBeNull();
    expect(adx[9]!).toBeCloseTo(100, 4); // the first 5 directional moves are all up
    expect(adx[39]!).toBeCloseTo(54.805973, 4);
    expect(plusDi[39]!).toBeCloseTo(9.267166, 4);
    expect(minusDi[39]!).toBeCloseTo(22.887253, 4);
  });
});

describe("bands and channels", () => {
  it("bb_width(5, 2): 4 * population stdev / mean", () => {
    expect(bbWidthSeries(BARS.map((b) => b.close), 5, 2)[39]!).toBeCloseTo(0.01629613, 6);
  });
  it("donchian excludes the current bar", () => {
    const bars = [bar(0, 1, 2, 0.5, 1), bar(1, 1, 3, 1, 2), bar(2, 2, 2.5, 1.5, 2), bar(3, 2, 9, 0.1, 2)];
    expect(donchianSeries(bars, 2, "upper")).toEqual([null, null, 3, 3]);
    expect(donchianSeries(bars, 2, "lower")).toEqual([null, null, 0.5, 1]);
    expect(donchianSeries(bars, 2, "mid")).toEqual([null, null, 1.75, 2]);
  });
  it("swing high / low include the current bar", () => {
    const bars = [bar(0, 1, 2, 0.5, 1), bar(1, 1, 3, 1, 2), bar(2, 2, 2.5, 1.5, 2)];
    expect(swingHighSeries(bars, 2)).toEqual([null, 3, 3]);
    expect(swingLowSeries(bars, 2)).toEqual([null, 0.5, 1]);
  });
});

describe("volume and momentum", () => {
  it("rvol: volume over the mean of the previous bars", () => {
    const rvol = rvolSeries([10, 10, 20, 5], 2); // 20 / mean(10,10) = 2; 5 / mean(10,20) = 1/3
    expect(rvol.slice(0, 3)).toEqual([null, null, 2]);
    expect(rvol[3]!).toBeCloseTo(1 / 3, 12);
  });
  it("roc is in percent", () => {
    const roc = rocSeries([100, 110, 99], 1);
    expect(roc[0]).toBeNull();
    expect(roc[1]!).toBeCloseTo(10, 10);
    expect(roc[2]!).toBeCloseTo(-10, 10);
  });
  it("vwap(utc_day) restarts at midnight UTC", () => {
    const day = 86_400_000;
    const mk = (t: number, price: number, volume: number) => ({ openTime: new Date(t), open: price, high: price, low: price, close: price, volume });
    const bars = [mk(0, 10, 1), mk(4 * 3_600_000, 20, 3), mk(day, 50, 2)];
    const v = vwapSeries(bars, "utc_day");
    expect(v[0]).toBe(10);
    expect(v[1]).toBe((10 * 1 + 20 * 3) / 4);
    expect(v[2]).toBe(50);
  });
  it("vwap(swing) anchors at the lowest low of the window", () => {
    const mk = (i: number, low: number, close: number, volume: number) => bar(i, close, close, low, close, volume);
    const bars = [mk(0, 5, 9, 1), mk(1, 3, 6, 1), mk(2, 4, 8, 1)];
    // window of 3: lowest low is bar 1, so vwap = typical(bar1, bar2) = mean of (6+3+6)/3 and (8+4+8)/3
    expect(vwapSeries(bars, "swing", 3)[2]!).toBeCloseTo(((6 + 3 + 6) / 3 + (8 + 4 + 8) / 3) / 2, 10);
  });
});
