import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_EXPERIMENT_LIMITS,
  TRADING_EXPERIMENT_RECOMMEND,
  canonicalExperimentGrid,
  legacySmaCrossoverSpec,
  queueTradingExperimentSchema,
  seededRandom,
  traderProposeChangeSchema,
  type TradingEngineBar,
  type TradingExperimentAxis,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { BacktestRefusal, type VariantStat } from "../services/trading-backtest-run.js";
import { buildExperimentVariants, decideExperiment, executeExperiment, validateExperimentGrid, type ExperimentParams } from "../services/trading-experiment-run.js";

/**
 * DUR-5018: the experiment runner's pure core, on synthetic candles (no
 * database, no network). Acceptance lines: results are reproducible, trial
 * counts and the Deflated Sharpe / plateau / holdout-read numbers are in the
 * result, an experiment never reads the holdout, and the grid is capped.
 */

const H4 = 4 * 3_600_000;
const AS_OF = new Date("2026-09-01T00:00:00Z");
const FROM = new Date("2021-01-01T00:00:00Z");
const BAR_COUNT = Math.floor((AS_OF.getTime() - FROM.getTime()) / H4);
const COSTS = { feeRatePct: 0.4, spreadPct: 0.1, slippagePct: 0.05 };

function syntheticBars(count: number, seed: number): TradingEngineBar[] {
  const random = seededRandom(seed);
  const out: TradingEngineBar[] = [];
  let price = 20_000;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 400 === 0) drift = [0.0012, -0.0012, 0.0001][Math.floor(random() * 3)]!;
    const open = price;
    const close = Math.max(100, price * (1 + drift + (random() - 0.5) * 0.02));
    out.push({ openTime: new Date(FROM.getTime() + i * H4), open, high: Math.max(open, close) * (1 + random() * 0.004), low: Math.min(open, close) * (1 - random() * 0.004), close, volume: 50 + random() * 100 });
    price = close;
  }
  return out;
}

const cache = new Map<string, TradingEngineBar[]>();
const loadBars = async (coin: string, timeframe: "5m" | "1h" | "4h" | "1d") => {
  if (timeframe !== "4h") return [];
  const key = coin;
  if (!cache.has(key)) cache.set(key, syntheticBars(BAR_COUNT, coin === "BTC" ? 1 : 2));
  return cache.get(key)!;
};

function sma(fast = 5, slow = 15): TradingStrategySpec {
  return legacySmaCrossoverSpec({ name: "test", asset: "BTC", timeframe: "4h", rule: { type: "sma_crossover", version: 1, fastPeriod: fast, slowPeriod: slow, orderSizeFraction: 0.1 }, risk: DEFAULT_TRADING_RISK_CONFIG });
}

function params(grid: TradingExperimentAxis[] | null, over: Partial<ExperimentParams> = {}): ExperimentParams {
  return { schema: 1, asOf: AS_OF.toISOString(), source: "kraken", purpose: "explore", assets: ["BTC", "ETH"], costs: COSTS, startingCashNok: 3000, selection: "base", maxVariants: TRADING_EXPERIMENT_LIMITS.maxVariants, seed: 42, grid, ...over };
}

const GRID: TradingExperimentAxis[] = [{ indicator: "slow", param: "period", values: [10, 15, 20, 25] }];

describe("grid", () => {
  it("builds the rules as written first, then one variant per distinct combination", () => {
    const variants = buildExperimentVariants(sma(), canonicalExperimentGrid(GRID));
    expect(variants[0]!.label).toBe("your rules as written");
    // slow=15 is the base itself, so the four values make three new variants.
    expect(variants.map((v) => v.coords["slow.period"])).toEqual([15, 10, 20, 25]);
    expect(new Set(variants.map((v) => v.digest)).size).toBe(variants.length);
  });

  it("takes the cross product of up to three settings", () => {
    const grid = canonicalExperimentGrid([
      { indicator: "fast", param: "period", values: [4, 6] },
      { indicator: "slow", param: "period", values: [12, 18] },
    ]);
    const variants = buildExperimentVariants(sma(), grid);
    expect(variants).toHaveLength(5);
    expect(variants.slice(1).map((v) => [v.coords["fast.period"], v.coords["slow.period"]])).toEqual([[4, 12], [4, 18], [6, 12], [6, 18]]);
  });

  it("canonicalises a grid so the same grid always has the same shape", () => {
    expect(canonicalExperimentGrid([{ indicator: "slow", param: "period", values: [25, 10, 10, 20] }])).toEqual([{ indicator: "slow", param: "period", values: [10, 20, 25] }]);
  });

  it("refuses a setting the rules do not have, a fractional length, a repeated axis and an oversized grid", () => {
    expect(() => validateExperimentGrid(sma(), [{ indicator: "nope", param: "period", values: [3] }])).toThrow(BacktestRefusal);
    expect(() => validateExperimentGrid(sma(), [{ indicator: "slow", param: "period", values: [10.5] }])).toThrow(/whole number/);
    expect(() => validateExperimentGrid(sma(), [{ indicator: "slow", param: "period", values: [10] }, { indicator: "slow", param: "period", values: [12] }])).toThrow(/twice/);
    const big: TradingExperimentAxis[] = [
      { indicator: "fast", param: "period", values: Array.from({ length: 8 }, (_, i) => i + 2) },
      { indicator: "slow", param: "period", values: Array.from({ length: 8 }, (_, i) => i + 20) },
    ];
    expect(() => validateExperimentGrid(sma(), big)).toThrow(/64 combinations; at most 49/);
    expect(() => validateExperimentGrid(sma(), [{ indicator: "slow", param: "period", values: [10, 20] }])).not.toThrow();
  });

  it("the request schema caps axes and values per axis and refuses unknown fields", () => {
    expect(queueTradingExperimentSchema.safeParse({ grid: GRID }).success).toBe(true);
    expect(queueTradingExperimentSchema.safeParse({}).success).toBe(true);
    expect(queueTradingExperimentSchema.safeParse({ grid: [] }).success).toBe(false);
    expect(queueTradingExperimentSchema.safeParse({ grid: Array.from({ length: 4 }, (_, i) => ({ indicator: `i${i}`, param: "period", values: [3] })) }).success).toBe(false);
    expect(queueTradingExperimentSchema.safeParse({ grid: [{ indicator: "slow", param: "period", values: Array.from({ length: 16 }, (_, i) => i + 2) }] }).success).toBe(false);
    expect(queueTradingExperimentSchema.safeParse({ purpose: "gate" }).success).toBe(false);
    expect(queueTradingExperimentSchema.safeParse({ grid: [{ indicator: "slow", param: "stopPct", values: [3] }] }).success).toBe(false);
  });

  it("falls back to the automatic neighbours when there is no grid", () => {
    const variants = buildExperimentVariants(sma(), null);
    expect(variants).toHaveLength(5);
    expect(variants[0]!.coords).toEqual({ "fast.period": 5, "slow.period": 15 });
  });
});

describe("the proposal schema", () => {
  const spec = sma();
  it("refuses a proposal without an experiment id, with a plain reason", () => {
    const r = traderProposeChangeSchema.safeParse({ spec, summary: "tune it", reasons: "because" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? {} : r.error.issues)).toMatch(/experimentId|Cite the experiment/);
  });
  it("refuses an experiment id that is not a uuid, and accepts a uuid", () => {
    expect(traderProposeChangeSchema.safeParse({ experimentId: "abc", spec, summary: "tune it", reasons: "because" }).success).toBe(false);
    expect(traderProposeChangeSchema.safeParse({ experimentId: "6f1c9a52-0b5d-4c7e-9a41-2f4a3a1d7e10", spec, summary: "tune it", reasons: "because" }).success).toBe(true);
  });
});

function stat(over: Partial<VariantStat> & { label: string }): VariantStat {
  return { digest: over.label.padEnd(64, "0").slice(0, 64), trades: 150, expectancyR: 0.2, meanTradeReturn: 0.01, positive: true, oosSharpe: 0.05, observations: 3000, deflatedSharpeProbability: 0.99, ...over };
}

describe("the recommendation", () => {
  const variants = buildExperimentVariants(sma(), canonicalExperimentGrid([{ indicator: "slow", param: "period", values: [9, 11, 13, 15, 17, 19, 21] }]));
  // variants: base(15), 9, 11, 13, 17, 19, 21 -> coords on one axis, so every other variant is a neighbour of every variant.

  it("recommends the best variant only when every check passes, and says so", () => {
    const stats = variants.map((v, k) => stat({ label: v.label, oosSharpe: k === 3 ? 0.09 : 0.04 }));
    const d = decideExperiment(variants, stats);
    expect(d.recommendation.decision).toBe("recommend");
    expect(d.recommendedIndex).toBe(3);
    expect(d.recommendation.checks.every((c) => c.passed)).toBe(true);
    expect(d.plateau).toMatchObject({ applicable: true, passed: true });
  });

  it("says 'no change' when the best variant does not beat the rules as written", () => {
    const stats = variants.map((v, k) => stat({ label: v.label, oosSharpe: k === 0 ? 0.1 : 0.04 }));
    const d = decideExperiment(variants, stats);
    expect(d.recommendation.decision).toBe("no_change");
    expect(d.recommendation.variantDigest).toBeNull();
    expect(d.recommendation.checks.find((c) => c.key === "beats_base")!.passed).toBe(false);
  });

  it.each([
    ["too few trades", { trades: TRADING_EXPERIMENT_RECOMMEND.minOutOfSampleTrades - 1 }, "enough_trades"],
    ["a low Deflated Sharpe", { deflatedSharpeProbability: 0.6 }, "deflated_sharpe"],
    ["a negative average trade", { positive: false }, "positive_after_fees"],
  ])("says 'no change' for %s", (_name, over, failed) => {
    const stats = variants.map((v, k) => stat({ label: v.label, oosSharpe: k === 3 ? 0.09 : 0.04, ...(k === 3 ? over : {}) }));
    const d = decideExperiment(variants, stats);
    expect(d.recommendation.decision).toBe("no_change");
    expect(d.recommendation.checks.find((c) => c.key === failed)!.passed).toBe(false);
  });

  it("says 'no change' when the winner is a lone spike: its neighbours are not positive", () => {
    const stats = variants.map((v, k) => stat({ label: v.label, oosSharpe: k === 3 ? 0.09 : 0.04, positive: k === 3 }));
    const d = decideExperiment(variants, stats);
    expect(d.recommendation.decision).toBe("no_change");
    expect(d.plateau.passed).toBe(false);
    expect(d.recommendation.summary).toMatch(/^No change/);
  });

  it("does not call two neighbours a plateau when the grid has fewer than the minimum", () => {
    const small = buildExperimentVariants(sma(), canonicalExperimentGrid([{ indicator: "slow", param: "period", values: [20] }]));
    const stats = small.map((v, k) => stat({ label: v.label, oosSharpe: k === 1 ? 0.09 : 0.04 }));
    const d = decideExperiment(small, stats);
    expect(d.plateau.applicable).toBe(false);
    expect(d.recommendation.decision).toBe("no_change");
  });
});

describe("a whole experiment", () => {
  const run = (over: Partial<ExperimentParams> = {}, priorTrials: Array<{ variantDigest: string; oosSharpe: number | null }> = []) =>
    executeExperiment({ spec: sma(), params: params(canonicalExperimentGrid(GRID), over), loadBars, priorReads: [], priorTrials });

  it("is reproducible: the same experiment twice gives byte-identical results", async () => {
    const a = await run();
    const b = await run();
    expect(a.resultDigest).toBe(b.resultDigest);
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
    expect(a.trials).toEqual(b.trials);
    expect(a.recommendation).toEqual(b.recommendation);
  });

  it("records the trial count, the Deflated Sharpe, the plateau check and the holdout reads, and never reads the holdout", async () => {
    const out = await run({}, [{ variantDigest: "f".repeat(64), oosSharpe: 0.02 }, { variantDigest: "e".repeat(64), oosSharpe: 0.01 }]);
    const report = out.report as any;
    expect(out.trialCount).toBe(4); // base + 10, 20, 25
    expect(report.trialCount).toBe(4);
    expect(out.registryTrialCount).toBe(6); // 4 here + 2 earlier in the lineage
    expect(report.registryTrialCount).toBe(6);
    expect(report.deflatedSharpe).toHaveProperty("probability");
    expect(report.deflatedSharpe.trialsCounted).toBe(6);
    expect(report.plateau).toHaveProperty("neighbours");
    expect(report.holdoutReads).toEqual({ lineageBefore: 0, madeByThisExperiment: 0 });
    expect(out.backtest.holdoutRead).toBeNull();
    expect(out.backtest.gate.passed).toBe(false);
    expect(["recommend", "no_change"]).toContain(report.recommendation.decision);
    expect(out.trials).toHaveLength(4);
    expect(report.note).toMatch(/suggestion only/i);
  });

  it("counts earlier holdout reads of the lineage without making one", async () => {
    const out = await executeExperiment({
      spec: sma(),
      params: params(canonicalExperimentGrid(GRID)),
      loadBars,
      priorReads: [{ runId: "r1", holdoutStart: "2025-09-01T00:00:00.000Z", holdoutEnd: "2026-09-01T00:00:00.000Z" }],
      priorTrials: [],
    });
    expect(out.holdoutReadsLineage).toBe(1);
    expect((out.report as any).holdoutReads).toEqual({ lineageBefore: 1, madeByThisExperiment: 0 });
    expect(out.backtest.holdoutRead).toBeNull();
  });

  it("refuses to be run as a gate run or with re-tuning", async () => {
    await expect(run({ purpose: "gate" })).rejects.toThrow(/never reads the holdout/);
    await expect(run({ selection: "best_in_sample" })).rejects.toThrow(/never reads the holdout/);
  });

  it("refuses a grid with nothing to compare", async () => {
    await expect(executeExperiment({ spec: sma(), params: params([{ indicator: "slow", param: "period", values: [15] }]), loadBars, priorReads: [], priorTrials: [] })).rejects.toThrow(/nothing to compare/);
  });

  it("the more variants the lineage already tried, the harsher the Deflated Sharpe (it cannot be gamed by experimenting)", async () => {
    const fresh = await run();
    const crowded = await run({}, Array.from({ length: 200 }, (_, i) => ({ variantDigest: i.toString(16).padStart(64, "0"), oosSharpe: (i % 17) / 100 })));
    const f = (fresh.report as any).deflatedSharpe.probability as number | null;
    const c = (crowded.report as any).deflatedSharpe.probability as number | null;
    if (f !== null && c !== null) expect(c).toBeLessThanOrEqual(f);
    expect(crowded.registryTrialCount).toBeGreaterThan(fresh.registryTrialCount);
  });
});
