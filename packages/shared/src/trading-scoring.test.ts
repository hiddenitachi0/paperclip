import { describe, expect, it } from "vitest";
import {
  baselineCall,
  blockBootstrapInterval,
  blocksByDecisionTime,
  computeTradingVerdict,
  coverage,
  defaultFlatBandPct,
  effectiveSampleSize,
  expectedHitRateFromBaseRate,
  isIndependentCall,
  probabilityScores,
  resolveTradingPrediction,
  returnVsBuyAndHold,
  riskAdjustedReturns,
  runningTimeMs,
  seededRandom,
  scoreByRegime,
  summarizeHitRate,
  tradeMetrics,
  trailingBaseRateUp,
  verdictPlanOf,
  verdictStatus,
  type ResolvablePrediction,
  type RoundTrip,
  type ScoredPrediction,
} from "./trading-scoring.js";
import type { TradingCandle } from "./trading.js";

const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function bar(index: number, open: number, high: number, low: number, close: number): TradingCandle {
  return { openTime: new Date(T0 + index * H4), open, high, low, close, volume: 1 };
}

function call(over: Partial<ScoredPrediction> & { i: number }): ScoredPrediction {
  const { i, ...rest } = over;
  return {
    forecasterKey: "rule",
    asset: "BTC",
    barCloseAt: new Date(T0 + i * H4),
    resolvesAt: new Date(T0 + (i + 1) * H4),
    direction: "up",
    probability: null,
    outcome: "hit",
    realizedReturn: 0.02,
    independent: true,
    ...rest,
  };
}

describe("flat band default", () => {
  it("is half the round-trip cost: two 0.40% fees plus 0.1% spread, halved", () => {
    expect(defaultFlatBandPct()).toBeCloseTo(0.45, 12);
    expect(defaultFlatBandPct(0.2, 0)).toBeCloseTo(0.2, 12);
  });
});

describe("resolution", () => {
  // The call is made on the close of bar 0 (so bar_close_at is bar 1's open) at reference 100, horizon 2 bars:
  // the outcome bar is the one that closes at bar_close_at + 2 bars, i.e. bar index 2 (open T0 + 2*4h).
  const base: ResolvablePrediction = {
    direction: "up",
    kind: "direction",
    referencePrice: 100,
    flatBandPct: 0.45,
    barCloseAt: new Date(T0 + 1 * H4),
    resolvesAt: new Date(T0 + 3 * H4),
    targetPrice: null,
    stopPrice: null,
  };
  const bars = [bar(0, 99, 101, 98, 100), bar(1, 100, 104, 99, 103), bar(2, 103, 106, 97, 102)];

  it("is pending until the bar that closes at the outcome time exists", () => {
    expect(resolveTradingPrediction(base, bars.slice(0, 2), "4h")).toEqual({ status: "pending" });
    expect(resolveTradingPrediction(base, [], "4h")).toEqual({ status: "pending" });
  });

  it("compares the close at bar_close_at + horizon with the reference close, and measures MFE/MAE in the called direction", () => {
    // Window bars 1 and 2: high 106, low 97. Return 102/100 - 1 = +2%.
    const up = resolveTradingPrediction(base, bars, "4h");
    expect(up.status).toBe("resolved");
    if (up.status !== "resolved") return;
    expect(up.outcome).toBe("hit");
    expect(up.realizedReturn).toBeCloseTo(0.02, 12);
    expect(up.mfe).toBeCloseTo(0.06, 12);
    expect(up.mae).toBeCloseTo(-0.03, 12);
    const down = resolveTradingPrediction({ ...base, direction: "down" }, bars, "4h");
    if (down.status !== "resolved") throw new Error("not resolved");
    expect(down.outcome).toBe("miss");
    expect(down.mfe).toBeCloseTo(0.03, 12); // 1 - 97/100
    expect(down.mae).toBeCloseTo(-0.06, 12); // 1 - 106/100
  });

  it("calls a move inside the flat band flat, not a hit and not a miss", () => {
    const flatBars = [bar(0, 99, 101, 98, 100), bar(1, 100, 101, 99, 100.2), bar(2, 100.2, 101, 99.8, 100.4)];
    const result = resolveTradingPrediction(base, flatBars, "4h");
    expect(result).toMatchObject({ status: "resolved", outcome: "flat" });
    // just beyond the band is a real move: 0.5% against a 0.45% band
    const edge = [bar(0, 99, 101, 98, 100), bar(1, 100, 101, 99, 100.2), bar(2, 100.2, 101, 99.8, 100.5)];
    expect(resolveTradingPrediction(base, edge, "4h")).toMatchObject({ outcome: "hit" });
  });

  it("is void when a bar inside the window is missing", () => {
    const hole = [bar(0, 99, 101, 98, 100), bar(2, 103, 106, 97, 102)];
    expect(resolveTradingPrediction(base, hole, "4h")).toMatchObject({ status: "resolved", outcome: "void", realizedReturn: null });
  });

  it("scores target-before-stop by the first touch, and a stop touched in the same bar as the target counts as the stop", () => {
    const tbs: ResolvablePrediction = { ...base, kind: "target_before_stop", targetPrice: 105, stopPrice: 96 };
    expect(resolveTradingPrediction(tbs, [bar(0, 99, 101, 98, 100), bar(1, 100, 106, 99, 103), bar(2, 103, 104, 100, 102)], "4h")).toMatchObject({ outcome: "hit" });
    expect(resolveTradingPrediction(tbs, [bar(0, 99, 101, 98, 100), bar(1, 100, 101, 95, 99), bar(2, 99, 110, 98, 105)], "4h")).toMatchObject({ outcome: "miss" });
    expect(resolveTradingPrediction(tbs, [bar(0, 99, 101, 98, 100), bar(1, 100, 106, 95, 99), bar(2, 99, 104, 98, 100)], "4h")).toMatchObject({ outcome: "miss" });
    expect(resolveTradingPrediction(tbs, [bar(0, 99, 101, 98, 100), bar(1, 100, 104, 99, 100), bar(2, 100, 104, 99, 100)], "4h")).toMatchObject({ outcome: "flat" });
  });
});

describe("independence", () => {
  it("marks a call independent only when it starts at or after the previous independent call's outcome time", () => {
    const first = new Date(T0);
    expect(isIndependentCall(first, null)).toBe(true);
    expect(isIndependentCall(new Date(T0 + H4), new Date(T0 + 3 * H4))).toBe(false);
    expect(isIndependentCall(new Date(T0 + 3 * H4), new Date(T0 + 3 * H4))).toBe(true);
  });
});

describe("baselines", () => {
  const input = { asset: "BTC", barCloseAt: new Date(T0), lastClose: 100, previousClose: 101 };
  it("always-up always calls up; persistence repeats the last bar, and an unchanged close calls up", () => {
    expect(baselineCall("baseline:always_up", input)).toBe("up");
    expect(baselineCall("baseline:persistence", input)).toBe("down");
    expect(baselineCall("baseline:persistence", { ...input, lastClose: 102 })).toBe("up");
    expect(baselineCall("baseline:persistence", { ...input, lastClose: 101 })).toBe("up");
    expect(baselineCall("baseline:persistence", { ...input, previousClose: null })).toBe("up");
  });
  it("the coin flip is repeatable and close to fair", () => {
    expect(baselineCall("baseline:coin_flip", input)).toBe(baselineCall("baseline:coin_flip", input));
    let ups = 0;
    for (let i = 0; i < 2000; i++) if (baselineCall("baseline:coin_flip", { ...input, barCloseAt: new Date(T0 + i * H4) }) === "up") ups++;
    expect(ups).toBeGreaterThan(900);
    expect(ups).toBeLessThan(1100);
  });
});

describe("base rate uses only what was known at decision time", () => {
  it("counts bars whose horizon had closed by the cutoff and nothing later", () => {
    // closes: 100,101,100,102,101,103 ; horizon 1, band 0 -> returns: +,-,+,-,+
    const closes = [100, 101, 100, 102, 101, 103];
    const bars = closes.map((c, i) => bar(i, c, c + 1, c - 1, c));
    const all = trailingBaseRateUp(bars, "4h", 1, 0, new Date(T0 + 6 * H4), 90, 1);
    expect(all).toMatchObject({ up: 3, down: 2, flat: 0 });
    expect(all.baseRateUp).toBeCloseTo(0.6, 12);
    // At the close of bar 3 (cutoff T0+4*H4) only the first three returns (+,-,+) were known.
    const early = trailingBaseRateUp(bars, "4h", 1, 0, new Date(T0 + 4 * H4), 90, 1);
    expect(early).toMatchObject({ up: 2, down: 1 });
    // Too few outcomes -> no base rate.
    expect(trailingBaseRateUp(bars, "4h", 1, 0, new Date(T0 + 4 * H4), 90, 30).baseRateUp).toBeNull();
    // Flat band 1%: +1%, -0.99%, +2%, -0.98%, +1.98% ; band 1.5 leaves only the +2% and +1.98%.
    expect(trailingBaseRateUp(bars, "4h", 1, 1.5, new Date(T0 + 6 * H4), 90, 1)).toMatchObject({ up: 2, down: 0, flat: 3 });
  });
});

describe("hit rate, coverage, expected hit rate", () => {
  const set: ScoredPrediction[] = [
    call({ i: 0, outcome: "hit", baseRateUp: 0.5 }),
    call({ i: 1, outcome: "hit", baseRateUp: 0.6 }),
    call({ i: 2, outcome: "miss", direction: "down", baseRateUp: 0.6 }),
    call({ i: 3, outcome: "flat" }),
    call({ i: 4, outcome: "void" }),
    call({ i: 5, outcome: null }),
  ];
  it("leaves flats and voids out of the hit rate but reports them", () => {
    expect(summarizeHitRate(set)).toEqual({ resolved: 5, hits: 2, misses: 1, flats: 1, voids: 1, pending: 1, hitRate: 2 / 3, flatShare: 1 / 4 });
    expect(summarizeHitRate([])).toMatchObject({ hitRate: null, flatShare: null });
  });
  it("coverage is calls over bars the forecaster was running for", () => {
    expect(coverage(30, 120)).toBe(0.25);
    expect(coverage(5, 0)).toBeNull();
  });
  it("expected hit rate from decision-time base rates: b for up calls, 1 - b for down calls", () => {
    // (0.5 + 0.6 + (1 - 0.6)) / 3 = 0.5
    expect(expectedHitRateFromBaseRate(set)).toBeCloseTo(0.5, 12);
    expect(expectedHitRateFromBaseRate([call({ i: 0 })])).toBeNull();
  });
});

describe("probability scores apply only to real probabilities", () => {
  it("returns null for a fixed rule with no probability", () => {
    expect(probabilityScores([call({ i: 0 }), call({ i: 1 })], 0.45)).toBeNull();
  });
  it("matches hand-computed Brier, Brier skill, log loss and calibration", () => {
    // y (up=1): 1,1,0,0 ; p: 0.8, 0.6, 0.3, 0.9 ; base rate 0.5 for all
    const rows = [
      call({ i: 0, probability: 0.8, realizedReturn: 0.02, baseRateUp: 0.5 }),
      call({ i: 1, probability: 0.6, realizedReturn: 0.01, baseRateUp: 0.5 }),
      call({ i: 2, probability: 0.3, realizedReturn: -0.02, baseRateUp: 0.5, outcome: "hit", direction: "down" }),
      call({ i: 3, probability: 0.9, realizedReturn: -0.03, baseRateUp: 0.5, outcome: "miss" }),
      call({ i: 4, probability: 0.5, realizedReturn: 0.001, baseRateUp: 0.5, outcome: "flat" }), // flat: left out
    ];
    const s = probabilityScores(rows, 0.45)!;
    expect(s.n).toBe(4);
    // Brier = (0.04 + 0.16 + 0.09 + 0.81) / 4 = 0.275 ; reference = 0.25 ; skill = 1 - 0.275/0.25 = -0.1
    expect(s.brier).toBeCloseTo(0.275, 12);
    expect(s.brierReference).toBeCloseTo(0.25, 12);
    expect(s.brierSkill).toBeCloseTo(-0.1, 12);
    // log loss = -(ln .8 + ln .6 + ln .7 + ln .1)/4
    expect(s.logLoss).toBeCloseTo(-(Math.log(0.8) + Math.log(0.6) + Math.log(0.7) + Math.log(0.1)) / 4, 12);
    // buckets of width .1: p=.3 -> bucket 3 (y 0); .6 -> 6 (y 1); .8 -> 8 (y 1); .9 -> 9 (y 0)
    expect(s.calibration.map((b) => [b.bucket, b.count, b.meanForecast, b.observedUpShare])).toEqual([
      [3, 1, 0.3, 0],
      [6, 1, 0.6, 1],
      [8, 1, 0.8, 1],
      [9, 1, 0.9, 0],
    ]);
  });
});

describe("effective sample size and the block bootstrap", () => {
  it("groups coins that share a timestamp into one block", () => {
    const rows = [call({ i: 0, asset: "BTC" }), call({ i: 0, asset: "ETH" }), call({ i: 1, asset: "BTC" }), call({ i: 2, asset: "BTC", independent: false })];
    expect(blocksByDecisionTime(rows).map((b) => b.length)).toEqual([2, 1, 1]);
    expect(effectiveSampleSize(rows)).toBe(2); // independent only, and the two coins at time 0 count once
  });
  it("is repeatable, and an all-hits series has a degenerate interval at 1", () => {
    const rand = seededRandom(5);
    const rows = Array.from({ length: 40 }, (_, i) => call({ i, outcome: rand() < 0.25 ? "miss" : "hit" }));
    const stat = (s: readonly ScoredPrediction[]) => summarizeHitRate(s).hitRate;
    const a = blockBootstrapInterval(rows, stat, { iterations: 300 });
    const b = blockBootstrapInterval(rows, stat, { iterations: 300 });
    expect(a).toEqual(b);
    const estimate = summarizeHitRate(rows).hitRate!;
    expect(a.estimate).toBeCloseTo(estimate, 12);
    expect(a.lower!).toBeLessThan(estimate);
    expect(a.upper!).toBeGreaterThan(estimate);
    expect(a.blocks).toBe(40);
    const perfect = blockBootstrapInterval(rows.map((r) => ({ ...r, outcome: "hit" as const })), stat, { iterations: 100 });
    expect(perfect).toMatchObject({ estimate: 1, lower: 1, upper: 1 });
    expect(blockBootstrapInterval([rows[0]!], stat)).toMatchObject({ lower: null, upper: null });
  });
});

describe("per-regime scores show the spells behind them", () => {
  it("counts unbroken runs of a label in time", () => {
    const labels = ["up", "up", "range", "range", "up", "up", "up", "range"];
    const rows = labels.map((regime, i) => call({ i, regime, outcome: regime === "up" ? "hit" : "miss" }));
    expect(scoreByRegime(rows)).toEqual([
      { regime: "range", hitRate: 0, scored: 3, spells: 2 },
      { regime: "up", hitRate: 1, scored: 5, spells: 2 },
    ]);
  });
});

describe("trade metrics match hand-computed fixtures", () => {
  const t = (day: number, entry: number, exit: number, qty: number, fees: number, r: number | null): RoundTrip => ({
    openedAt: new Date(T0 + day * 86_400_000),
    closedAt: new Date(T0 + (day + 1) * 86_400_000),
    entryPrice: entry,
    exitPrice: exit,
    quantity: qty,
    feesUsd: fees,
    rDistance: r,
  });
  // Net P&L: +(110-100)*1-2 = +8 ; -(100-95)*2-2 = -12 ; +(130-120)*1-1 = +9 ; -(50-49)*4-1 = -5
  const trips = [t(0, 100, 110, 1, 2, 5), t(2, 100, 95, 2, 2, 5), t(4, 120, 130, 1, 1, 10), t(6, 50, 49, 4, 1, null)];
  it("expectancy in R, profit factor, win rate, fees as % of gross, drawdown", () => {
    const m = tradeMetrics(trips, 1000);
    expect(m.trades).toBe(4);
    expect(m.winRate).toBe(0.5);
    // R: 8/(1*5)=1.6 ; -12/(2*5)=-1.2 ; 9/(1*10)=0.9 ; the fourth has no R unit -> mean(1.6,-1.2,0.9)=0.4333
    expect(m.tradesWithR).toBe(3);
    expect(m.expectancyR).toBeCloseTo((1.6 - 1.2 + 0.9) / 3, 12);
    // wins 8+9=17, losses 12+5=17
    expect(m.profitFactor).toBeCloseTo(1, 12);
    expect(m.averageWinUsd).toBeCloseTo(8.5, 12);
    expect(m.averageLossUsd).toBeCloseTo(-8.5, 12);
    // gross: 10 - 10 + 10 - 4 = 6 ; fees 6 ; net 0
    expect(m.grossPnlUsd).toBeCloseTo(6, 12);
    expect(m.feesUsd).toBeCloseTo(6, 12);
    expect(m.netPnlUsd).toBeCloseTo(0, 12);
    expect(m.feesPctOfGross).toBeCloseTo(100, 12);
    // Equity 1000 -> 1008 (peak) -> 996 (dd 12/1008) -> 1005 -> 1000 : max drawdown 12/1008
    expect(m.maxDrawdownPct).toBeCloseTo((12 / 1008) * 100, 10);
    // Peak at day 1 close (1008), never regained: under water from day 1 to the last close, day 7
    expect(m.timeUnderWaterMs).toBe(6 * 86_400_000);
  });
  it("handles no trades and no losses without inventing numbers", () => {
    expect(tradeMetrics([], 1000)).toMatchObject({ trades: 0, winRate: null, expectancyR: null, profitFactor: null, maxDrawdownPct: null });
    expect(tradeMetrics([t(0, 100, 110, 1, 1, 5)], 1000).profitFactor).toBeNull();
  });
  it("Sharpe and Sortino use a 365-day year", () => {
    const r = [0.01, -0.01, 0.02, 0.0];
    const m = (0.01 - 0.01 + 0.02 + 0) / 4; // 0.005
    const sd = Math.sqrt(((0.01 - m) ** 2 + (-0.01 - m) ** 2 + (0.02 - m) ** 2 + (0 - m) ** 2) / 3);
    const dd = Math.sqrt(0.01 ** 2 / 4);
    const out = riskAdjustedReturns(r);
    expect(out.sharpe).toBeCloseTo((m / sd) * Math.sqrt(365), 10);
    expect(out.sortino).toBeCloseTo((m / dd) * Math.sqrt(365), 10);
    expect(riskAdjustedReturns([0.01])).toEqual({ sharpe: null, sortino: null });
  });
  it("return against buy-and-hold", () => {
    const r = returnVsBuyAndHold(0.05, 100, 120);
    expect(r.buyAndHold).toBeCloseTo(0.2, 12);
    expect(r.difference).toBeCloseTo(-0.15, 12);
  });
});

describe("running time excludes gaps; calendar time stays alongside", () => {
  it("subtracts gap events once even when they overlap and clips them to the test period", () => {
    const start = new Date(T0);
    const end = new Date(T0 + 10 * 86_400_000);
    const d = (days: number) => new Date(T0 + days * 86_400_000);
    const r = runningTimeMs(start, end, [
      { from: d(1), to: d(2) },
      { from: d(1.5), to: d(3) },
      { from: d(-5), to: d(-4) }, // before the period
      { from: d(9), to: d(12) }, // runs past the end
    ]);
    expect(r.calendarMs).toBe(10 * 86_400_000);
    expect(r.gapMs).toBe(3 * 86_400_000); // days 1-3 and 9-10
    expect(r.runningMs).toBe(7 * 86_400_000);
  });
});

describe("no verdict before N", () => {
  const plan = verdictPlanOf({ targetSamples: 620, minRunningDays: 90 });
  it("defaults to about 620 samples and 3 months", () => {
    expect(verdictPlanOf(undefined)).toEqual({ targetSamples: 620, minRunningDays: 90 });
  });
  it("stays collecting until BOTH the sample size and the running time are reached", () => {
    const day = 86_400_000;
    expect(verdictStatus({ independentResolved: 619, runningMs: 200 * day, calendarMs: 200 * day, plan }).status).toBe("collecting");
    expect(verdictStatus({ independentResolved: 700, runningMs: 89 * day, calendarMs: 120 * day, plan }).status).toBe("collecting");
    expect(verdictStatus({ independentResolved: 620, runningMs: 90 * day, calendarMs: 91 * day, plan }).status).toBe("ready");
  });
  it("the collecting status carries no hit rate at all", () => {
    expect(Object.keys(verdictStatus({ independentResolved: 5, runningMs: 1, calendarMs: 1, plan })).sort()).toEqual(["calendarMs", "minRunningMs", "runningMs", "samples", "status", "targetSamples"]);
  });
});

describe("the verdict", () => {
  const mk = (n: number, hitEvery: number) =>
    Array.from({ length: n }, (_, i) => call({ i, outcome: i % hitEvery === 0 ? "miss" : "hit", baseRateUp: 0.5, direction: "up" }));
  it("finds an edge when the hit rate is well above the base rate and above every baseline", () => {
    const v = computeTradingVerdict({ independentCalls: mk(200, 5), baselinesOnSameBars: { "baseline:always_up": 0.5, "baseline:persistence": 0.52 }, horizonBars: 1, iterations: 400 });
    expect(v.hitRate).toBeCloseTo(0.8, 12);
    expect(v.result).toBe("edge_in_direction");
    expect(v.bestBaselineKey).toBe("baseline:persistence");
  });
  it("reports no edge for a hit rate near the base rate, or when a baseline does as well", () => {
    expect(computeTradingVerdict({ independentCalls: mk(200, 2), baselinesOnSameBars: {}, horizonBars: 1, iterations: 400 }).result).toBe("no_edge");
    expect(computeTradingVerdict({ independentCalls: mk(200, 5), baselinesOnSameBars: { "baseline:always_up": 0.85 }, horizonBars: 1, iterations: 400 })).toMatchObject({ result: "no_edge", beatsBaselines: false });
  });
});
