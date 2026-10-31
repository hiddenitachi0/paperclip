import {
  CRYPTO_CHAIN_INFO,
  TRADING_WALLET_HARD_CEILING,
  formatChainAmount,
  parseCryptoAmount,
  type CryptoChain,
  type TradingWalletLimitInput,
} from "@paperclipai/shared";

/**
 * The hard limits of a code-held trading wallet -- pure, deterministic and
 * unit-testable without a database or a network call, like
 * crypto-wallet-policy.ts. Nothing here moves money; it only says whether a
 * trade may go ahead, whether a wallet must be paused, and how much surplus
 * a sweep may send.
 *
 * Every amount is integer base units (sats, wei, lamports, USDC micro-units).
 */

/** Limits and flows in base units, as stored on the wallet row. null = off. */
export interface TradingWalletAmounts {
  perTrade: bigint;
  daily: bigint;
  total: bigint;
  maxBalance: bigint;
  dailyLossStop: bigint;
  sweepThreshold: bigint | null;
  topUpFloor: bigint | null;
  topUpTarget: bigint | null;
}

function parseOrThrow(chain: CryptoChain, value: string, what: string): bigint {
  const parsed = parseCryptoAmount(value, CRYPTO_CHAIN_INFO[chain].decimals);
  if (parsed === null) {
    throw new TradingLimitsError(`${what} is not a valid ${CRYPTO_CHAIN_INFO[chain].asset} amount (at most ${CRYPTO_CHAIN_INFO[chain].decimals} decimals).`);
  }
  return parsed;
}

export class TradingLimitsError extends Error {}

/**
 * Turns the decimal strings of the API into base units and checks that they
 * make sense together and stay under the hard ceilings in code. Throws a
 * TradingLimitsError with a plain sentence when they do not.
 */
export function parseTradingLimits(chain: CryptoChain, input: TradingWalletLimitInput): TradingWalletAmounts {
  const optional = (value: string | null, what: string) => (value === null ? null : parseOrThrow(chain, value, what));
  const amounts: TradingWalletAmounts = {
    perTrade: parseOrThrow(chain, input.perTrade, "The maximum per trade"),
    daily: parseOrThrow(chain, input.daily, "The maximum per day"),
    total: parseOrThrow(chain, input.total, "The maximum in total"),
    maxBalance: parseOrThrow(chain, input.maxBalance, "The maximum balance"),
    dailyLossStop: parseOrThrow(chain, input.dailyLossStop, "The daily loss stop"),
    sweepThreshold: optional(input.sweepThreshold, "The sweep amount"),
    topUpFloor: optional(input.topUpFloor, "The top-up floor"),
    topUpTarget: optional(input.topUpTarget, "The top-up target"),
  };
  const fmt = (v: bigint) => formatChainAmount(chain, v);
  const ceiling = TRADING_WALLET_HARD_CEILING[chain];
  const decimals = CRYPTO_CHAIN_INFO[chain].decimals;
  const ceil = (v: string) => parseCryptoAmount(v, decimals)!;

  if (amounts.maxBalance <= 0n) throw new TradingLimitsError("The maximum balance must be more than zero.");
  if (amounts.dailyLossStop <= 0n) throw new TradingLimitsError("The daily loss stop must be more than zero.");
  if (amounts.perTrade <= 0n) throw new TradingLimitsError("The maximum per trade must be more than zero.");
  if (amounts.maxBalance > ceil(ceiling.maxBalance)) {
    throw new TradingLimitsError(`The maximum balance cannot be more than ${fmt(ceil(ceiling.maxBalance))} for a test wallet.`);
  }
  if (amounts.dailyLossStop > ceil(ceiling.dailyLossStop)) {
    throw new TradingLimitsError(`The daily loss stop cannot be more than ${fmt(ceil(ceiling.dailyLossStop))} for a test wallet.`);
  }
  if (amounts.perTrade > ceil(ceiling.perTrade)) {
    throw new TradingLimitsError(`The maximum per trade cannot be more than ${fmt(ceil(ceiling.perTrade))} for a test wallet.`);
  }
  if (amounts.perTrade > amounts.daily || amounts.daily > amounts.total) {
    throw new TradingLimitsError("The limits must go up: per trade no more than per day, and per day no more than in total.");
  }
  if (amounts.perTrade > amounts.maxBalance) {
    throw new TradingLimitsError("The maximum per trade cannot be more than the maximum balance.");
  }
  if (amounts.dailyLossStop > amounts.maxBalance) {
    throw new TradingLimitsError("The daily loss stop cannot be more than the maximum balance.");
  }
  if (amounts.topUpFloor !== null && amounts.topUpTarget === null) {
    throw new TradingLimitsError("Say what a top-up should bring the balance to (the top-up target), or leave the floor out too.");
  }
  if (amounts.topUpTarget !== null && amounts.topUpFloor === null) {
    throw new TradingLimitsError("A top-up target needs a floor: the balance below which the Trader asks for funds.");
  }
  if (amounts.topUpFloor !== null && amounts.topUpTarget !== null) {
    if (amounts.topUpFloor >= amounts.topUpTarget) throw new TradingLimitsError("The top-up target must be more than the floor.");
    if (amounts.topUpTarget > amounts.maxBalance) throw new TradingLimitsError("The top-up target cannot be more than the maximum balance.");
  }
  if (amounts.sweepThreshold !== null) {
    if (amounts.sweepThreshold > amounts.maxBalance) throw new TradingLimitsError("The sweep amount cannot be more than the maximum balance, or the wallet would pause before it ever swept.");
    if (amounts.topUpTarget !== null && amounts.sweepThreshold <= amounts.topUpTarget) {
      throw new TradingLimitsError("The sweep amount must be more than the top-up target, or a top-up would be swept straight back out.");
    }
    if (amounts.topUpFloor !== null && amounts.sweepThreshold <= amounts.topUpFloor) {
      throw new TradingLimitsError("The sweep amount must be more than the top-up floor.");
    }
  }
  return amounts;
}

export type TradeVerdict = { kind: "allow" } | { kind: "block"; reason: string };

/** The per-trade, per-day and lifetime caps a trade placed by the routine must stay inside. */
export function evaluateRoutineTrade(input: {
  amount: bigint;
  perTrade: bigint;
  daily: bigint;
  total: bigint;
  spentToday: bigint;
  spentTotal: bigint;
  formatAmount: (baseUnits: bigint) => string;
}): TradeVerdict {
  const { amount, formatAmount } = input;
  if (amount <= 0n) return { kind: "block", reason: "The trade must be worth more than zero." };
  if (amount > input.perTrade) {
    return { kind: "block", reason: `This trade is worth ${formatAmount(amount)}, more than the wallet's limit of ${formatAmount(input.perTrade)} per trade.` };
  }
  if (input.spentToday + amount > input.daily) {
    return { kind: "block", reason: `This would go over the wallet's daily limit of ${formatAmount(input.daily)} (already traded today: ${formatAmount(input.spentToday)}).` };
  }
  if (input.spentTotal + amount > input.total) {
    return { kind: "block", reason: `This would go over the wallet's total limit of ${formatAmount(input.total)} (already traded: ${formatAmount(input.spentTotal)}).` };
  }
  return { kind: "allow" };
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface DailyLossState {
  /** The balance plus what the wallet itself sent out today (sweeps, owner sends): those never count as a loss. */
  adjusted: bigint;
  /**
   * The day's loss reference: the highest adjusted balance so far, plus any
   * loss already taken that a later jump upwards must not erase. The loss is
   * always `peak - adjusted`.
   */
  peak: bigint;
  /** peak - adjusted, never negative. */
  loss: bigint;
}

/**
 * The daily loss is measured from the day's highest balance, so a profit
 * that is given back counts as a loss. Any rise between two readings is
 * treated as a possible deposit (the balance alone cannot tell it from a
 * trading gain): the reference rises by the same amount, so the loss already
 * taken stays and topping up cannot wipe out the count, whether the deposit
 * lands above or below the reference (DUR-5087 N3, DUR-5111). The price is
 * that a gain never offsets an earlier loss on the same day; the stop errs
 * towards pausing, never towards missing a loss. The first look of a new day also
 * starts from the last balance seen the day before, so an overnight drop is
 * not forgotten. After the owner restarts a paused wallet (lossDayPeak null),
 * the count starts again from the balance as it is.
 *
 * previousBalance is the reading before this one; the balance at that reading
 * is estimated as `previousBalance + outflowsToday`. A send that confirmed
 * between the two readings is already in outflowsToday but not in
 * previousBalance, so that estimate is too high by the send, and the rise
 * (hence the reference lift) too low. That understates the loss, now and in
 * later readings, when a deposit or gain lands in the same interval as a
 * confirmed send; the peak floor above keeps it from falling below the
 * adjusted balance. Known residual: a sweep and a deposit landing in the
 * same interval can still hide the deposit's share of an earlier loss.
 */
export function evaluateDailyLoss(input: {
  balance: bigint;
  outflowsToday: bigint;
  today: string;
  lossDay: string | null;
  lossDayPeak: bigint | null;
  previousBalance: bigint | null;
}): DailyLossState {
  const adjusted = input.balance + input.outflowsToday;
  let peak: bigint;
  if (input.lossDay === input.today && input.lossDayPeak !== null) {
    // Any rise lifts the reference by the same amount, so the loss already taken is carried, never reduced.
    const previousAdjusted = input.previousBalance === null ? input.lossDayPeak : input.previousBalance + input.outflowsToday;
    const rise = adjusted > previousAdjusted ? adjusted - previousAdjusted : 0n;
    // Never below the adjusted balance: a sweep confirmed in the same interval as a rise hides part of the rise from `previousAdjusted`.
    peak = input.lossDayPeak + rise;
    if (peak < adjusted) peak = adjusted;
  } else if (input.lossDay !== null && input.previousBalance !== null) {
    peak = input.previousBalance > adjusted ? input.previousBalance : adjusted;
  } else {
    peak = adjusted;
  }
  return { adjusted, peak, loss: peak > adjusted ? peak - adjusted : 0n };
}

export type BalanceBreach =
  | { kind: "ok" }
  | { kind: "daily_loss"; reason: string }
  | { kind: "max_balance"; reason: string };

/** Which hard stop, if any, the wallet has hit. The loss stop is checked first: it is the one that protects the funds. */
export function evaluateBalanceBreach(input: {
  chain: CryptoChain;
  /** The balance minus anything the wallet itself already sent that the network has not shown yet. */
  effectiveBalance: bigint;
  loss: bigint;
  maxBalance: bigint;
  dailyLossStop: bigint;
}): BalanceBreach {
  const fmt = (v: bigint) => formatChainAmount(input.chain, v);
  if (input.dailyLossStop > 0n && input.loss >= input.dailyLossStop) {
    return { kind: "daily_loss", reason: `Daily loss stop reached: the wallet is down ${fmt(input.loss)} from today's highest balance (the stop is ${fmt(input.dailyLossStop)}).` };
  }
  if (input.effectiveBalance > input.maxBalance) {
    return { kind: "max_balance", reason: `Maximum balance exceeded: the wallet holds ${fmt(input.effectiveBalance)} and may hold at most ${fmt(input.maxBalance)}.` };
  }
  return { kind: "ok" };
}

/** How much of the balance above the sweep amount a sweep should send, or null when there is nothing worth sending. */
export function sweepAmount(input: { effectiveBalance: bigint; threshold: bigint; dust: bigint }): bigint | null {
  const surplus = input.effectiveBalance - input.threshold;
  return surplus > input.dust ? surplus : null;
}

/** Whether the balance has fallen to or below the top-up floor, and by how much a top-up should raise it. */
export function topUpNeeded(input: { balance: bigint; floor: bigint; target: bigint }): bigint | null {
  if (input.balance >= input.floor) return null;
  const amount = input.target - input.balance;
  return amount > 0n ? amount : null;
}
