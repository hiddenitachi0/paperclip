import { z } from "zod";
import { tradingRiskLoosenings, deriveTradingRiskConfig, type TradingStrategySpec } from "./trading-spec.js";

/**
 * DUR-5019: the Trader's daily routine. The limits and the one rule that
 * decides whether a change may skip the approval card are named constants
 * here, so changing one is a visible, reviewed edit. Nothing in this file
 * touches an order, a wallet, a key or a strategy's status.
 */
export const TRADING_TRADER_LIMITS = {
  /** N: rule changes the Trader may file or apply across the WHOLE company in 24 hours (cards and applied changes together). */
  proposalsPerCompanyPerDay: 8,
  /** Changes the Trader may apply itself to ONE strategy in 24 hours. */
  appliesPerStrategyPerDay: 1,
  /** Changes the Trader may apply itself across the company in 24 hours. */
  appliesPerCompanyPerDay: 3,
  /** An experiment older than this is stale: the market has moved on, so it may still be cited on a card but never applied. */
  appliedExperimentMaxAgeHours: 72,
  /** After a safety stop on a strategy, nothing the Trader files or applies may make it bigger for this many days. */
  sizeFreezeDays: 7,
  /** Post-mortems the Trader may write for one strategy in 24 hours. */
  postMortemsPerStrategyPerDay: 2,
  postMortemMaxChars: 2_000,
  postMortemMaxLossTags: 20,
} as const;

/**
 * The checks of an experiment's recommendation that must ALL be present and
 * passed before the Trader may apply its result without a card. A missing
 * check counts as failed, so a result stored in an older shape never applies.
 * `positive_after_fees` is the double-fee check (decision 5).
 */
export const TRADER_APPLY_REQUIRED_CHECKS = ["beats_base", "positive_after_fees", "enough_trades", "deflated_sharpe", "plateau"] as const;

/** Everything that would make a strategy bigger: looser caps (shared with the tighten-only rule) and a bigger order size. */
export function tradingSizeIncreases(previous: TradingStrategySpec, next: TradingStrategySpec): string[] {
  const increases = tradingRiskLoosenings(deriveTradingRiskConfig(previous), deriveTradingRiskConfig(next));
  if (previous.sizing.kind !== next.sizing.kind) {
    increases.push("sizing");
  } else if (previous.sizing.kind === "fraction_of_cash" && next.sizing.kind === "fraction_of_cash") {
    if (next.sizing.fraction > previous.sizing.fraction) increases.push("sizing.fraction");
  } else if (previous.sizing.kind === "risk_per_trade" && next.sizing.kind === "risk_per_trade") {
    if (next.sizing.riskPerTradePct > previous.sizing.riskPerTradePct) increases.push("sizing.riskPerTradePct");
  }
  return increases;
}

/**
 * Apply a finished experiment's recommendation to a PAPER strategy, with no
 * card. There is no `spec` here on purpose: the server takes the rules from
 * the experiment itself, so the Trader cannot apply anything the experiment
 * did not recommend. `.strict()`: a `status`, `mode` or wallet field is
 * refused by name.
 */
export const traderApplyChangeSchema = z
  .object({
    experimentId: z.string().uuid({ message: "Name the experiment whose recommendation you are applying (experimentId)." }),
    summary: z.string().trim().min(3).max(500),
    reasons: z.string().trim().min(3).max(2_000),
  })
  .strict();
export type TraderApplyChangeInput = z.input<typeof traderApplyChangeSchema>;

/** One losing trade the Trader tagged with one of the live rules' "common mistakes" (by its position in that list). */
export const traderLossTagSchema = z
  .object({
    ledgerEntryId: z.string().uuid(),
    mistakeIndex: z.number().int().min(0).max(19),
  })
  .strict();

/** The Trader's short plain-language post-mortem for one strategy. Stored as an append-only ledger note. */
export const traderPostMortemSchema = z
  .object({
    text: z.string().trim().min(10).max(TRADING_TRADER_LIMITS.postMortemMaxChars),
    lossTags: z.array(traderLossTagSchema).max(TRADING_TRADER_LIMITS.postMortemMaxLossTags).default([]),
  })
  .strict();
export type TraderPostMortemInput = z.input<typeof traderPostMortemSchema>;

/** Ledger `detail.reason` values the Trader's own actions write (the daily summary counts them). */
export const TRADER_LEDGER_REASONS = {
  applied: "strategy_version_applied_by_trader",
  postMortem: "trader_post_mortem",
} as const;
