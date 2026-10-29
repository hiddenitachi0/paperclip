import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_HARD_CEILING,
  DEFAULT_TRADING_RULE_CONFIG,
  TRADING_ENGINE_VERSION,
  TRADING_MARKET_SYMBOLS,
  TRADING_ASSETS,
  ccxtSymbolFor,
  TRADING_MODES,
  createTradingStrategySchema,
  dropFormingCandles,
  evaluateSmaCrossover,
  tradingMaxCandleAgeMs,
  tradingRuleVersionLabel,
  tradingSignalStillHolds,
  tradingWarmUpBars,
  updateTradingStrategySchema,
  evaluateTradingRule,
  simpleMovingAverage,
  tradingRiskConfigSchema,
} from "./trading.js";

describe("TRADING_MODES", () => {
  it("stays paper-only: no strategy can run in a real-money mode", () => {
    expect([...TRADING_MODES]).toEqual(["paper"]);
  });
});

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

describe("DUR-4999 engine basics", () => {
  it("puts the engine version in the rule label without touching the stored rule version", () => {
    expect(DEFAULT_TRADING_RULE_CONFIG.version).toBe(1);
    expect(tradingRuleVersionLabel(DEFAULT_TRADING_RULE_CONFIG)).toBe(`sma_crossover@1 · engine ${TRADING_ENGINE_VERSION}`);
    expect(tradingRuleVersionLabel(DEFAULT_TRADING_RULE_CONFIG)).toBe("sma_crossover@1 · engine 2");
  });

  it("new strategies default to 4h candles and a 0.40% fee; PATCH does not take a timeframe", () => {
    const parsed = createTradingStrategySchema.parse({ name: "x", asset: "BTC" });
    expect(parsed.timeframe).toBe("4h");
    expect(parsed.riskConfig.feeRatePct).toBe(0.4);
    expect(() => createTradingStrategySchema.parse({ name: "x", asset: "BTC", timeframe: "5m" })).toThrow();
    expect(() => updateTradingStrategySchema.parse({ timeframe: "1h" })).toThrow();
  });

  it("has one USD symbol per asset", () => {
    for (const asset of TRADING_ASSETS) expect(ccxtSymbolFor(asset)).toBe(TRADING_MARKET_SYMBOLS[asset]);
    expect(ccxtSymbolFor("BTC")).toBe("BTC/USD");
  });

  it("drops bars that have not closed yet", () => {
    const now = new Date("2026-01-01T04:00:00Z");
    const bars = [{ openTime: new Date("2026-01-01T00:00:00Z") }, { openTime: new Date("2026-01-01T04:00:00Z") }];
    expect(dropFormingCandles(bars, "4h", now)).toEqual([bars[0]]);
  });

  it("allows one timeframe plus 10 minutes of price age", () => {
    expect(tradingMaxCandleAgeMs("15m")).toBe(25 * 60_000);
    expect(tradingMaxCandleAgeMs("4h")).toBe(4 * 3_600_000 + 10 * 60_000);
  });

  it("covers the slowest indicator's warm-up", () => {
    expect(tradingWarmUpBars({ ...DEFAULT_TRADING_RULE_CONFIG, slowPeriod: 400 })).toBe(401);
  });

  it("a buy still holds only while fast is above slow", () => {
    const config = { ...DEFAULT_TRADING_RULE_CONFIG, fastPeriod: 2, slowPeriod: 4 };
    expect(tradingSignalStillHolds([1, 1, 1, 2, 3], config, "buy")).toBe(true);
    expect(tradingSignalStillHolds([1, 1, 1, 2, 3], config, "sell")).toBe(false);
    expect(tradingSignalStillHolds([3, 3, 3, 2, 1], config, "sell")).toBe(true);
  });
});
