import { describe, expect, it } from "vitest";
import {
  TRADING_START_GATE,
  addUtcMonths,
  annualisedSharpe,
  annualisedSortino,
  deflatedSharpe,
  evaluateBacktestGate,
  maxDrawdownPct,
  normalCdf,
  normalInverseCdf,
  planHoldout,
  summarizeBacktest,
  walkForwardWindows,
  wilsonInterval,
  type BacktestGateFacts,
  type BacktestTrade,
} from "./trading-backtest.js";
import { seededRandom } from "./trading-scoring.js";

/**
 * DUR-5008: the pure maths and rules of the past-data test, pinned to values
 * worked out by hand or published (Wilson 8/10, the normal distribution),
 * and the gate's thresholds as the plan states them.
 */

describe("statistics", () => {
  it("Wilson interval for 8 wins of 10 is the textbook 0.490 - 0.943", () => {
    const { low, high } = wilsonInterval(8, 10);
    expect(low).toBeCloseTo(0.4902, 3);
    expect(high).toBeCloseTo(0.9433, 3);
  });

  it("Wilson with no trades is the whole range, never a made-up number", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("normal cdf and its inverse agree with the known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalInverseCdf(0.975)).toBeCloseTo(1.96, 3);
    expect(normalInverseCdf(0.5)).toBeCloseTo(0, 6);
  });

  it("annualises Sharpe and Sortino with 365 days", () => {
    const returns = [0.01, -0.005, 0.02, 0.0, 0.015, -0.01];
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
    expect(annualisedSharpe(returns, 365 * 6)).toBeCloseTo((mean / std) * Math.sqrt(365 * 6), 8);
    const down = Math.sqrt((0.005 ** 2 + 0.01 ** 2) / returns.length);
    expect(annualisedSortino(returns, 365 * 6)).toBeCloseTo((mean / down) * Math.sqrt(365 * 6), 8);
  });

  it("max drawdown is the worst peak-to-trough fall in percent", () => {
    expect(maxDrawdownPct([100, 120, 90, 110, 80, 130])).toBeCloseTo(((120 - 80) / 120) * 100, 8);
    expect(maxDrawdownPct([1, 2, 3])).toBe(0);
  });

  it("the Deflated Sharpe ratio falls as more trials were tried, and equals the probabilistic Sharpe with one", () => {
    const base = { observedSharpe: 0.05, observations: 2000, skew: 0, kurt: 3, trialSharpeVariance: 0.0004 };
    const one = deflatedSharpe({ ...base, trials: 1 });
    const many = deflatedSharpe({ ...base, trials: 100 });
    expect(one.benchmarkSharpe).toBe(0);
    expect(one.probability).toBeCloseTo(normalCdf((0.05 * Math.sqrt(1999)) / Math.sqrt(1 + (2 / 4) * 0.05 ** 2)), 6);
    expect(many.benchmarkSharpe).toBeGreaterThan(0);
    expect(many.probability).toBeLessThan(one.probability);
  });

  it("the seeded generator repeats exactly", () => {
    const a = seededRandom(123);
    const b = seededRandom(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("summarises trades: hit rate, expectancy in R, profit factor, fees as % of gross", () => {
    const trade = (net: number, r: number | null, gross = net + 2): BacktestTrade => ({ coin: "BTC", entryAt: "", exitAt: "", entryPrice: 1, exitPrice: 1, quantity: 1, bars: 3, grossPnlUsd: gross, feesUsd: gross - net, netPnlUsd: net, netReturn: net / 100, r, exitReason: "x", regime: null });
    const metrics = summarizeBacktest([trade(10, 2), trade(-5, -1), trade(7, 1.5), trade(-3, null)], null);
    expect(metrics.trades).toBe(4);
    expect(metrics.hitRate).toBe(0.5);
    expect(metrics.expectancyR).toBeCloseTo((2 - 1 + 1.5) / 3, 8);
    expect(metrics.tradesWithR).toBe(3);
    expect(metrics.profitFactor).toBeCloseTo(17 / 8, 8);
    expect(metrics.feesPctOfGross).toBeCloseTo((metrics.feesUsd / metrics.grossPnlUsd) * 100, 8);
    expect(metrics.avgWinPct).toBeCloseTo(((0.1 + 0.07) / 2) * 100, 8);
  });
});

describe("walk-forward layout", () => {
  it("tunes 24 months, leaves a gap one horizon long, tests to 3 months after the tune ends, and rolls 3 months", () => {
    const windows = walkForwardWindows({ dataStart: new Date("2020-01-01T00:00:00Z"), walkForwardEnd: new Date("2023-01-01T00:00:00Z"), horizonMs: 4 * 3_600_000 });
    expect(windows[0]).toEqual({ index: 0, tuneStart: "2020-01-01T00:00:00.000Z", tuneEnd: "2022-01-01T00:00:00.000Z", testStart: "2022-01-01T04:00:00.000Z", testEnd: "2022-04-01T00:00:00.000Z" });
    expect(windows[1]!.tuneStart).toBe("2020-04-01T00:00:00.000Z");
    expect(windows[3]!.testEnd).toBe("2023-01-01T00:00:00.000Z");
    expect(windows).toHaveLength(4); // a fifth would end three months past the walk-forward end
  });

  it("makes no window when there is not enough history", () => {
    expect(walkForwardWindows({ dataStart: new Date("2024-01-01T00:00:00Z"), walkForwardEnd: new Date("2025-06-01T00:00:00Z"), horizonMs: 3_600_000 })).toEqual([]);
  });

  it("adds UTC months without drifting to the next month", () => {
    expect(addUtcMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(addUtcMonths(new Date("2026-10-31T00:00:00Z"), -12).toISOString()).toBe("2025-10-31T00:00:00.000Z");
  });
});

describe("holdout reads", () => {
  const dataEnd = new Date("2026-09-01T00:00:00Z");

  it("the first read is clean and covers the last 12 months", () => {
    const plan = planHoldout({ dataEnd, priorReads: [] });
    expect(plan).toMatchObject({ start: "2025-09-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z", seenCount: 0, fresh: false, label: "clean holdout: the first read" });
  });

  it("a second read of the same stretch is 'already seen 1 time', then 2 times", () => {
    const read = (id: string) => ({ runId: id, holdoutStart: "2025-09-01T00:00:00.000Z", holdoutEnd: "2026-09-01T00:00:00.000Z" });
    expect(planHoldout({ dataEnd, priorReads: [read("a")] }).label).toBe("holdout already seen 1 time");
    expect(planHoldout({ dataEnd: new Date("2026-10-01T00:00:00Z"), priorReads: [read("a"), read("b")] }).label).toBe("holdout already seen 2 times");
  });

  it("with less than 6 months of new data since the last read it is still the old stretch", () => {
    const plan = planHoldout({ dataEnd: new Date("2027-02-15T00:00:00Z"), priorReads: [{ runId: "a", holdoutStart: "2025-09-01T00:00:00.000Z", holdoutEnd: "2026-09-01T00:00:00.000Z" }] });
    expect(plan.fresh).toBe(false);
    expect(plan.seenCount).toBe(1);
  });

  it("with 6 months or more of new data since the last read, that stretch is a fresh, clean holdout", () => {
    const plan = planHoldout({ dataEnd: new Date("2027-03-01T00:00:00Z"), priorReads: [{ runId: "a", holdoutStart: "2025-09-01T00:00:00.000Z", holdoutEnd: "2026-09-01T00:00:00.000Z" }] });
    expect(plan).toMatchObject({ start: "2026-09-01T00:00:00.000Z", end: "2027-03-01T00:00:00.000Z", seenCount: 0, fresh: true });
  });
});

describe("the start gate", () => {
  const passing: BacktestGateFacts = {
    purpose: "gate",
    source: "kraken",
    headlineCoinsTested: ["BTC", "ETH"],
    outOfSample: { trades: 140, expectancyR: 0.2, meanTradeReturn: 0.004, windowsPositive: 14, windowsTotal: 20, worstDrawdownPct: 9, drawdownCapPct: 10, beatRandomShare: 0.97 },
    plateau: { applicable: true, neighbours: 4, positive: 4 },
    coverage: [{ coin: "BTC", missing: [] }, { coin: "ETH", missing: [] }],
    integrity: { lookAheadPassed: true, pointInTimePassed: true },
    holdout: { read: true, seenCount: 0, label: "clean holdout: the first read", positive: true, trades: 30 },
  };
  const verdict = (over: Partial<BacktestGateFacts>) => evaluateBacktestGate({ ...passing, ...over });
  const failing = (over: Partial<BacktestGateFacts>) => verdict(over).items.filter((i) => i.passed !== true).map((i) => i.key);

  it("passes when every agreed threshold is met", () => {
    expect(verdict({}).passed).toBe(true);
  });

  it("states the plan's thresholds", () => {
    expect(TRADING_START_GATE).toMatchObject({ headlineCoins: ["BTC", "ETH"], minOutOfSampleTrades: 100, minPositiveWindowShare: 0.6, liveSource: "kraken" });
  });

  it("fails on expectancy at or below zero at 2x fees", () => {
    expect(failing({ outOfSample: { ...passing.outOfSample, expectancyR: 0 } })).toEqual(["expectancy"]);
    expect(failing({ outOfSample: { ...passing.outOfSample, expectancyR: -0.1 } })).toEqual(["expectancy"]);
  });

  it("fails with fewer than 100 out-of-sample trades (99 fails, 100 passes)", () => {
    expect(failing({ outOfSample: { ...passing.outOfSample, trades: 99 } })).toEqual(["trades"]);
    expect(failing({ outOfSample: { ...passing.outOfSample, trades: 100 } })).toEqual([]);
  });

  it("needs positive results in 60% of windows (11 of 20 fails, 12 of 20 passes)", () => {
    expect(failing({ outOfSample: { ...passing.outOfSample, windowsPositive: 11 } })).toEqual(["windows"]);
    expect(failing({ outOfSample: { ...passing.outOfSample, windowsPositive: 12 } })).toEqual([]);
  });

  it("needs to beat random entry, stay inside its own drawdown cap, and keep neighbours positive", () => {
    expect(failing({ outOfSample: { ...passing.outOfSample, beatRandomShare: 0.9 } })).toEqual(["random_entry"]);
    expect(failing({ outOfSample: { ...passing.outOfSample, worstDrawdownPct: 10.5 } })).toEqual(["drawdown"]);
    expect(failing({ plateau: { applicable: true, neighbours: 4, positive: 2 } })).toEqual(["plateau"]);
  });

  it("fails honestly when a headline coin's windows never covered a market state", () => {
    const keys = failing({ coverage: [{ coin: "BTC", missing: [] }, { coin: "ETH", missing: ["bear"] }] });
    expect(keys).toEqual(["regimes"]);
    expect(verdict({ coverage: [{ coin: "ETH", missing: ["bear"] }] }).items.find((i) => i.key === "regimes")!.detail).toMatch(/ETH was never tested in a bear market/);
  });

  it("fails on a look-ahead or point-in-time finding, or when either check did not run", () => {
    expect(failing({ integrity: { lookAheadPassed: false, pointInTimePassed: true } })).toEqual(["look_ahead"]);
    expect(failing({ integrity: { lookAheadPassed: true, pointInTimePassed: false } })).toEqual(["point_in_time"]);
    expect(failing({ integrity: { lookAheadPassed: null, pointInTimePassed: true } })).toEqual(["look_ahead"]);
  });

  it("a holdout already seen cannot pass the gate alone, and says how often", () => {
    const result = verdict({ holdout: { read: true, seenCount: 2, label: "holdout already seen 2 times", positive: true, trades: 30 } });
    const item = result.items.find((i) => i.key === "holdout")!;
    expect(item.passed).toBe(false);
    expect(item.detail).toMatch(/holdout already seen 2 times/);
    expect(result.passed).toBe(false);
  });

  it("an exploration run, a run on another source, or a strategy with no headline coin cannot pass", () => {
    expect(failing({ purpose: "explore", holdout: { read: false, seenCount: 0, label: "", positive: null, trades: 0 } })).toEqual(expect.arrayContaining(["gate_run", "holdout"]));
    expect(failing({ source: "binance" })).toEqual(["gate_run"]);
    expect(failing({ headlineCoinsTested: [] })).toEqual(["headline_coins"]);
  });
});
