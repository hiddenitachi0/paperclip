import { describe, expect, it } from "vitest";
import { DEFAULT_TRADING_RISK_CONFIG, type TradingRiskConfig } from "@paperclipai/shared";
import { evaluateTradingRiskGate, singleTickPriceJumpPct, tradingFeeNok, type TradingRiskGateInput } from "../services/trading-risk-gate.js";

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
    peakEquityNok: 10_000,
    currentEquityNok: 10_000,
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
    const verdict = evaluateTradingRiskGate(input({ peakEquityNok: peak, currentEquityNok: current }));
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
