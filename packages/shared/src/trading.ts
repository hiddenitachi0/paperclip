import { z } from "zod";
import { DEFAULT_FX_RATES_TO_NOK } from "./payment-card-threshold.js";

/**
 * DUR-4153/DUR-4171 (trading agent, paper-trading only): types, protected
 * risk ceilings, the deterministic rule engine and validators shared
 * between server routes and (eventually) the UI/dashboard.
 *
 * Design source: research report "6-trading-agent.md" (posted on DUR-4141).
 * Core rule from that report, enforced throughout this feature: fixed rules
 * in code trade, the AI only ever explains or proposes. No LLM call sits on
 * the order path, and nothing in this module or its callers ever needs an
 * exchange credential to run in paper mode.
 *
 * Ground rule (task description): paper-trading mode ONLY in this
 * implementation. `tradingStrategies.mode` therefore only ever accepts
 * "paper" for now -- see TRADING_MODES below. Wiring a real "live" mode is
 * explicitly out of scope and gated behind a later, separate decision from
 * Filip (and his accountant) per the design report's phase 0/4.
 */

// ─── Modes, statuses ───────────────────────────────────────────────────────

/** "live" is deliberately not offered yet -- see the module doc comment. */
export const TRADING_MODES = ["paper"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

/**
 * running: the tick loop places paper orders for this strategy.
 * paused: no new orders; safe default, and what every strategy starts in
 *   (manual creation) and returns to after a server restart -- "starts
 *   paused after restart" is a hard design requirement, not a preference.
 * halted_risk: the risk gate or a circuit breaker stopped it; stays halted
 *   until an operator explicitly resumes (never auto-resumes).
 */
export const TRADING_STRATEGY_STATUSES = ["paused", "running", "halted_risk"] as const;
export type TradingStrategyStatus = (typeof TRADING_STRATEGY_STATUSES)[number];

export const TRADING_PAUSE_REASONS = [
  "manual",
  "restart",
  "daily_loss_limit",
  "drawdown_limit",
  "circuit_breaker",
  "reconciliation_mismatch",
] as const;
export type TradingPauseReason = (typeof TRADING_PAUSE_REASONS)[number];

export const TRADING_ORDER_SIDES = ["buy", "sell"] as const;
export type TradingOrderSide = (typeof TRADING_ORDER_SIDES)[number];

export const TRADING_ORDER_STATUSES = ["filled", "rejected", "pending_approval", "expired_approval"] as const;
export type TradingOrderStatus = (typeof TRADING_ORDER_STATUSES)[number];

export const TRADING_LEDGER_EVENT_TYPES = [
  "signal",
  "order_filled",
  "order_rejected",
  "risk_block",
  "circuit_breaker",
  "kill_switch",
  "reconciliation",
] as const;
export type TradingLedgerEventType = (typeof TRADING_LEDGER_EVENT_TYPES)[number];

// ─── Tradable assets (spot only, no leverage -- design report section 4) ──

/** Reuse the same coin list watchers already offer, so the operator picks from one familiar list. CCXT symbol is "<BASE>/USDT". */
export const TRADING_ASSETS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "ADA",
  "DOGE",
  "TRX",
  "AVAX",
  "DOT",
  "LINK",
  "LTC",
] as const;
export type TradingAsset = (typeof TRADING_ASSETS)[number];

export function ccxtSymbolFor(asset: TradingAsset): string {
  return `${asset}/USDT`;
}

/** USDT tracks USD closely enough for this purpose; reuse the existing purchase-gate FX table rather than a second one. */
export function usdToNok(amountUsd: number): number {
  return amountUsd * DEFAULT_FX_RATES_TO_NOK.USD;
}

// ─── Protected risk ceilings ────────────────────────────────────────────────

/**
 * Hard ceilings no strategy's own risk config may exceed, regardless of what
 * an operator (or an agent building the create-strategy form) sets -- the
 * "protected file... CI rejects any agent commit that touches it" control
 * from the design report, adapted to this codebase: a plain exported
 * constant, pinned by a snapshot test
 * (packages/shared/src/__tests__/trading.test.ts) so an accidental or casual
 * change shows up as a failing test diff rather than a silent widening.
 * Raising these needs a deliberate PR Filip/Fork Lead can see in review, not
 * a per-strategy settings tweak.
 */
export const TRADING_HARD_CEILING = {
  maxPositionNok: 5_000,
  maxTotalExposureNok: 15_000,
  maxOrdersPerDay: 20,
  dailyLossLimitNok: 1_000,
  maxDrawdownPct: 20,
  priceBandPct: 5,
} as const;

export const tradingRiskConfigSchema = z
  .object({
    maxPositionNok: z.number().int().positive().max(TRADING_HARD_CEILING.maxPositionNok),
    maxTotalExposureNok: z.number().int().positive().max(TRADING_HARD_CEILING.maxTotalExposureNok),
    maxOrdersPerDay: z.number().int().positive().max(TRADING_HARD_CEILING.maxOrdersPerDay),
    dailyLossLimitNok: z.number().int().positive().max(TRADING_HARD_CEILING.dailyLossLimitNok),
    maxDrawdownPct: z.number().positive().max(TRADING_HARD_CEILING.maxDrawdownPct),
    /** A limit order may only fill within this % of the signal price -- guards against a stale/bad quote. */
    priceBandPct: z.number().positive().max(TRADING_HARD_CEILING.priceBandPct),
    /** A filled order at or above this NOK size needs a trade-approval card before it counts as filled. null = every order needs one (the design report's "every trade at first"). */
    approvalAboveNok: z.number().int().positive().nullable(),
    feeRatePct: z.number().min(0).max(2),
  })
  .strict();
export type TradingRiskConfig = z.infer<typeof tradingRiskConfigSchema>;

/** Conservative defaults, well inside the hard ceiling, for a new strategy's first paper run. */
export const DEFAULT_TRADING_RISK_CONFIG: TradingRiskConfig = {
  maxPositionNok: 1_000,
  maxTotalExposureNok: 3_000,
  maxOrdersPerDay: 5,
  dailyLossLimitNok: 200,
  maxDrawdownPct: 10,
  priceBandPct: 2,
  approvalAboveNok: 500,
  feeRatePct: 0.25,
};

// ─── Deterministic rule engine (Phase 1: one simple rule) ──────────────────

/**
 * SMA crossover: fast SMA crosses above slow SMA -> buy signal; crosses
 * below -> sell signal; otherwise hold. Deterministic (same candles, same
 * signal, always) and versioned -- `ruleVersion` is stamped onto every
 * signal/order/ledger row so a later rule change never silently reinterprets
 * history.
 */
export const TRADING_RULE_TYPES = ["sma_crossover"] as const;
export type TradingRuleType = (typeof TRADING_RULE_TYPES)[number];

export const smaCrossoverConfigSchema = z
  .object({
    type: z.literal("sma_crossover"),
    version: z.literal(1),
    fastPeriod: z.number().int().min(2).max(200),
    slowPeriod: z.number().int().min(3).max(400),
    /** Fraction of available paper cash risked per buy signal. */
    orderSizeFraction: z.number().positive().max(1),
  })
  .strict()
  .refine((v) => v.fastPeriod < v.slowPeriod, { message: "fastPeriod must be less than slowPeriod", path: ["fastPeriod"] });
export type SmaCrossoverConfig = z.infer<typeof smaCrossoverConfigSchema>;

export const tradingRuleConfigSchema = smaCrossoverConfigSchema;
export type TradingRuleConfig = z.infer<typeof tradingRuleConfigSchema>;

export const DEFAULT_TRADING_RULE_CONFIG: SmaCrossoverConfig = {
  type: "sma_crossover",
  version: 1,
  fastPeriod: 10,
  slowPeriod: 30,
  orderSizeFraction: 0.1,
};

export function tradingRuleVersionLabel(config: TradingRuleConfig): string {
  return `${config.type}@${config.version}`;
}

export type TradingSignal = "buy" | "sell" | "hold";

/** Pure so it is unit-testable without a database or a network call. `closes` oldest-first. */
export function simpleMovingAverage(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i]!;
  return sum / period;
}

/**
 * closes must be oldest-first and include at least slowPeriod + 1 candles
 * for a crossover to be detectable (the +1 gives a "previous" SMA pair to
 * compare against the "current" pair).
 */
export function evaluateSmaCrossover(closes: readonly number[], config: SmaCrossoverConfig): TradingSignal {
  if (closes.length < config.slowPeriod + 1) return "hold";
  const prevFast = simpleMovingAverage(closes.slice(0, -1), config.fastPeriod);
  const prevSlow = simpleMovingAverage(closes.slice(0, -1), config.slowPeriod);
  const curFast = simpleMovingAverage(closes, config.fastPeriod);
  const curSlow = simpleMovingAverage(closes, config.slowPeriod);
  if (prevFast === null || prevSlow === null || curFast === null || curSlow === null) return "hold";
  if (prevFast <= prevSlow && curFast > curSlow) return "buy";
  if (prevFast >= prevSlow && curFast < curSlow) return "sell";
  return "hold";
}

export function evaluateTradingRule(closes: readonly number[], config: TradingRuleConfig): TradingSignal {
  switch (config.type) {
    case "sma_crossover":
      return evaluateSmaCrossover(closes, config);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unknown trading rule type: ${exhaustive}`);
    }
  }
}

// ─── Validators ─────────────────────────────────────────────────────────────

export const TRADING_STRATEGY_NAME_MAX = 120;
/** How often the tick loop may check a strategy, at minimum -- crypto markets move fast but this is still a batch tick, not a streaming feed. */
export const TRADING_MIN_CHECK_MINUTES = 5;
export const TRADING_MAX_CHECK_MINUTES = 240;
/** How many due strategies one scheduler tick advances at most. */
export const TRADING_TICK_BATCH = 25;
/** A stale price (candle older than this) blocks new orders -- circuit breaker, design report section 5.4. */
export const TRADING_MAX_PRICE_AGE_MINUTES = 60;
/** A single-tick price jump beyond this % halts the strategy for review rather than trading through it. */
export const TRADING_CIRCUIT_BREAKER_PRICE_JUMP_PCT = 15;
/** Consecutive exchange/fetch errors before a strategy is halted rather than just backed off (mirrors watchers' backoff, but trading halts instead of silently retrying forever). */
export const TRADING_CIRCUIT_BREAKER_MAX_CONSECUTIVE_ERRORS = 5;
export const TRADING_TRADE_APPROVAL_EXPIRY_MS = 5 * 60 * 1000;

const strategyFields = {
  name: z.string().trim().min(1, "Give the strategy a name.").max(TRADING_STRATEGY_NAME_MAX),
  asset: z.enum(TRADING_ASSETS),
  checkEveryMinutes: z.number().int().min(TRADING_MIN_CHECK_MINUTES).max(TRADING_MAX_CHECK_MINUTES),
  startingCashNok: z.number().int().positive().max(TRADING_HARD_CEILING.maxTotalExposureNok),
  ruleConfig: tradingRuleConfigSchema,
  riskConfig: tradingRiskConfigSchema,
};

export const createTradingStrategySchema = z
  .object({
    name: strategyFields.name,
    asset: strategyFields.asset,
    checkEveryMinutes: strategyFields.checkEveryMinutes.optional().default(15),
    startingCashNok: strategyFields.startingCashNok.optional().default(3_000),
    ruleConfig: strategyFields.ruleConfig.optional().default(DEFAULT_TRADING_RULE_CONFIG),
    riskConfig: strategyFields.riskConfig.optional().default(DEFAULT_TRADING_RISK_CONFIG),
  })
  .strict();
export type CreateTradingStrategyInput = z.infer<typeof createTradingStrategySchema>;

export const updateTradingStrategySchema = z
  .object({
    name: strategyFields.name.optional(),
    checkEveryMinutes: strategyFields.checkEveryMinutes.optional(),
    ruleConfig: strategyFields.ruleConfig.optional(),
    riskConfig: strategyFields.riskConfig.optional(),
  })
  .strict();
export type UpdateTradingStrategyInput = z.infer<typeof updateTradingStrategySchema>;

export const setTradingStrategyStatusSchema = z
  .object({
    /** Only "running" or "paused" -- an operator can never directly set "halted_risk" (that's the system's own verdict) or clear it without addressing the cause; resuming from halted_risk goes through the same "running" transition once the operator has reviewed why. */
    status: z.enum(["running", "paused"]),
  })
  .strict();
export type SetTradingStrategyStatusInput = z.infer<typeof setTradingStrategyStatusSchema>;

export interface TradingDashboardSummary {
  strategyId: string;
  status: TradingStrategyStatus;
  pauseReason: TradingPauseReason | null;
  asset: TradingAsset;
  startingCashNok: number;
  cashNok: number;
  positionQuantity: number;
  positionValueNok: number;
  realizedPnlNok: number;
  unrealizedPnlNok: number;
  totalPnlNok: number;
  /** What simply holding the starting cash in the asset from strategy creation would be worth now -- the design report's "did it beat buy-and-hold" benchmark. */
  buyAndHoldValueNok: number | null;
  feesPaidNok: number;
  ordersToday: number;
  realizedPnlToday: number;
  lastTickAt: string | null;
  lastTickError: string | null;
}

export function describeTradingPauseReason(reason: TradingPauseReason | null): string {
  switch (reason) {
    case null:
      return "";
    case "manual":
      return "paused by an operator";
    case "restart":
      return "paused after a server restart, waiting to be resumed";
    case "daily_loss_limit":
      return "halted: today's loss limit was reached";
    case "drawdown_limit":
      return "halted: the drawdown limit was reached";
    case "circuit_breaker":
      return "halted: a circuit breaker fired (stale or jumpy price data, or repeated exchange errors)";
    case "reconciliation_mismatch":
      return "halted: the paper ledger and position no longer add up, needs a human look";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
