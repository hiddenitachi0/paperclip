import type { CryptoAgentLimits } from "@paperclipai/shared";

/**
 * The spending gate for agent crypto wallets -- pure, deterministic and
 * unit-testable without a database or a network call, the same shape as
 * trading-risk-gate.ts. It never moves money; it only says whether a payment
 * may go ahead, must wait for a person, or is refused (and why, in one plain
 * sentence for the agent, the ledger and the approval card).
 *
 * The switches (company kill switch, wallet frozen, real money off, address
 * not on the allow-list) are checked by the service before this runs, since
 * they need no arithmetic and must refuse even a zero-value request.
 */

export interface WalletSpendGateInput {
  /** Base units of the wallet's own coin (or USDC micro-units for a Hyperliquid order). */
  amount: bigint;
  /**
   * The most this payment may pay in network fees (base units). Counted
   * together with the amount in every limit and threshold below: the
   * network service sets the fee, so it is never left out of the sums.
   */
  fee: bigint;
  /** Dollar value of amount + fee, or null when no price was available. */
  amountUsd: number | null;
  assetLabel: string;
  formatAmount: (baseUnits: bigint) => string;
  wallet: {
    perTransactionLimit: bigint;
    dailyLimit: bigint;
    totalLimit: bigint;
    approvalAbove: bigint | null;
    spentToday: bigint;
    spentTotal: bigint;
  };
  agent: CryptoAgentLimits & {
    spentTodayUsd: number;
    spentTotalUsd: number;
  };
}

export type WalletSpendVerdict =
  | { kind: "allow" }
  | { kind: "needs_approval"; reasonForOperator: string }
  | { kind: "block"; reason: string };

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function evaluateWalletSpend(input: WalletSpendGateInput): WalletSpendVerdict {
  const { amount, fee, amountUsd, wallet, agent, formatAmount } = input;

  if (amount <= 0n) return { kind: "block", reason: "The amount must be more than zero." };
  if (fee < 0n) return { kind: "block", reason: "The network fee could not be worked out." };
  // A fee bigger than the payment itself is never worth it, and is the
  // first sign of a network service asking for far too much.
  if (fee > amount) {
    return { kind: "block", reason: `The network fee could be up to ${formatAmount(fee)}, more than the payment itself. Nothing was sent.` };
  }
  const total = amount + fee;
  const withFee = fee > 0n ? " (network fee included)" : "";

  // Without a price, the dollar limits cannot be checked. Refuse rather
  // than guess -- the agent can try again when prices are available.
  if (amountUsd === null || !Number.isFinite(amountUsd) || amountUsd < 0) {
    return { kind: "block", reason: "Could not get a price to check the dollar limits, so nothing was sent. Try again in a few minutes." };
  }

  if (total > wallet.perTransactionLimit) {
    return { kind: "block", reason: `This is more than the wallet's limit of ${formatAmount(wallet.perTransactionLimit)} per payment${withFee}.` };
  }
  if (wallet.spentToday + total > wallet.dailyLimit) {
    return {
      kind: "block",
      reason: `This would go over the wallet's daily limit of ${formatAmount(wallet.dailyLimit)} (already used today: ${formatAmount(wallet.spentToday)}).`,
    };
  }
  if (wallet.spentTotal + total > wallet.totalLimit) {
    return {
      kind: "block",
      reason: `This would go over the wallet's total limit of ${formatAmount(wallet.totalLimit)} (already used: ${formatAmount(wallet.spentTotal)}).`,
    };
  }

  if (amountUsd > agent.perTransactionUsd) {
    return { kind: "block", reason: `This is worth about ${usd(amountUsd)}, more than this agent's limit of ${usd(agent.perTransactionUsd)} per payment.` };
  }
  if (agent.spentTodayUsd + amountUsd > agent.dailyUsd) {
    return {
      kind: "block",
      reason: `This would take the agent over its daily limit of ${usd(agent.dailyUsd)} across all its wallets (already used today: ${usd(agent.spentTodayUsd)}).`,
    };
  }
  if (agent.spentTotalUsd + amountUsd > agent.totalUsd) {
    return {
      kind: "block",
      reason: `This would take the agent over its total limit of ${usd(agent.totalUsd)} across all its wallets (already used: ${usd(agent.spentTotalUsd)}).`,
    };
  }

  const walletNeedsApproval = wallet.approvalAbove === null || total >= wallet.approvalAbove;
  const agentNeedsApproval = agent.approvalAboveUsd === null || amountUsd >= agent.approvalAboveUsd;
  if (walletNeedsApproval || agentNeedsApproval) {
    const why =
      wallet.approvalAbove === null || agent.approvalAboveUsd === null
        ? "every payment from this wallet needs approval"
        : walletNeedsApproval
          ? `it is at or above the wallet's approval amount of ${formatAmount(wallet.approvalAbove!)}`
          : `it is at or above the agent's approval amount of ${usd(agent.approvalAboveUsd!)}`;
    return { kind: "needs_approval", reasonForOperator: `About ${usd(amountUsd)}; a person must approve because ${why}.` };
  }

  return { kind: "allow" };
}

/**
 * Hyperliquid leverage cap: the order's value plus every open position's
 * value must stay within maxLeverage x the account value. A reduce-only
 * order (one that can only shrink a position) is always within the cap.
 */
export function evaluateHyperliquidLeverage(input: {
  orderValueUsd: number;
  reduceOnly: boolean;
  accountValueUsd: number;
  openPositionsValueUsd: number;
  maxLeverage: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.reduceOnly) return { ok: true };
  // Anything that is not a plain finite number (a broken or hostile answer
  // from the exchange) refuses the order rather than slipping past the
  // comparisons below, which are all false for NaN.
  if (![input.orderValueUsd, input.accountValueUsd, input.openPositionsValueUsd, input.maxLeverage].every((v) => Number.isFinite(v) && v >= 0)) {
    return { ok: false, reason: "The Hyperliquid account's numbers could not be read, so the leverage cap could not be checked." };
  }
  if (input.accountValueUsd <= 0) return { ok: false, reason: "The Hyperliquid account has no money in it to trade with." };
  const exposure = input.openPositionsValueUsd + input.orderValueUsd;
  const allowed = input.accountValueUsd * input.maxLeverage;
  if (exposure > allowed + 1e-9) {
    return {
      ok: false,
      reason: `This order would put ${usd(exposure)} in open trades, more than ${input.maxLeverage}x the account's ${usd(input.accountValueUsd)} (the leverage cap).`,
    };
  }
  return { ok: true };
}
