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
  /** Cash in NOK at the rate used for this order (the strategy's cash is kept in USD). */
  cashNok: number;
  positionQuantity: number;
  /** Cost basis of the currently open position, for exposure/position-size checks after the trade. */
  positionCostNok: number;
  ordersToday: number;
  realizedPnlTodayNok: number;
  /** Highest equity seen. Equity and its peak are in USD (DUR-5001) so the NOK rate cannot look like a drawdown; the gate only uses their ratio, so any one currency works. */
  peakEquity: number;
  /** cash + positionQuantity * bid in the same currency as peakEquity, computed by the caller so this function stays pure. */
  currentEquity: number;
  /** Set when the strategy's entries are halted (daily-loss / drawdown / price-jump trip); blocks buys only. */
  entriesHaltedReason?: string | null;
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

/**
 * Candle-over-candle jump, as a %, between the two most recent closes --
 * distinct from priceBandBreach above, which only compares the current
 * candle's close against the live quote within the same tick. A flash
 * crash/spike (or a bad print) can move both of those together while still
 * being exactly the kind of single-tick jump the design's circuit breaker
 * (TRADING_CIRCUIT_BREAKER_PRICE_JUMP_PCT) is meant to catch. Returns null
 * when there isn't a prior close to compare against.
 */
export function singleTickPriceJumpPct(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const prev = closes[closes.length - 2]!;
  const last = closes[closes.length - 1]!;
  if (prev <= 0) return null;
  return (Math.abs(last - prev) / prev) * 100;
}

/** Which of the "stateless" entries-halt trips (daily loss, drawdown) the numbers show right now, or null. Daily loss is checked first, matching the entry gate's reporting order. */
export function evaluateEntriesHaltTrip(input: {
  riskConfig: TradingRiskConfig;
  realizedPnlTodayNok: number;
  peakEquity: number;
  currentEquity: number;
}): { cause: "daily_loss_limit" | "drawdown_limit"; reason: string } | null {
  const { riskConfig, realizedPnlTodayNok, peakEquity, currentEquity } = input;
  if (realizedPnlTodayNok <= -riskConfig.dailyLossLimitNok) {
    return { cause: "daily_loss_limit", reason: `Today's loss limit (${riskConfig.dailyLossLimitNok} NOK) has been reached.` };
  }
  if (peakEquity > 0) {
    const drawdownPct = ((peakEquity - currentEquity) / peakEquity) * 100;
    if (drawdownPct >= riskConfig.maxDrawdownPct) {
      return { cause: "drawdown_limit", reason: `The drawdown limit (${riskConfig.maxDrawdownPct}%) has been reached.` };
    }
  }
  return null;
}

/**
 * The entry gate: every check that applies to opening or adding to a
 * position (a buy) -- price band, daily order count, daily loss, drawdown,
 * cash, position/exposure caps, approval. Sells never go through here (see
 * evaluateTradingExitGate): blocking an exit on any of these limits only
 * strands the position the limit is trying to protect.
 */
export function evaluateTradingEntryGate(input: TradingRiskGateInput): TradingRiskVerdict {
  const { side, signalPriceNok, quotePriceNok, requestedQuantity, riskConfig, cashNok, positionCostNok, ordersToday, realizedPnlTodayNok, peakEquity, currentEquity, entriesHaltedReason } = input;

  if (side !== "buy") {
    return { kind: "block", reason: "The entry gate only evaluates buys." };
  }

  if (entriesHaltedReason) {
    return { kind: "block", reason: `New buys are halted for this strategy: ${entriesHaltedReason}` };
  }

  if (priceBandBreach(signalPriceNok, quotePriceNok, riskConfig.priceBandPct)) {
    return { kind: "block", reason: `The live price moved more than ${riskConfig.priceBandPct}% from the signal price -- refusing a stale or jumpy quote.` };
  }

  if (ordersToday >= riskConfig.maxOrdersPerDay) {
    return { kind: "block", reason: `Today's order limit (${riskConfig.maxOrdersPerDay}) is already used up.` };
  }

  const trip = evaluateEntriesHaltTrip({ riskConfig, realizedPnlTodayNok, peakEquity, currentEquity });
  if (trip) return { kind: "block", reason: trip.reason };

  const orderValueNok = requestedQuantity * quotePriceNok;
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

  if (riskConfig.approvalAboveNok === null || orderValueNok >= riskConfig.approvalAboveNok) {
    const reasonForOperator =
      riskConfig.approvalAboveNok === null
        ? `Buy about ${Math.round(orderValueNok)} kr of the position; this strategy requires approval on every trade.`
        : `Buy about ${Math.round(orderValueNok)} kr of the position; this is above the ${riskConfig.approvalAboveNok} kr approval threshold.`;
    return { kind: "needs_approval", reasonForOperator };
  }

  return { kind: "allow" };
}

/**
 * The exit gate (DUR-5000): a sell only ever reduces a long spot position, so
 * it refuses only impossible input -- nothing to sell, more than is held, or
 * no valid quote. It deliberately ignores the price band, daily order count,
 * daily loss, drawdown and halted-entries state, and never asks for approval
 * (an unanswered 5-minute card would strand the position).
 */
export function evaluateTradingExitGate(input: Pick<TradingRiskGateInput, "requestedQuantity" | "positionQuantity" | "quotePriceNok">): TradingRiskVerdict {
  const { requestedQuantity, positionQuantity, quotePriceNok } = input;
  if (!(positionQuantity > 0)) {
    return { kind: "block", reason: "There is no open position to sell." };
  }
  if (!Number.isFinite(quotePriceNok) || quotePriceNok <= 0) {
    return { kind: "block", reason: "There is no valid price to sell at." };
  }
  if (!(requestedQuantity > 0)) {
    return { kind: "block", reason: "Nothing to sell." };
  }
  if (requestedQuantity > positionQuantity + 1e-9) {
    return { kind: "block", reason: "Cannot sell more than the strategy currently holds." };
  }
  return { kind: "allow" };
}

/** Routes by side: buys through the entry gate, sells through the exit gate. */
export function evaluateTradingRiskGate(input: TradingRiskGateInput): TradingRiskVerdict {
  return input.side === "sell" ? evaluateTradingExitGate(input) : evaluateTradingEntryGate(input);
}

/** Paper fee: a flat rate on the notional, the same cost a real spot trade would pay (design report section 2: "exchange fees are typically ~0.1-0.5% per side"). */
export function tradingFeeNok(orderValueNok: number, feeRatePct: number): number {
  return orderValueNok * (feeRatePct / 100);
}
