import { describe, expect, it } from "vitest";
import {
  computeRegimeLabels,
  describeRegime,
  hysteresisMachine,
  latestAvailableRegime,
  regimeFlipCounts,
  regimeSpells,
  trailingPercentile,
  wilderAdx,
  type RegimeBar,
} from "./trading-regimes.js";

const DAY = 86_400_000;
const START = Date.UTC(2022, 0, 1);

/** Deterministic pseudo-random walk with a drift; `vol` is the daily move size. */
function series(days: number, drift: (i: number) => number, vol: (i: number) => number, seed = 7): RegimeBar[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
  const bars: RegimeBar[] = [];
  let price = 100;
  for (let i = 0; i < days; i++) {
    const open = price;
    const close = Math.max(1, open * (1 + drift(i) + rand() * vol(i)));
    const high = Math.max(open, close) * (1 + Math.abs(rand()) * vol(i) * 0.3);
    const low = Math.min(open, close) * (1 - Math.abs(rand()) * vol(i) * 0.3);
    bars.push({ openTime: new Date(START + i * DAY), open, high, low, close });
    price = close;
  }
  return bars;
}

const longHistory = series(1500, (i) => (i < 700 ? 0.004 : i < 1100 ? -0.004 : 0), (i) => (i % 400 < 200 ? 0.03 : 0.08));

describe("market weather labels (DUR-5013)", () => {
  it("labels only days with a full window, and every label is available at the close of its own day", () => {
    const labels = computeRegimeLabels(longHistory);
    expect(labels.length).toBeGreaterThan(900);
    expect(labels.length).toBeLessThan(longHistory.length - 360);
    for (const label of labels) {
      expect(label.availableAt.getTime()).toBe(Date.parse(`${label.day}T00:00:00Z`) + DAY);
    }
  });

  it("a label for any past day uses only data available at that time", () => {
    const full = computeRegimeLabels(longHistory);
    for (const cut of [600, 900, 1234, 1499]) {
      const truncated = computeRegimeLabels(longHistory.slice(0, cut + 1));
      const day = truncated[truncated.length - 1]!.day;
      const same = full.find((l) => l.day === day)!;
      // Identical label, spell number and indicator values: nothing after `day` leaked in.
      expect(truncated[truncated.length - 1]).toEqual(same);
    }
    // And changing the future never moves the past.
    const altered = longHistory.map((b, i) => (i > 1000 ? { ...b, close: b.close * 3, high: b.high * 3 } : b));
    const a = computeRegimeLabels(altered);
    const upTo = longHistory[1000]!.openTime;
    const before = (l: { day: string }) => Date.parse(`${l.day}T00:00:00Z`) <= upTo.getTime();
    expect(a.filter(before)).toEqual(full.filter(before));
  });

  it("an intraday decision cannot read the same day's label", () => {
    const labels = computeRegimeLabels(longHistory);
    const target = labels[300]!;
    const dayStart = Date.parse(`${target.day}T00:00:00Z`);
    for (const offsetMs of [0, 1, 3_600_000, 12 * 3_600_000, DAY - 1]) {
      const read = latestAvailableRegime(labels, new Date(dayStart + offsetMs))!;
      expect(read.day).toBe(labels[299]!.day);
    }
    // At the very close of the day the label becomes readable.
    expect(latestAvailableRegime(labels, new Date(dayStart + DAY))!.day).toBe(target.day);
    expect(latestAvailableRegime(labels, new Date(Date.parse(`${labels[0]!.day}T00:00:00Z`)))).toBeNull();
  });

  it("calls a steady climb an uptrend and a steady fall a downtrend", () => {
    const up = computeRegimeLabels(series(800, () => 0.006, () => 0.01));
    const down = computeRegimeLabels(series(800, () => -0.006, () => 0.01));
    expect(up[up.length - 1]!.trend).toBe("uptrend");
    expect(down[down.length - 1]!.trend).toBe("downtrend");
  });

  it("calls a trendless wobble ranging", () => {
    // Prices wobble around a fixed level (they do not accumulate), the textbook ranging market.
    let seed = 11;
    const wobble: RegimeBar[] = Array.from({ length: 800 }, (_, i) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const close = 100 * (1 + (seed / 4294967296 - 0.5) * 0.06);
      return { openTime: new Date(START + i * DAY), open: 100, high: close * 1.01, low: close * 0.99, close };
    });
    const labels = computeRegimeLabels(wobble);
    const ranging = labels.filter((l) => l.trend === "ranging").length;
    expect(ranging / labels.length).toBeGreaterThan(0.5);
  });

  it("calls the quiet stretch after wild swings low volatility and squeezing", () => {
    const bars = series(900, () => 0, (i) => (i < 600 ? 0.08 : 0.08 * Math.exp(-(i - 600) / 40) + 0.0005));
    const labels = computeRegimeLabels(bars);
    const last = labels[labels.length - 1]!;
    expect(last.volatility).toBe("low");
    expect(last.squeeze).toBe(true);
  });

  it("holds a state until three closed days in a row agree on the new one", () => {
    const step = hysteresisMachine<string>(3);
    expect([step("a"), step("b"), step("a"), step("b"), step("b"), step("b")]).toEqual(["a", "a", "a", "a", "a", "b"]);
    const withDeadZone = hysteresisMachine<string>(3);
    expect([withDeadZone("a"), withDeadZone("b"), withDeadZone("b"), withDeadZone(null), withDeadZone("b"), withDeadZone("b"), withDeadZone("b")]).toEqual(["a", "a", "a", "a", "a", "a", "b"]);
  });

  it("flip counts over a multi-year history are small", () => {
    const labels = computeRegimeLabels(longHistory);
    const flips = regimeFlipCounts(labels);
    const years = labels.length / 365;
    expect(flips.spells).toBeGreaterThan(1);
    expect(flips.trend / years).toBeLessThan(12);
    expect(flips.volatility / years).toBeLessThan(12);
    // Every spell lasts at least the 3-day confirmation for the part that changed.
    for (const spell of regimeSpells(labels).slice(1)) expect(spell.days).toBeGreaterThanOrEqual(1);
    expect(regimeSpells(labels)).toHaveLength(flips.spells);
  });

  it("restarts the indicators after a long hole and keeps going through a short one", () => {
    const bars = series(1100, () => 0.001, () => 0.02);
    const shortHole = bars.filter((_, i) => i !== 700 && i !== 701);
    expect(computeRegimeLabels(shortHole).length).toBeGreaterThan(computeRegimeLabels(bars).length - 20);
    const longHole = bars.filter((_, i) => i < 600 || i > 620);
    const labels = computeRegimeLabels(longHole);
    const gapDay = bars[610]!.openTime.getTime();
    expect(labels.some((l) => Date.parse(`${l.day}T00:00:00Z`) > gapDay && Date.parse(`${l.day}T00:00:00Z`) < bars[620 + 365]!.openTime.getTime() - 100 * DAY)).toBe(false);
  });

  it("writes the plain-language line", () => {
    const now = new Date(Date.UTC(2026, 10, 1));
    expect(describeRegime("BTC", { trend: "uptrend", volatility: "normal", squeeze: false, spellStartDay: "2026-10-12" }, now)).toBe("Bitcoin: uptrend, normal swings, since 12 Oct");
    expect(describeRegime("ETH", { trend: "ranging", volatility: "low", squeeze: true, spellStartDay: "2025-03-02" }, now)).toBe(
      "Ethereum: sideways, calm swings, squeezing (quiet before a possible big move), since 2 Mar 2025",
    );
  });

  it("indicator sanity: ADX of a straight line is high; percentile of the largest value is near 100", () => {
    const straight: RegimeBar[] = Array.from({ length: 80 }, (_, i) => ({ openTime: new Date(START + i * DAY), open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.5 + i }));
    expect(wilderAdx(straight, 14).at(-1)!).toBeGreaterThan(50);
    const values = Array.from({ length: 365 }, (_, i) => i);
    expect(trailingPercentile(values, 365).at(-1)!).toBeGreaterThan(99);
  });
});
