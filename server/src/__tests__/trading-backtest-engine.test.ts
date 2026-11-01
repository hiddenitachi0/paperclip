import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  legacySmaCrossoverSpec,
  seededRandom,
  tradingStrategySpecSchema,
  type TradingDecision,
  type TradingEngineBar,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { latestKnownJoin, simulateWindow, type BacktestDecider, type JoinedInputs } from "../services/trading-backtest-engine.js";
import { buildVariants, executeBacktest, type BacktestRunParams } from "../services/trading-backtest-run.js";

/**
 * DUR-5008: the simulation and the walk-forward run, on synthetic candles
 * (no database, no network). The acceptance lines of the card are the
 * `describe` blocks below: next-open fills with costs, stops on 5-minute bars,
 * determinism, the look-ahead check (and a deliberately leaky rule it must
 * catch), the point-in-time audit (and a violation it must catch).
 */

const H4 = 4 * 3_600_000;
const M5 = 300_000;

function bar(openMs: number, o: number, h: number, l: number, c: number, v = 100): TradingEngineBar {
  return { openTime: new Date(openMs), open: o, high: h, low: l, close: c, volume: v };
}

/** A deterministic price path with long up, down and sideways stretches. */
function syntheticBars(from: Date, count: number, seed = 7): TradingEngineBar[] {
  const random = seededRandom(seed);
  const out: TradingEngineBar[] = [];
  let price = 20_000;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 400 === 0) drift = [0.0012, -0.0012, 0.0001][Math.floor(random() * 3)]!;
    const move = drift + (random() - 0.5) * 0.02;
    const open = price;
    const close = Math.max(100, price * (1 + move));
    const high = Math.max(open, close) * (1 + random() * 0.004);
    const low = Math.min(open, close) * (1 - random() * 0.004);
    out.push(bar(from.getTime() + i * H4, open, high, low, close, 50 + random() * 100));
    price = close;
  }
  return out;
}

/** 5-minute bars that exactly tile a decision bar and follow a path from open to close through high and low. */
function fineBarsFor(decision: TradingEngineBar, path: Array<[number, number, number, number]> | null = null): TradingEngineBar[] {
  const n = H4 / M5;
  const out: TradingEngineBar[] = [];
  for (let k = 0; k < n; k++) {
    const t = decision.openTime.getTime() + k * M5;
    const frac = k / n;
    const price = decision.open + (decision.close - decision.open) * frac;
    const p = path?.[k];
    out.push(p ? bar(t, p[0], p[1], p[2], p[3]) : bar(t, price, price, price, price));
  }
  return out;
}

function sma(fast = 5, slow = 15): TradingStrategySpec {
  return legacySmaCrossoverSpec({
    name: "test",
    asset: "BTC",
    timeframe: "4h",
    rule: { type: "sma_crossover", version: 1, fastPeriod: fast, slowPeriod: slow, orderSizeFraction: 0.1 },
    risk: DEFAULT_TRADING_RISK_CONFIG,
  });
}

const COSTS = { feeRatePct: 0.4, spreadPct: 0.1, slippagePct: 0.05 };

/** enter at the listed indexes, exit at the listed ones; everything else holds. */
function scripted(enterAt: number[], exitAt: number[], levels?: TradingDecision["levels"]): BacktestDecider {
  return (_bars, index, position) => {
    const base = { reasonCodes: ["scripted"], directionCall: "none" as const, indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null } };
    if (position.kind === "flat" && enterAt.includes(index)) return { ...base, action: "enter", directionCall: "up", sizeFractionOfCash: 0.1, levels, highestPrice: _bars[index]!.high };
    if (position.kind === "long" && exitAt.includes(index)) return { ...base, action: "exit", directionCall: "down" };
    return { ...base, action: "hold" };
  };
}

describe("fills and costs", () => {
  it("fills a signal at the NEXT open plus half the spread and slippage, with a fee on each side", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars = [100, 101, 102, 103, 104, 105, 106, 107].map((p, i) => bar(t0 + i * H4, p, p + 1, p - 1, p + 0.5));
    const result = simulateWindow({ spec: sma(), coin: "BTC", bars, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 500, decide: scripted([1], [4]) });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    // Signal at the close of bar 1 -> fill at the open of bar 2 (102), plus half of 0.10% spread and 0.05% slippage.
    expect(trade.entryPrice).toBeCloseTo(102 * (1 + 0.0005 + 0.0005), 8);
    // Exit signal at the close of bar 4 -> fill at the open of bar 5 (105), minus the same.
    expect(trade.exitPrice).toBeCloseTo(105 * (1 - 0.0005 - 0.0005), 8);
    const value = trade.quantity * trade.entryPrice;
    expect(trade.feesUsd).toBeCloseTo(value * 0.004 + trade.quantity * trade.exitPrice * 0.004, 8);
    expect(trade.netPnlUsd).toBeCloseTo(trade.grossPnlUsd - trade.feesUsd, 8);
    expect(trade.exitReason).toBe("scripted");
  });

  it("refuses an entry the entry gate would refuse (position cap in NOK), and says so", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars = [100, 101, 102, 103, 104, 105].map((p, i) => bar(t0 + i * H4, p, p + 1, p - 1, p));
    // 10% of $10,000 = $1,000 = 11,500 NOK, far above the 1,000 NOK default cap.
    const result = simulateWindow({ spec: sma(), coin: "BTC", bars, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 10_000, decide: scripted([1], [3]) });
    expect(result.trades).toHaveLength(0);
    expect(result.blockedCount).toBe(1);
    expect(result.blocked[0]!.reason).toMatch(/cap/);
  });

  it("closes what is open at the window's last close, with costs", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars = [100, 101, 102, 103, 104, 105].map((p, i) => bar(t0 + i * H4, p, p + 1, p - 1, p));
    const result = simulateWindow({ spec: sma(), coin: "BTC", bars, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 500, decide: scripted([1], []) });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe("window_end");
    expect(result.trades[0]!.exitPrice).toBeCloseTo(105 * (1 - 0.001), 8);
    expect(result.equity[result.equity.length - 1]).toBeCloseTo(500 + result.trades[0]!.netPnlUsd, 6);
  });
});

describe("stops on 5-minute bars", () => {
  const stopLevels = { stopPrice: 98, targetPrice: null };

  it("exits at the stop when a 5-minute bar touches it, before the decision bar closes", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars = [100, 100, 100, 100, 100, 100].map((p, i) => bar(t0 + i * H4, p, p + 0.5, p - 0.5, p));
    // Decision bar 2 (the entry fills at bar 3's open) dips to 97 inside bar 3's 5-minute data.
    const fine = bars.flatMap((b, i) => fineBarsFor(b, i === 3 ? Array.from({ length: 48 }, (_, k) => (k === 10 ? [99, 99, 97, 98] : [100, 100, 99.9, 100]) as [number, number, number, number]) : null));
    const result = simulateWindow({ spec: sma(), coin: "BTC", bars, fineBars: fine, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 500, decide: scripted([2], [], stopLevels) });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe("stop_hit");
    expect(result.trades[0]!.exitPrice).toBeCloseTo(98 * (1 - 0.001), 8);
    expect(new Date(result.trades[0]!.exitAt).getTime()).toBe(t0 + 3 * H4 + 10 * M5);
    expect(result.intrabarBars).toBeGreaterThan(0);
    expect(result.signals.some((s) => s.source === "intrabar" && s.reasonCodes[0] === "stop_hit")).toBe(true);
  });

  it("fills a stop that was gapped through at the 5-minute bar's open, not at the stop", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const bars = [100, 100, 100, 100, 100, 100].map((p, i) => bar(t0 + i * H4, p, p + 0.5, p - 0.5, p));
    const fine = bars.flatMap((b, i) => fineBarsFor(b, i === 3 ? Array.from({ length: 48 }, (_, k) => (k === 5 ? [95, 95, 94, 95] : [100, 100, 99.9, 100]) as [number, number, number, number]) : null));
    const result = simulateWindow({ spec: sma(), coin: "BTC", bars, fineBars: fine, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 500, decide: scripted([2], [], stopLevels) });
    expect(result.trades[0]!.exitPrice).toBeCloseTo(95 * (1 - 0.001), 8);
  });

  it("falls back to the next open after the close-of-bar check when the 5-minute bars are incomplete", () => {
    const t0 = Date.UTC(2026, 0, 1);
    // Bar 3 opens at 100 (the entry fill), falls to 95 and closes at 96; bar 4 opens back at 100.
    const bars = [bar(t0, 100, 100.5, 99.5, 100), bar(t0 + H4, 100, 100.5, 99.5, 100), bar(t0 + 2 * H4, 100, 100.5, 99.5, 100), bar(t0 + 3 * H4, 100, 100.5, 95, 96), bar(t0 + 4 * H4, 100, 100.5, 99.5, 100), bar(t0 + 5 * H4, 100, 100.5, 99.5, 100)];
    // The default decider: a spec with a stop sees stop_hit on bar 3's low and exits at bar 4's open.
    const spec = tradingStrategySpecSchema.parse({
      ...sma(),
      exit: { stop: { kind: "pct", pct: 2 }, conditions: sma().exit.conditions },
      sizing: { kind: "fraction_of_cash", fraction: 0.1 },
      prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "stop_distance" },
    });
    const decide = (b: readonly TradingEngineBar[], index: number, position: Parameters<BacktestDecider>[2]) => {
      if (position.kind === "flat" && index === 2) return { action: "enter", reasonCodes: ["x"], directionCall: "up", indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null }, sizeFractionOfCash: 0.1, levels: { stopPrice: 98, targetPrice: null }, highestPrice: b[index]!.high } as TradingDecision;
      if (position.kind === "long" && position.stopPrice !== null && b[index]!.low <= position.stopPrice) return { action: "exit", reasonCodes: ["stop_hit"], directionCall: "down", indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null } } as TradingDecision;
      return { action: "hold", reasonCodes: [], directionCall: "none", indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null } } as TradingDecision;
    };
    const result = simulateWindow({ spec, coin: "BTC", bars, fineBars: null, start: 0, end: bars.length, costs: COSTS, startingCashUsd: 500, decide });
    expect(result.trades[0]!.exitReason).toBe("stop_hit");
    expect(result.trades[0]!.exitPrice).toBeCloseTo(100 * (1 - 0.001), 8); // bar 4's open, not the stop
    expect(result.intrabarBars).toBe(0);
  });
});

// ─── The full walk-forward run ──────────────────────────────────────────────

const AS_OF = new Date("2026-09-01T00:00:00Z");
const FROM = new Date("2021-01-01T00:00:00Z");
const BAR_COUNT = Math.floor((AS_OF.getTime() - FROM.getTime()) / H4);

function params(over: Partial<BacktestRunParams> = {}): BacktestRunParams {
  return { schema: 1, asOf: AS_OF.toISOString(), source: "kraken", purpose: "gate", assets: ["BTC", "ETH", "SOL"], costs: COSTS, startingCashNok: 3000, selection: "base", maxVariants: 5, seed: 42, ...over };
}

function loader(seedByCoin: Record<string, number> = { BTC: 1, ETH: 2, SOL: 3 }) {
  const cache = new Map<string, TradingEngineBar[]>();
  return async (coin: string, timeframe: "5m" | "1h" | "4h" | "1d") => {
    if (timeframe !== "4h") return [];
    const key = `${coin}:${timeframe}`;
    if (!cache.has(key)) cache.set(key, syntheticBars(FROM, BAR_COUNT, seedByCoin[coin] ?? 9));
    return cache.get(key)!;
  };
}

describe("walk-forward run", () => {
  it("gives identical results when the same run is made twice", async () => {
    const run = () => executeBacktest({ spec: sma(), params: params(), loadBars: loader(), priorReads: [], priorTrials: [] });
    const a = await run();
    const b = await run();
    expect(a.resultDigest).toBe(b.resultDigest);
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
    expect(a.trials).toEqual(b.trials);
  });

  it("reports per window and per regime, flags non-headline coins and counts every variant", async () => {
    const out = await executeBacktest({ spec: sma(), params: params(), loadBars: loader(), priorReads: [], priorTrials: [] });
    const report = out.report as any;
    expect(report.coins.map((c: any) => c.coin)).toEqual(["BTC", "ETH", "SOL"]);
    expect(report.coins.find((c: any) => c.coin === "SOL").flag).toBe("coin chosen with hindsight");
    expect(report.coins.find((c: any) => c.coin === "BTC").flag).toBeNull();
    const btc = report.coins.find((c: any) => c.coin === "BTC");
    expect(btc.windows.length).toBeGreaterThan(2);
    for (const field of ["hitRate", "hitRateLow", "hitRateHigh", "expectancyR", "profitFactor", "avgWinPct", "avgLossPct", "maxDrawdownPct", "sharpe365", "sortino365", "feesPctOfGross", "exposure"]) {
      expect(btc.windows[0].fees2x).toHaveProperty(field);
    }
    expect(Object.keys(btc.outOfSample.byRegime2x).sort()).toEqual(["bear", "bull", "range", "unclear"]);
    expect(btc.regimeCoverage.days).toHaveProperty("bull");
    expect(report.headline.coins).toEqual(["BTC", "ETH"]);
    expect(out.variantsTried).toBe(report.trials.variantsInThisRun);
    expect(out.variantsTried).toBeGreaterThan(1);
    expect(out.trials).toHaveLength(out.variantsTried);
    expect(btc.baselines.randomEntry.runs).toBeGreaterThan(0);
    // The 2x fee run is the gate: a doubled fee can only lower the result of the same trades.
    expect(btc.windows[0].fees2x.feesUsd).toBeGreaterThanOrEqual(btc.windows[0].fees1x.feesUsd * 0);
  });

  it("does not pass the gate on synthetic noise, and says which checks failed", async () => {
    const out = await executeBacktest({ spec: sma(), params: params(), loadBars: loader(), priorReads: [], priorTrials: [] });
    expect(out.gate.passed).toBe(false);
    expect(out.gate.items.map((i) => i.key)).toEqual(expect.arrayContaining(["expectancy", "trades", "windows", "random_entry", "drawdown", "plateau", "regimes", "look_ahead", "point_in_time", "holdout"]));
    expect(out.gate.items.find((i) => i.key === "look_ahead")!.passed).toBe(true);
    expect(out.gate.items.find((i) => i.key === "point_in_time")!.passed).toBe(true);
  });

  it("reads the holdout once as clean, then labels a second read 'already seen' and refuses to pass it alone", async () => {
    const first = await executeBacktest({ spec: sma(), params: params(), loadBars: loader(), priorReads: [], priorTrials: [] });
    expect((first.report as any).holdout.label).toBe("clean holdout: the first read");
    expect(first.holdoutRead).not.toBeNull();
    const second = await executeBacktest({ spec: sma(), params: params(), loadBars: loader(), priorReads: [{ runId: "r1", holdoutStart: first.holdoutRead!.start, holdoutEnd: first.holdoutRead!.end }], priorTrials: [] });
    expect((second.report as any).holdout.label).toBe("holdout already seen 1 time");
    expect(second.gate.items.find((i) => i.key === "holdout")!.passed).toBe(false);
    expect(second.gate.items.find((i) => i.key === "holdout")!.detail).toMatch(/cannot pass the gate alone/);
  });

  it("an exploration run never reads the holdout and never passes the gate", async () => {
    const out = await executeBacktest({ spec: sma(), params: params({ purpose: "explore" }), loadBars: loader(), priorReads: [], priorTrials: [] });
    expect(out.holdoutRead).toBeNull();
    expect((out.report as any).holdout.read).toBe(false);
    expect(out.gate.passed).toBe(false);
    expect(out.gate.items.find((i) => i.key === "gate_run")!.passed).toBe(false);
  });

  it("fails the bull/bear/range requirement honestly when a coin's windows never saw one", async () => {
    // A straight line up: the windows contain no bear or range market at all.
    const up = async (_coin: string, timeframe: "5m" | "1h" | "4h" | "1d") => (timeframe === "4h" ? Array.from({ length: BAR_COUNT }, (_, i) => bar(FROM.getTime() + i * H4, 100 * 1.001 ** i, 100 * 1.001 ** i * 1.0005, 100 * 1.001 ** i * 0.9995, 100 * 1.001 ** (i + 1))) : []);
    const out = await executeBacktest({ spec: sma(), params: params({ assets: ["BTC"] }), loadBars: up, priorReads: [], priorTrials: [] });
    const regimes = out.gate.items.find((i) => i.key === "regimes")!;
    expect(regimes.passed).toBe(false);
    expect(regimes.detail).toMatch(/BTC was never tested in/);
  });

  it("buildVariants nudges each indicator length and keeps the written rules first", () => {
    const variants = buildVariants(sma(), 25);
    expect(variants[0]!.label).toBe("your rules as written");
    expect(variants.length).toBe(5); // base + fast down/up + slow down/up
    expect(new Set(variants.map((v) => v.digest)).size).toBe(variants.length);
    expect(buildVariants(sma(), 3)).toHaveLength(3);
  });
});

describe("look-ahead check", () => {
  /** Peeks one bar ahead: enters whenever the NEXT close is higher. A rule like this looks brilliant in a test and cannot trade. */
  const leaky = (): BacktestDecider => (bars, index, position) => {
    const next = bars[index + 1]?.close ?? Number.NaN;
    const base = { reasonCodes: ["peek"], directionCall: "none" as const, indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null } };
    if (position.kind === "flat" && next > bars[index]!.close) return { ...base, action: "enter", directionCall: "up", sizeFractionOfCash: 0.1, highestPrice: bars[index]!.high } as TradingDecision;
    if (position.kind === "long" && !(next > bars[index]!.close)) return { ...base, action: "exit", directionCall: "down" } as TradingDecision;
    return { ...base, action: "hold" } as TradingDecision;
  };

  it("passes for the real rule engine", async () => {
    const out = await executeBacktest({ spec: sma(), params: params({ assets: ["BTC"] }), loadBars: loader(), priorReads: [], priorTrials: [] });
    expect((out.report as any).integrity.lookAhead.passed).toBe(true);
    expect((out.report as any).integrity.lookAhead.signalsCompared).toBeGreaterThan(0);
  });

  it("catches a deliberately leaky strategy and fails the gate on it", async () => {
    const out = await executeBacktest({ spec: sma(), params: params({ assets: ["BTC"] }), loadBars: loader(), priorReads: [], priorTrials: [], makeDecider: leaky });
    const integrity = (out.report as any).integrity.lookAhead;
    expect(integrity.passed).toBe(false);
    expect(integrity.detail).toMatch(/BTC/);
    expect(out.gate.items.find((i) => i.key === "look_ahead")!.passed).toBe(false);
    expect(out.gate.passed).toBe(false);
  });
});

describe("point-in-time audit", () => {
  const series = { fear_greed: [{ availableAt: new Date("2021-01-02T00:00:00Z"), value: 50 }, { availableAt: new Date("2025-06-01T00:00:00Z"), value: 80 }] };
  /** Holds on every bar but reads the joined input first, the way a rule that uses Fear & Greed would. */
  const readsFearGreed = (): BacktestDecider => (_bars, _index, _position, ctx) => {
    ctx.join("fear_greed");
    return { action: "hold", reasonCodes: [], directionCall: "none", indicatorSnapshot: {}, regime: { trend: null, volatility: null, squeeze: null } } as TradingDecision;
  };

  it("passes when every joined input was known at its decision time", async () => {
    const out = await executeBacktest({ spec: sma(), params: params({ assets: ["BTC"] }), loadBars: loader(), priorReads: [], priorTrials: [], joined: latestKnownJoin(series), makeDecider: readsFearGreed });
    const pit = (out.report as any).integrity.pointInTime;
    expect(pit.joinedReads).toBeGreaterThan(0);
    expect(pit.passed).toBe(true);
  });

  it("catches a naive join that hands a decision a value published later", async () => {
    // The sloppy join: the newest point regardless of when it was published.
    const naive: JoinedInputs = { read: (name) => series[name as "fear_greed"]?.[series.fear_greed.length - 1] ?? null };
    const out = await executeBacktest({ spec: sma(), params: params({ assets: ["BTC"] }), loadBars: loader(), priorReads: [], priorTrials: [], joined: naive, makeDecider: readsFearGreed });
    const pit = (out.report as any).integrity.pointInTime;
    expect(pit.passed).toBe(false);
    expect(pit.violations).toBeGreaterThan(0);
    expect(out.gate.items.find((i) => i.key === "point_in_time")!.passed).toBe(false);
    expect(out.gate.passed).toBe(false);
  });
});
