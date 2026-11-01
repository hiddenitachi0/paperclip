import { describe, expect, it } from "vitest";
import { seededRandom, tradingTemplates, tradingTimeframeMs, type TradingEngineBar } from "@paperclipai/shared";
import { executeBacktest, type BacktestRunParams } from "../services/trading-backtest-run.js";

/**
 * DUR-5014: every template runs through the DUR-5008 runner without error, on
 * synthetic candles (no database, no network). This proves the templates are
 * runnable by the real engine, that the report carries the 1x and 2x fee runs,
 * that the controls behave as controls, and that a rerun gives the same
 * digest. It says nothing about whether a template makes money: the stored
 * reports on the real candle store do that.
 */

const AS_OF = new Date("2026-09-01T00:00:00Z");
const FROM = new Date("2021-01-01T00:00:00Z");
const COSTS = { feeRatePct: 0.4, spreadPct: 0.1, slippagePct: 0.05 };

function syntheticBars(tfMs: number, seed: number): TradingEngineBar[] {
  const random = seededRandom(seed);
  const count = Math.floor((AS_OF.getTime() - FROM.getTime()) / tfMs);
  const out: TradingEngineBar[] = [];
  let price = 20_000;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 400 === 0) drift = [0.0012, -0.0012, 0.0001][Math.floor(random() * 3)]!;
    const move = drift + (random() - 0.5) * 0.02;
    const open = price;
    const close = Math.max(100, price * (1 + move));
    out.push({ openTime: new Date(FROM.getTime() + i * tfMs), open, high: Math.max(open, close) * (1 + random() * 0.004), low: Math.min(open, close) * (1 - random() * 0.004), close, volume: 50 + random() * 100 * (random() < 0.05 ? 6 : 1) });
    price = close;
  }
  return out;
}

function params(assets: string[], maxVariants: number): BacktestRunParams {
  return { schema: 1, asOf: AS_OF.toISOString(), source: "kraken", purpose: "gate", assets, costs: COSTS, startingCashNok: 3_000, selection: "base", maxVariants, seed: 42 };
}

describe("every template runs through the past-data runner", () => {
  const cache = new Map<string, TradingEngineBar[]>();
  const loader = async (coin: string, timeframe: "5m" | "1h" | "4h" | "1d") => {
    if (timeframe === "5m") return [];
    const key = `${coin}:${timeframe}`;
    if (!cache.has(key)) cache.set(key, syntheticBars(tradingTimeframeMs(timeframe), coin === "BTC" ? 1 : 2));
    return cache.get(key)!;
  };

  it.each(tradingTemplates().map((t) => [t.key, t] as const))("%s", async (_key, template) => {
    const run = () => executeBacktest({ spec: template.spec, params: params([...template.spec.universe.assets], template.spec.meta.family === "control" ? 1 : 3), loadBars: loader, priorReads: [], priorTrials: [] });
    const out = await run();
    const report = out.report as { costs: { fees1x: unknown; fees2x: unknown }; skippedCoins: unknown[]; headline: { outOfSample: { fees2x: { trades: number } } }; trials: { variantsInThisRun: number } };
    expect(report.skippedCoins).toEqual([]);
    expect(report.costs.fees1x).toBeTruthy();
    expect(report.costs.fees2x).toBeTruthy();
    expect(typeof out.gate.passed).toBe("boolean");
    expect(out.holdoutRead).not.toBeNull();
    if (template.spec.meta.family === "control") expect(report.trials.variantsInThisRun).toBe(1);
    if (template.key === "stay_in_cash") expect(report.headline.outOfSample.fees2x.trades).toBe(0);
    if (template.key === "buy_and_hold" || template.key === "random_entry") expect(report.headline.outOfSample.fees2x.trades).toBeGreaterThan(0);
    // On this synthetic path every template trades, so a template whose rules can never fire would show here.
    if (template.key !== "stay_in_cash") expect(report.headline.outOfSample.fees2x.trades).toBeGreaterThan(0);
    expect((await run()).resultDigest).toBe(out.resultDigest);
  }, 120_000);
});
