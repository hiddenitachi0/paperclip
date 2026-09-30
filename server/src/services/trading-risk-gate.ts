import type { TradingOrderSide, TradingRiskConfig } from "@paperclipai/shared";

/**
 * The risk gate (design report section 5.3): deterministic, pure, and
 * unit-testable without a database or a network call -- every order the
 * tick loop proposes passes through here before it is ever written as
 * filled. Nothing about this function can place an order; it only says
 * whether one may proceed, and if not, the one reason why (for the ledger
 * and the operator).
 */

export interface TradingRiskGateInput {
  side: TradingOrderSide;
  /** Signal-time price used to size the order, in NOK. */
  signalPriceNok: number;
  /** The best bid/ask the fill would actually happen at, in NOK -- checked against signalPriceNok for the price-band circuit breaker. */
  quotePriceNok: number;
  requestedQuantity: number;
  riskConfig: TradingRiskConfig;
  cashNok: number;
  positionQuantity: number;
  /** Cost basis of the currently open position, for exposure/position-size checks after the trade. */
  positionCostNok: number;
  ordersToday: number;
  realizedPnlTodayNok: number;
  peakEquityNok: number;
  /** cashNok + positionQuantity * quotePriceNok, computed by the caller so this function stays pure. */
  currentEquityNok: number;
}

export type TradingRiskVerdict =
  | { kind: "allow" }
  | { kind: "needs_approval"; reasonForOperator: string }
  | { kind: "block"; reason: string };

/** How far apart the signal and fill price are allowed to be before treating the quote as stale/bad data rather than trading on it. */
function priceBandBreach(signalPriceNok: number, quotePriceNok: number, bandPct: number): boolean {
  if (signalPriceNok <= 0) return true;
  const drift = Math.abs(quotePriceNok - signalPriceNok) / signalPriceNok;
  return drift * 100 > bandPct;
}

export function evaluateTradingRiskGate(input: TradingRiskGateInput): TradingRiskVerdict {
  const { side, signalPriceNok, quotePriceNok, requestedQuantity, riskConfig, cashNok, positionQuantity, positionCostNok, ordersToday, realizedPnlTodayNok, peakEquityNok, currentEquityNok } =
    input;

  if (priceBandBreach(signalPriceNok, quotePriceNok, riskConfig.priceBandPct)) {
    return { kind: "block", reason: `The live price moved more than ${riskConfig.priceBandPct}% from the signal price -- refusing a stale or jumpy quote.` };
  }

  if (ordersToday >= riskConfig.maxOrdersPerDay) {
    return { kind: "block", reason: `Today's order limit (${riskConfig.maxOrdersPerDay}) is already used up.` };
  }

  if (realizedPnlTodayNok <= -riskConfig.dailyLossLimitNok) {
    return { kind: "block", reason: `Today's loss limit (${riskConfig.dailyLossLimitNok} NOK) has been reached.` };
  }

  if (peakEquityNok > 0) {
    const drawdownPct = ((peakEquityNok - currentEquityNok) / peakEquityNok) * 100;
    if (drawdownPct >= riskConfig.maxDrawdownPct) {
      return { kind: "block", reason: `The drawdown limit (${riskConfig.maxDrawdownPct}%) has been reached.` };
    }
  }

  const orderValueNok = requestedQuantity * quotePriceNok;

  if (side === "buy") {
    if (orderValueNok > cashNok) {
      return { kind: "block", reason: "Not enough paper cash for this order." };
    }
    const resultingPositionNok = positionCostNok + orderValueNok;
    if (resultingPositionNok > riskConfig.maxPositionNok) {
      return { kind: "block", reason: `This buy would take the position above its ${riskConfig.maxPositionNok} NOK cap.` };
    }
    if (resultingPositionNok > riskConfig.maxTotalExposureNok) {
      return { kind: "block", reason: `This buy would take total exposure above its ${riskConfig.maxTotalExposureNok} NOK cap.` };
    }
  } else {
    if (requestedQuantity > positionQuantity + 1e-9) {
      return { kind: "block", reason: "Cannot sell more than the strategy currently holds." };
    }
  }

  if (riskConfig.approvalAboveNok !== null && orderValueNok >= riskConfig.approvalAboveNok) {
    return {
      kind: "needs_approval",
      reasonForOperator: `${side === "buy" ? "Buy" : "Sell"} about ${Math.round(orderValueNok)} kr of the position; this is above the ${riskConfig.approvalAboveNok} kr approval threshold.`,
    };
  }

  return { kind: "allow" };
}

/** Paper fee: a flat rate on the notional, the same cost a real spot trade would pay (design report section 2: "exchange fees are typically ~0.1-0.5% per side"). */
export function tradingFeeNok(orderValueNok: number, feeRatePct: number): number {
  return orderValueNok * (feeRatePct / 100);
}
