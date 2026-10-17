import { describe, expect, it } from "vitest";
import { DEFAULT_CRYPTO_AGENT_LIMITS } from "@paperclipai/shared";
import { evaluateHyperliquidLeverage, evaluateWalletSpend, type WalletSpendGateInput } from "../services/crypto-wallet-policy.ts";

/** The pure spending gate: limits, thresholds and the leverage cap, no database, no network. */

function input(overrides: Partial<WalletSpendGateInput> & { wallet?: Partial<WalletSpendGateInput["wallet"]>; agent?: Partial<WalletSpendGateInput["agent"]> } = {}): WalletSpendGateInput {
  const { wallet, agent, ...rest } = overrides;
  return {
    amount: 100n,
    fee: 0n,
    amountUsd: 5,
    assetLabel: "SOL",
    formatAmount: (v) => `${v} units`,
    wallet: {
      perTransactionLimit: 1_000n,
      dailyLimit: 2_000n,
      totalLimit: 10_000n,
      approvalAbove: 500n,
      spentToday: 0n,
      spentTotal: 0n,
      ...wallet,
    },
    agent: { ...DEFAULT_CRYPTO_AGENT_LIMITS, spentTodayUsd: 0, spentTotalUsd: 0, ...agent },
    ...rest,
  };
}

describe("evaluateWalletSpend", () => {
  it("allows a small payment inside every limit", () => {
    expect(evaluateWalletSpend(input())).toEqual({ kind: "allow" });
  });

  it("refuses zero and unpriced payments", () => {
    expect(evaluateWalletSpend(input({ amount: 0n })).kind).toBe("block");
    const unpriced = evaluateWalletSpend(input({ amountUsd: null }));
    expect(unpriced).toMatchObject({ kind: "block" });
    expect((unpriced as { reason: string }).reason).toMatch(/price/);
  });

  it("enforces the wallet's per-payment, daily and total limits", () => {
    expect(evaluateWalletSpend(input({ amount: 1_001n }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/per payment/) });
    expect(evaluateWalletSpend(input({ amount: 400n, wallet: { spentToday: 1_700n } }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/daily limit/) });
    expect(evaluateWalletSpend(input({ amount: 400n, wallet: { spentTotal: 9_700n } }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/total limit/) });
    // Exactly at the limit is still allowed.
    expect(evaluateWalletSpend(input({ amount: 400n, amountUsd: 1, wallet: { spentToday: 1_600n, approvalAbove: null } })).kind).toBe("needs_approval");
  });

  it("enforces the agent's dollar limits across wallets", () => {
    expect(evaluateWalletSpend(input({ amountUsd: 26 }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/per payment/) });
    expect(evaluateWalletSpend(input({ amountUsd: 5, agent: { spentTodayUsd: 46 } }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/daily limit/) });
    expect(evaluateWalletSpend(input({ amountUsd: 5, agent: { spentTotalUsd: 196 } }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/total limit/) });
  });

  it("asks for approval at or above either threshold, or always when a threshold is off", () => {
    expect(evaluateWalletSpend(input({ amount: 500n })).kind).toBe("needs_approval");
    expect(evaluateWalletSpend(input({ amountUsd: 10 })).kind).toBe("needs_approval");
    expect(evaluateWalletSpend(input({ wallet: { approvalAbove: null } })).kind).toBe("needs_approval");
    expect(evaluateWalletSpend(input({ agent: { approvalAboveUsd: null } })).kind).toBe("needs_approval");
    expect(evaluateWalletSpend(input({ amount: 499n, amountUsd: 9.99 })).kind).toBe("allow");
  });

  it("checks limits before approval: an approval card can never lift a limit", () => {
    expect(evaluateWalletSpend(input({ amount: 5_000n, wallet: { approvalAbove: null } })).kind).toBe("block");
  });
});

describe("network fees in the spending gate", () => {
  it("counts the fee with the amount in every wallet limit and the approval threshold", () => {
    expect(evaluateWalletSpend(input({ amount: 990n, fee: 20n }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/network fee included/) });
    expect(evaluateWalletSpend(input({ amount: 400n, fee: 1n, amountUsd: 1, wallet: { spentToday: 1_600n, approvalAbove: null } })).kind).toBe("block");
    expect(evaluateWalletSpend(input({ amount: 490n, fee: 10n, amountUsd: 1 })).kind).toBe("needs_approval");
  });

  it("refuses a fee larger than the payment itself", () => {
    expect(evaluateWalletSpend(input({ amount: 100n, fee: 101n }))).toMatchObject({ kind: "block", reason: expect.stringMatching(/more than the payment itself/) });
  });
});

describe("evaluateHyperliquidLeverage", () => {
  const base = { orderValueUsd: 50, reduceOnly: false, accountValueUsd: 100, openPositionsValueUsd: 0, maxLeverage: 1 };

  it("keeps total exposure within maxLeverage x account value", () => {
    expect(evaluateHyperliquidLeverage(base)).toEqual({ ok: true });
    expect(evaluateHyperliquidLeverage({ ...base, openPositionsValueUsd: 60 })).toMatchObject({ ok: false });
    expect(evaluateHyperliquidLeverage({ ...base, orderValueUsd: 150, maxLeverage: 2 })).toEqual({ ok: true });
    expect(evaluateHyperliquidLeverage({ ...base, orderValueUsd: 250, maxLeverage: 2 })).toMatchObject({ ok: false });
  });

  it("refuses when any number from the exchange is not a real number (S3)", () => {
    expect(evaluateHyperliquidLeverage({ ...base, accountValueUsd: Number.NaN })).toMatchObject({ ok: false });
    expect(evaluateHyperliquidLeverage({ ...base, openPositionsValueUsd: Number.NaN })).toMatchObject({ ok: false });
    expect(evaluateHyperliquidLeverage({ ...base, accountValueUsd: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false });
  });

  it("always allows a reduce-only order and refuses an empty account", () => {
    expect(evaluateHyperliquidLeverage({ ...base, reduceOnly: true, orderValueUsd: 1_000 })).toEqual({ ok: true });
    expect(evaluateHyperliquidLeverage({ ...base, accountValueUsd: 0 })).toMatchObject({ ok: false });
  });
});
