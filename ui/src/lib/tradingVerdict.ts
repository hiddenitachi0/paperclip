import type { TradingDashboardSummary, TradingRiskConfig } from "@paperclipai/shared";
import type { TradingOrderSummary } from "../api/trading";

/**
 * Evaluates a strategy's dashboard against the written-in-advance pass/fail
 * criteria in docs/specs/trading-agent-pass-fail-criteria.md (DUR-4227).
 *
 * That document is explicit that computing a verdict is a client-side read
 * of already-shipped endpoints, not a new backend surface -- this is that
 * read. Two approximations, both because the fields the doc would need
 * aren't exposed by `TradingDashboardSummary` or the strategy row:
 *
 * 1. "30 days of wall-clock *running* time" is approximated with calendar
 *    age since the strategy was created (`strategyCreatedAt`), since the
 *    server does not track accumulated running-only time. A strategy that
 *    spent most of its life paused will look more "evaluated" than it is --
 *    flagged in the UI copy, not hidden.
 * 2. Criterion #1's drawdown-comparison branch ("trails buy-and-hold by <=5pp
 *    AND drawdown is less than half of buy-and-hold's") can't be computed:
 *    there is no buy-and-hold drawdown series available anywhere. Only the
 *    flat "beats buy-and-hold, or trails by no more than 5pp of starting
 *    cash" half of #1 is checked.
 * 3. Criterion #2 (max drawdown over the window) needs an equity history the
 *    dashboard doesn't expose either; this reads only the *current*
 *    halted_risk/drawdown_limit state, not "ever breached during the
 *    window."
 */

export type TradingVerdict = "gathering_data" | "passing" | "failing";

export interface TradingVerdictCheck {
  label: string;
  ok: boolean;
}

export interface TradingVerdictResult {
  verdict: TradingVerdict;
  checks: TradingVerdictCheck[];
  windowNote: string;
}

const MIN_WINDOW_DAYS = 30;
const MIN_ROUND_TRIP_TRADES = 20;
const BUY_AND_HOLD_TOLERANCE_FRACTION = 0.05;
const MAX_FEE_FRACTION_OF_GROSS_PROFIT = 0.15;
const CUMULATIVE_LOSS_DAILY_LIMIT_MULTIPLE = 5;

function priceWithinBand(signalPriceNok: number, filledPriceNok: number, bandPct: number): boolean {
  if (signalPriceNok <= 0) return true;
  const deviationPct = (Math.abs(filledPriceNok - signalPriceNok) / signalPriceNok) * 100;
  return deviationPct <= bandPct;
}

export function evaluateTradingVerdict(
  summary: TradingDashboardSummary,
  riskConfig: TradingRiskConfig,
  strategyCreatedAt: string,
  orders: TradingOrderSummary[],
): TradingVerdictResult {
  const ageDays = (Date.now() - new Date(strategyCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const filledSellOrders = orders.filter((o) => o.side === "sell" && o.status === "filled").length;
  const windowMet = ageDays >= MIN_WINDOW_DAYS || filledSellOrders >= MIN_ROUND_TRIP_TRADES;

  const windowNote = windowMet
    ? `Evaluated: ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? "" : "s"} old, ${filledSellOrders} completed round-trip trade${filledSellOrders === 1 ? "" : "s"} (approximate — counts calendar time, not just time spent running).`
    : `Still gathering data — needs 30 days since creation or 20 completed trades (so far: ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? "" : "s"}, ${filledSellOrders} round trip${filledSellOrders === 1 ? "" : "s"}).`;

  if (!windowMet) {
    return { verdict: "gathering_data", checks: [], windowNote };
  }

  const haltedOnCircuitBreaker =
    summary.status === "halted_risk" && (summary.pauseReason === "circuit_breaker" || summary.pauseReason === "reconciliation_mismatch");
  const haltedOnDrawdown = summary.status === "halted_risk" && summary.pauseReason === "drawdown_limit";

  const cumulativeLossOk = summary.totalPnlNok >= -1 * riskConfig.dailyLossLimitNok * CUMULATIVE_LOSS_DAILY_LIMIT_MULTIPLE;

  const filledOrders = orders.filter((o) => o.status === "filled" && o.filledPriceNok !== null);
  const priceBandOk = filledOrders.every((o) => priceWithinBand(o.signalPriceNok, o.filledPriceNok!, riskConfig.priceBandPct));

  const approvalThreshold = riskConfig.approvalAboveNok;
  const approvalGateOk = filledOrders.every((o) => {
    const notionalNok = (o.filledQuantity ?? o.requestedQuantity) * (o.filledPriceNok ?? o.signalPriceNok);
    const needsApproval = approvalThreshold === null || notionalNok >= approvalThreshold;
    return !needsApproval || o.approvalId !== null;
  });

  const grossRealizedProfitNok = summary.realizedPnlNok + summary.feesPaidNok;
  const feesOk = grossRealizedProfitNok <= 0 || summary.feesPaidNok < grossRealizedProfitNok * MAX_FEE_FRACTION_OF_GROSS_PROFIT;

  const benchmarkReturnNok = summary.buyAndHoldValueNok !== null ? summary.buyAndHoldValueNok - summary.startingCashNok : null;
  const beatsOrNearlyMatchesBenchmark =
    benchmarkReturnNok === null ||
    summary.totalPnlNok >= benchmarkReturnNok - BUY_AND_HOLD_TOLERANCE_FRACTION * summary.startingCashNok;

  const checks: TradingVerdictCheck[] = [
    { label: "Beats or nearly matches buy-and-hold", ok: beatsOrNearlyMatchesBenchmark },
    { label: "Never halted on a circuit breaker or ledger mismatch", ok: !haltedOnCircuitBreaker },
    { label: "Never halted on the drawdown limit", ok: !haltedOnDrawdown },
    { label: "Hasn't lost more than 5 days' worth of its daily loss limit", ok: cumulativeLossOk },
    { label: "Every fill landed inside its price band", ok: priceBandOk },
    { label: "Large trades all went through approval before filling", ok: approvalGateOk },
    { label: "Fees aren't eating the edge", ok: feesOk },
  ];

  const verdict: TradingVerdict = checks.every((c) => c.ok) ? "passing" : "failing";
  return { verdict, checks, windowNote };
}
