import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_HARD_CEILING,
  createTradingStrategySchema,
  evaluateSmaCrossover,
  evaluateTradingRule,
  simpleMovingAverage,
  tradingRiskConfigSchema,
} from "./trading.js";

describe("TRADING_HARD_CEILING", () => {
  // Pinned on purpose: this snapshot is the "protected config" guard from
  // the design report, adapted to this codebase -- a change here must be a
  // deliberate, reviewed PR, not an incidental edit while building something
  // else. If you are intentionally raising a ceiling, update both this test
  // and the PR description explaining why.
  it("stays at its reviewed values", () => {
    expect(TRADING_HARD_CEILING).toEqual({
      maxPositionNok: 5_000,
      maxTotalExposureNok: 15_000,
      maxOrdersPerDay: 20,
      dailyLossLimitNok: 1_000,
      maxDrawdownPct: 20,
      priceBandPct: 5,
    });
  });
});

describe("tradingRiskConfigSchema", () => {
  it("accepts the documented default", () => {
    expect(tradingRiskConfigSchema.parse(DEFAULT_TRADING_RISK_CONFIG)).toEqual(DEFAULT_TRADING_RISK_CONFIG);
  });

  it("rejects a risk config that exceeds the hard ceiling", () => {
    expect(() =>
      tradingRiskConfigSchema.parse({ ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: TRADING_HARD_CEILING.maxPositionNok + 1 }),
    ).toThrow();
  });

  it("accepts a risk config exactly at the hard ceiling", () => {
    const atCeiling = {
      ...DEFAULT_TRADING_RISK_CONFIG,
      maxPositionNok: TRADING_HARD_CEILING.maxPositionNok,
      maxTotalExposureNok: TRADING_HARD_CEILING.maxTotalExposureNok,
      maxOrdersPerDay: TRADING_HARD_CEILING.maxOrdersPerDay,
      dailyLossLimitNok: TRADING_HARD_CEILING.dailyLossLimitNok,
      maxDrawdownPct: TRADING_HARD_CEILING.maxDrawdownPct,
      priceBandPct: TRADING_HARD_CEILING.priceBandPct,
    };
    expect(tradingRiskConfigSchema.parse(atCeiling)).toBeTruthy();
  });
});

describe("createTradingStrategySchema", () => {
  it("fills in defaults", () => {
    const parsed = createTradingStrategySchema.parse({ name: "BTC SMA crossover", asset: "BTC" });
    expect(parsed.checkEveryMinutes).toBe(15);
    expect(parsed.startingCashNok).toBe(3_000);
    expect(parsed.riskConfig).toEqual(DEFAULT_TRADING_RISK_CONFIG);
  });

  it("rejects an unknown field (strict)", () => {
    expect(() => createTradingStrategySchema.parse({ name: "x", asset: "BTC", leverage: 5 })).toThrow();
  });
});

describe("simpleMovingAverage", () => {
  it("returns null when there is not enough history", () => {
    expect(simpleMovingAverage([1, 2], 3)).toBeNull();
  });

  it("averages the trailing window", () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toBeCloseTo((3 + 4 + 5) / 3);
  });
});

describe("evaluateSmaCrossover", () => {
  const config = { type: "sma_crossover" as const, version: 1 as const, fastPeriod: 2, slowPeriod: 4, orderSizeFraction: 0.1 };

  it("holds with too little history", () => {
    expect(evaluateSmaCrossover([1, 2, 3], config)).toBe("hold");
  });

  it("signals buy when the fast average crosses above the slow average", () => {
    // Falling then sharply rising tail so fast (period 2) overtakes slow (period 4) on the last candle.
    const closes = [10, 9, 8, 7, 6, 20];
    expect(evaluateSmaCrossover(closes, config)).toBe("buy");
  });

  it("signals sell when the fast average crosses below the slow average", () => {
    const closes = [6, 7, 8, 9, 10, 1];
    expect(evaluateSmaCrossover(closes, config)).toBe("sell");
  });

  it("holds when there is no crossover", () => {
    const closes = [10, 10, 10, 10, 10, 10];
    expect(evaluateSmaCrossover(closes, config)).toBe("hold");
  });

  it("is deterministic: same input, same output, every time", () => {
    const closes = [10, 9, 8, 7, 6, 20, 21, 19, 18];
    const first = evaluateSmaCrossover(closes, config);
    for (let i = 0; i < 20; i++) expect(evaluateSmaCrossover(closes, config)).toBe(first);
  });

  it("evaluateTradingRule dispatches to the sma_crossover evaluator", () => {
    const closes = [10, 9, 8, 7, 6, 20];
    expect(evaluateTradingRule(closes, config)).toBe(evaluateSmaCrossover(closes, config));
  });
});
