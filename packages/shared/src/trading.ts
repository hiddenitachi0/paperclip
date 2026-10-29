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
  // Crypto wallet events (packages/shared/src/crypto-wallets.ts): same
  // append-only ledger, with wallet_id set instead of strategy_id.
  "wallet_created",
  "wallet_tx_requested",
  "wallet_tx_blocked",
  "wallet_tx_approval_requested",
  "wallet_tx_submitted",
  "wallet_tx_confirmed",
  "wallet_tx_failed",
  "wallet_tx_rejected",
  "wallet_kill_switch",
  "wallet_reconciliation",
  "wallet_settings_changed",
] as const;
export type TradingLedgerEventType = (typeof TRADING_LEDGER_EVENT_TYPES)[number];

// ─── Tradable assets (spot only, no leverage -- design report section 4) ──

/** Reuse the same coin list watchers already offer, so the operator picks from one familiar list. */
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

/**
 * The one symbol map (DUR-4999, decision 6): every asset trades against USD
 * on Kraken. server/src/services/trading-market-data.ts checks it at boot
 * against the exchange's own market list and refuses to create a strategy
 * for an asset whose market is missing (Kraken has no BNB market, for one).
 * Nothing else builds a symbol string.
 */
export const TRADING_MARKET_SYMBOLS: Readonly<Record<TradingAsset, string>> = {
  BTC: "BTC/USD",
  ETH: "ETH/USD",
  SOL: "SOL/USD",
  XRP: "XRP/USD",
  BNB: "BNB/USD",
  ADA: "ADA/USD",
  DOGE: "DOGE/USD",
  TRX: "TRX/USD",
  AVAX: "AVAX/USD",
  DOT: "DOT/USD",
  LINK: "LINK/USD",
  LTC: "LTC/USD",
};

export function ccxtSymbolFor(asset: TradingAsset): string {
  return TRADING_MARKET_SYMBOLS[asset];
}

/** Fixed 11.5 conversion. The trading service no longer uses it (it stamps the daily Norges Bank rate on each fill, DUR-5001); kept for callers that want the old fixed estimate. */
export function usdToNok(amountUsd: number): number {
  return amountUsd * DEFAULT_FX_RATES_TO_NOK.USD;
}

// ─── USD/NOK rate (DUR-5001) ────────────────────────────────────────────────

/**
 * The fixed rate every trading figure used before the daily Norges Bank rate
 * (DUR-5001), and the last-resort fallback when no rate is stored at all.
 * Deliberately NOT DEFAULT_FX_RATES_TO_NOK: the purchase gate shares that
 * table and must not move with the trading rate.
 */
export const TRADING_ESTIMATED_USD_NOK_RATE = 11.5;
/** fx_source of every order/lot made before the daily rate existed. */
export const TRADING_FX_SOURCE_FIXED_ESTIMATE = "fixed_estimate_11.5";
/** fx_source of a fill made while no rate was stored at all (rate 11.5, flagged as a guess). */
export const TRADING_FX_SOURCE_ESTIMATED = "estimated";
/** fx_source of a rate Norges Bank published. */
export const TRADING_FX_SOURCE_NORGES_BANK = "norges_bank";

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
  // DUR-4999 (decision 5): 0.40% per side, a realistic retail taker fee.
  feeRatePct: 0.4,
};

// ─── Candle timeframes and the engine version (DUR-4999) ───────────────────

/**
 * Bump when a change to the engine alters what a strategy would do with the
 * same rule config (closed-candle-only evaluation was engine 2). It goes in
 * every rule label (`sma_crossover@1 · engine 2`) instead of changing the
 * `version: z.literal(1)` stored in rule_config, so old rows keep parsing.
 */
export const TRADING_ENGINE_VERSION = 2;

export const TRADING_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type TradingTimeframe = (typeof TRADING_TIMEFRAMES)[number];
/** Decision 4: new strategies decide on 4-hour candles. Existing rows were created on 15m and keep it (column default). */
export const DEFAULT_TRADING_TIMEFRAME: TradingTimeframe = "4h";

const TIMEFRAME_MS: Record<TradingTimeframe, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function tradingTimeframeMs(timeframe: TradingTimeframe): number {
  return TIMEFRAME_MS[timeframe];
}

/** Exchanges publish a closed bar a little late. */
export const TRADING_CANDLE_GRACE_MINUTES = 10;
/** Evaluating more than this many missed bars in one tick is a gap, not a catch-up: record it and skip. */
export const TRADING_MAX_CATCH_UP_BARS = 50;

export interface TradingCandle {
  /** Bar start. The bar closes at openTime + timeframe. */
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function tradingCandleCloseTime(candle: Pick<TradingCandle, "openTime">, timeframe: TradingTimeframe): Date {
  return new Date(candle.openTime.getTime() + TIMEFRAME_MS[timeframe]);
}

/** Drops every still-forming bar (openTime + timeframe > now). Oldest-first in, oldest-first out. */
export function dropFormingCandles<T extends Pick<TradingCandle, "openTime">>(candles: readonly T[], timeframe: TradingTimeframe, now: Date): T[] {
  return candles.filter((c) => c.openTime.getTime() + TIMEFRAME_MS[timeframe] <= now.getTime());
}

/** How old a closed bar may be (measured from its CLOSE time) before the price is "stale": one timeframe plus the grace. */
export function tradingMaxCandleAgeMs(timeframe: TradingTimeframe): number {
  return TIMEFRAME_MS[timeframe] + TRADING_CANDLE_GRACE_MINUTES * 60_000;
}

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
  return `${config.type}@${config.version} · engine ${TRADING_ENGINE_VERSION}`;
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

/**
 * Does the state a crossover signal announced still hold on the latest bar?
 * A buy needs fast above slow, a sell needs fast below slow. Used by the
 * catch-up: an old bar's entry only acts if it still holds now.
 */
export function smaCrossoverStillHolds(closes: readonly number[], config: SmaCrossoverConfig, signal: "buy" | "sell"): boolean {
  const fast = simpleMovingAverage(closes, config.fastPeriod);
  const slow = simpleMovingAverage(closes, config.slowPeriod);
  if (fast === null || slow === null) return false;
  return signal === "buy" ? fast > slow : fast < slow;
}

export function tradingSignalStillHolds(closes: readonly number[], config: TradingRuleConfig, signal: "buy" | "sell"): boolean {
  switch (config.type) {
    case "sma_crossover":
      return smaCrossoverStillHolds(closes, config, signal);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unknown trading rule type: ${exhaustive}`);
    }
  }
}

/** Closed bars the slowest indicator needs before it can produce a signal (the +1 is the "previous" pair a crossover compares against). */
export function tradingWarmUpBars(config: TradingRuleConfig): number {
  return config.type === "sma_crossover" ? config.slowPeriod + 1 : 50;
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
    /** Candle size the rule decides on. Not editable afterwards (PATCH is unchanged): a different timeframe is a different strategy. */
    timeframe: z.enum(TRADING_TIMEFRAMES).optional().default(DEFAULT_TRADING_TIMEFRAME),
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
  /**
   * DUR-5001: strategies are scored in USD, the market's own currency, so the
   * NOK rate creates no fake gains or losses. The NOK figures above are the
   * display/tax view and move with the rate; verdicts should use these.
   */
  startingCashUsd: number;
  cashUsd: number;
  equityUsd: number;
  totalPnlUsd: number;
  buyAndHoldValueUsd: number | null;
  /** The USD/NOK rate used for the NOK display figures above, the date it was published for (null = no rate stored) and where it came from. */
  fxRate: number;
  fxDate: string | null;
  fxSource: string;
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
