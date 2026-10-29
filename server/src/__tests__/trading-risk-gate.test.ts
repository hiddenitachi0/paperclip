import { describe, expect, it } from "vitest";
import { DEFAULT_TRADING_RISK_CONFIG, tradingEntriesHaltedReason, tradingPriceJumpThresholdPct, type TradingRiskConfig } from "@paperclipai/shared";
import { evaluateEntriesHaltTrip, evaluateTradingEntryGate, evaluateTradingExitGate, evaluateTradingRiskGate, singleTickPriceJumpPct, tradingFeeNok, type TradingRiskGateInput } from "../services/trading-risk-gate.js";

/**
 * The risk gate is the last line of defense before a paper order is filled --
 * these pin what "block" means for each limit (position size, daily orders,
 * daily loss, drawdown, price-band staleness) and confirm a config change
 * can't silently widen a limit without a test noticing.
 */

/**
 * signalPriceNok defaults to whatever quotePriceNok is given, so tests that
 * aren't about the price band don't have to fight it -- pass signalPriceNok
 * explicitly to test that check on its own.
 */
function input(overrides: Partial<TradingRiskGateInput> = {}): TradingRiskGateInput {
  const quotePriceNok = overrides.quotePriceNok ?? 100;
  return {
    side: "buy",
    signalPriceNok: quotePriceNok,
    quotePriceNok,
    requestedQuantity: 1,
    riskConfig: DEFAULT_TRADING_RISK_CONFIG,
    cashNok: 10_000,
    positionQuantity: 0,
    positionCostNok: 0,
    ordersToday: 0,
    realizedPnlTodayNok: 0,
    peakEquity: 10_000,
    currentEquity: 10_000,
    ...overrides,
  };
}

/** A cap-free config, for tests that isolate a single check other than position/exposure/approval. approvalAboveNok is a large finite number (not null) so these tests don't trip the "null = every order needs approval" rule below. */
const PERMISSIVE_CONFIG: TradingRiskConfig = { ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: 1_000_000, maxTotalExposureNok: 1_000_000, approvalAboveNok: 1_000_000_000 };

describe("evaluateTradingRiskGate", () => {
  it("allows a plain buy well within every limit", () => {
    expect(evaluateTradingRiskGate(input())).toEqual({ kind: "allow" });
  });

  it("blocks when the quote has drifted past the price band from the signal price", () => {
    const verdict = evaluateTradingRiskGate(input({ riskConfig: PERMISSIVE_CONFIG, signalPriceNok: 1_000, quotePriceNok: 1_050 }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("moved") });
  });

  it("does not block a quote drift right at the edge of the price band", () => {
    // priceBandPct is 2 by default: 1000 -> 1019.9 is 1.99% drift, inside the band.
    const verdict = evaluateTradingRiskGate(input({ riskConfig: PERMISSIVE_CONFIG, signalPriceNok: 1_000, quotePriceNok: 1_019.9 }));
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("blocks once today's order count reaches the daily cap", () => {
    const verdict = evaluateTradingRiskGate(input({ ordersToday: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("order limit") });
  });

  it("blocks once today's realized loss reaches the daily loss limit", () => {
    const verdict = evaluateTradingRiskGate(input({ realizedPnlTodayNok: -DEFAULT_TRADING_RISK_CONFIG.dailyLossLimitNok }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("loss limit") });
  });

  it("does not trip the daily loss limit on an unrealized-only drop", () => {
    const verdict = evaluateTradingRiskGate(input({ realizedPnlTodayNok: 0 }));
    expect(verdict.kind).not.toBe("block");
  });

  it("blocks once drawdown from the equity peak reaches the configured percentage", () => {
    const peak = 10_000;
    const current = peak * (1 - DEFAULT_TRADING_RISK_CONFIG.maxDrawdownPct / 100);
    const verdict = evaluateTradingRiskGate(input({ peakEquity: peak, currentEquity: current }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("drawdown limit") });
  });

  it("blocks a buy that would exceed the max position cap even with enough cash", () => {
    const config: TradingRiskConfig = { ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: 500 };
    const verdict = evaluateTradingRiskGate(input({ riskConfig: config, requestedQuantity: 1, quotePriceNok: 1_000, cashNok: 10_000 }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("position") });
  });

  it("blocks a buy that would exceed total exposure even under the per-position cap", () => {
    const config: TradingRiskConfig = { ...DEFAULT_TRADING_RISK_CONFIG, maxPositionNok: 5_000, maxTotalExposureNok: 500 };
    const verdict = evaluateTradingRiskGate(input({ riskConfig: config, requestedQuantity: 1, quotePriceNok: 1_000, cashNok: 10_000 }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("exposure") });
  });

  it("blocks a buy with insufficient paper cash", () => {
    const verdict = evaluateTradingRiskGate(input({ requestedQuantity: 100, quotePriceNok: 1_000, cashNok: 500 }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("cash") });
  });

  it("blocks a sell for more than the strategy currently holds", () => {
    const verdict = evaluateTradingRiskGate(input({ side: "sell", requestedQuantity: 5, positionQuantity: 1 }));
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("Cannot sell") });
  });

  it("allows a sell of exactly the held quantity", () => {
    const verdict = evaluateTradingRiskGate(input({ side: "sell", requestedQuantity: 1, positionQuantity: 1 }));
    expect(verdict.kind).toBe("allow");
  });

  it("requires approval once the order value reaches the approval threshold", () => {
    const config: TradingRiskConfig = { ...PERMISSIVE_CONFIG, approvalAboveNok: 500 };
    const verdict = evaluateTradingRiskGate(input({ riskConfig: config, requestedQuantity: 1, quotePriceNok: 600, cashNok: 100_000 }));
    expect(verdict).toEqual({ kind: "needs_approval", reasonForOperator: expect.any(String) });
  });

  it("always requires approval when approvalAboveNok is null (the design report's 'every trade at first')", () => {
    const config: TradingRiskConfig = { ...PERMISSIVE_CONFIG, approvalAboveNok: null };
    const verdict = evaluateTradingRiskGate(input({ riskConfig: config, requestedQuantity: 1, quotePriceNok: 1 }));
    expect(verdict).toEqual({ kind: "needs_approval", reasonForOperator: expect.any(String) });
  });

  it("checks limits in a fixed order so the first real problem is always the reported reason", () => {
    // Both the daily order cap and the daily loss limit are breached; the order check must win since it's checked first.
    const verdict = evaluateTradingRiskGate(
      input({ ordersToday: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay, realizedPnlTodayNok: -DEFAULT_TRADING_RISK_CONFIG.dailyLossLimitNok }),
    );
    expect(verdict).toEqual({ kind: "block", reason: expect.stringContaining("order limit") });
  });
});

describe("exit gate (DUR-5000): a sell never hits the entry-side blocks", () => {
  const holding = { side: "sell" as const, requestedQuantity: 1, positionQuantity: 1, positionCostNok: 100 };

  it("sells at the daily-loss limit", () => {
    const verdict = evaluateTradingRiskGate(input({ ...holding, realizedPnlTodayNok: -DEFAULT_TRADING_RISK_CONFIG.dailyLossLimitNok * 5 }));
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("sells at the drawdown limit", () => {
    const verdict = evaluateTradingRiskGate(input({ ...holding, peakEquity: 10_000, currentEquity: 5_000 }));
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("sells after the daily order count is used up", () => {
    const verdict = evaluateTradingRiskGate(input({ ...holding, ordersToday: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay + 50 }));
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("sells with a wide price band (the quote far from the signal price)", () => {
    const verdict = evaluateTradingRiskGate(input({ ...holding, signalPriceNok: 100, quotePriceNok: 40 }));
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("never asks for approval, even when every trade would need one", () => {
    const config: TradingRiskConfig = { ...PERMISSIVE_CONFIG, approvalAboveNok: null };
    expect(evaluateTradingRiskGate(input({ ...holding, riskConfig: config }))).toEqual({ kind: "allow" });
    expect(evaluateTradingExitGate({ ...holding, quotePriceNok: 100 })).toEqual({ kind: "allow" });
  });

  it("refuses only impossible input: no position, no valid quote, more than held", () => {
    expect(evaluateTradingExitGate({ requestedQuantity: 1, positionQuantity: 0, quotePriceNok: 100 })).toEqual({ kind: "block", reason: expect.stringContaining("no open position") });
    expect(evaluateTradingExitGate({ requestedQuantity: 1, positionQuantity: 1, quotePriceNok: 0 })).toEqual({ kind: "block", reason: expect.stringContaining("no valid price") });
    expect(evaluateTradingExitGate({ requestedQuantity: 1, positionQuantity: 1, quotePriceNok: Number.NaN })).toEqual({ kind: "block", reason: expect.stringContaining("no valid price") });
    expect(evaluateTradingExitGate({ requestedQuantity: 2, positionQuantity: 1, quotePriceNok: 100 })).toEqual({ kind: "block", reason: expect.stringContaining("Cannot sell") });
  });

  it("still blocks the same state for a buy (the entry gate keeps every check)", () => {
    expect(evaluateTradingEntryGate(input({ realizedPnlTodayNok: -DEFAULT_TRADING_RISK_CONFIG.dailyLossLimitNok })).kind).toBe("block");
    expect(evaluateTradingEntryGate(input({ ordersToday: DEFAULT_TRADING_RISK_CONFIG.maxOrdersPerDay })).kind).toBe("block");
    expect(evaluateTradingEntryGate(input({ side: "sell" })).kind).toBe("block");
  });

  it("blocks buys, never sells, while entries are halted", () => {
    expect(evaluateTradingEntryGate(input({ entriesHaltedReason: "price jump" }))).toEqual({ kind: "block", reason: expect.stringContaining("halted") });
    expect(evaluateTradingRiskGate(input({ ...holding, entriesHaltedReason: "price jump" }))).toEqual({ kind: "allow" });
  });
});

describe("evaluateEntriesHaltTrip", () => {
  const base = { riskConfig: DEFAULT_TRADING_RISK_CONFIG, realizedPnlTodayNok: 0, peakEquity: 10_000, currentEquity: 10_000 };
  it("reports nothing when inside both limits", () => {
    expect(evaluateEntriesHaltTrip(base)).toBeNull();
  });
  it("reports the daily-loss and drawdown trips", () => {
    expect(evaluateEntriesHaltTrip({ ...base, realizedPnlTodayNok: -DEFAULT_TRADING_RISK_CONFIG.dailyLossLimitNok })?.cause).toBe("daily_loss_limit");
    expect(evaluateEntriesHaltTrip({ ...base, currentEquity: 10_000 * (1 - DEFAULT_TRADING_RISK_CONFIG.maxDrawdownPct / 100) })?.cause).toBe("drawdown_limit");
  });
});

describe("jump threshold by timeframe and entries-halt state", () => {
  it("scales with the candle size", () => {
    expect(["15m", "1h", "4h", "1d"].map((tf) => tradingPriceJumpThresholdPct(tf as "15m"))).toEqual([15, 20, 30, 45]);
  });
  it("only a running strategy with a halt reason is entries-halted", () => {
    expect(tradingEntriesHaltedReason("running", "circuit_breaker")).toBe("circuit_breaker");
    expect(tradingEntriesHaltedReason("running", "drawdown_limit")).toBe("drawdown_limit");
    expect(tradingEntriesHaltedReason("running", null)).toBeNull();
    expect(tradingEntriesHaltedReason("paused", "circuit_breaker")).toBeNull();
    expect(tradingEntriesHaltedReason("halted_risk", "circuit_breaker")).toBeNull();
    expect(tradingEntriesHaltedReason("running", "restart")).toBeNull();
  });
});

describe("tradingFeeNok", () => {
  it("computes a flat percentage fee on the notional", () => {
    expect(tradingFeeNok(1_000, 0.25)).toBeCloseTo(2.5);
  });

  it("is zero for a zero fee rate", () => {
    expect(tradingFeeNok(1_000, 0)).toBe(0);
  });
});

describe("singleTickPriceJumpPct", () => {
  it("returns null with fewer than two closes", () => {
    expect(singleTickPriceJumpPct([])).toBeNull();
    expect(singleTickPriceJumpPct([100])).toBeNull();
  });

  it("computes the % move between the two most recent closes only", () => {
    // Only the last pair (100 -> 150) matters, not the full candle history.
    expect(singleTickPriceJumpPct([20, 20, 100, 150])).toBeCloseTo(50);
  });

  it("is symmetric for a drop", () => {
    expect(singleTickPriceJumpPct([200, 100])).toBeCloseTo(50);
  });

  it("returns null rather than dividing by a non-positive prior close", () => {
    expect(singleTickPriceJumpPct([0, 10])).toBeNull();
  });
});
