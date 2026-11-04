import type { TradingDashboardSummary, TradingRiskConfig } from "@paperclipai/shared";
import type { TradingOrderSummary } from "../api/trading";

/**
 * Safety checks for a strategy's paper run (DUR-5011).
 *
 * The pass/fail criteria themselves (sample size, running time, Brier skill,
 * trade results against the past-data test, drawdown) are computed by the
 * metrics service from `TRADING_PASS_FAIL_CRITERIA` in @paperclipai/shared and
 * arrive on the scoreboard; this page shows them as they come and never
 * recomputes a verdict of its own. The old "30 days or 20 trades" window is
 * gone.
 *
 * What stays here are the checks that are not about performance but about
 * whether the machinery behaved: no halt on a circuit breaker or ledger
 * mismatch, every fill inside its price band, and every large order approved
 * before it filled. They are shown beside the criteria and never turned into
 * a verdict word.
 */

export interface TradingSafetyCheck {
  label: string;
  ok: boolean;
}

function priceWithinBand(signalPriceNok: number, filledPriceNok: number, bandPct: number): boolean {
  if (signalPriceNok <= 0) return true;
  const deviationPct = (Math.abs(filledPriceNok - signalPriceNok) / signalPriceNok) * 100;
  return deviationPct <= bandPct;
}

export function evaluateTradingSafetyChecks(
  summary: TradingDashboardSummary,
  riskConfig: TradingRiskConfig,
  orders: TradingOrderSummary[],
): TradingSafetyCheck[] {
  const haltedOnCircuitBreaker =
    summary.status === "halted_risk" && (summary.pauseReason === "circuit_breaker" || summary.pauseReason === "reconciliation_mismatch");

  const filledOrders = orders.filter((o) => o.status === "filled" && o.filledPriceNok !== null);
  const priceBandOk = filledOrders.every((o) => priceWithinBand(o.signalPriceNok, o.filledPriceNok!, riskConfig.priceBandPct));

  const approvalThreshold = riskConfig.approvalAboveNok;
  const approvalGateOk = filledOrders.every((o) => {
    const notionalNok = (o.filledQuantity ?? o.requestedQuantity) * (o.filledPriceNok ?? o.signalPriceNok);
    const needsApproval = approvalThreshold === null || notionalNok >= approvalThreshold;
    return !needsApproval || o.approvalId !== null;
  });

  return [
    { label: "Never halted on a circuit breaker or ledger mismatch", ok: !haltedOnCircuitBreaker },
    { label: "Every fill landed inside its price band", ok: priceBandOk },
    { label: "Large trades all went through approval before filling", ok: approvalGateOk },
  ];
}
