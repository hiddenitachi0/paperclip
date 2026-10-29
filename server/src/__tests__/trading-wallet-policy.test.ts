import { describe, expect, it } from "vitest";
import { DEFAULT_TRADING_WALLET_LIMITS, type TradingWalletLimitInput } from "@paperclipai/shared";
import {
  evaluateBalanceBreach,
  evaluateDailyLoss,
  evaluateRoutineTrade,
  parseTradingLimits,
  sweepAmount,
  topUpNeeded,
  TradingLimitsError,
} from "../services/trading-wallet-policy.js";

const fmt = (v: bigint) => `${v}`;
const USDC = 1_000_000n;

describe("parseTradingLimits", () => {
  it("accepts the defaults of every chain", () => {
    for (const chain of ["bitcoin", "ethereum", "solana", "hyperliquid"] as const) {
      expect(() => parseTradingLimits(chain, DEFAULT_TRADING_WALLET_LIMITS[chain])).not.toThrow();
    }
  });

  const base: TradingWalletLimitInput = { ...DEFAULT_TRADING_WALLET_LIMITS.hyperliquid, sweepThreshold: "150" };

  it("refuses limits above the hard ceilings in code", () => {
    expect(() => parseTradingLimits("hyperliquid", { ...base, maxBalance: "1001", sweepThreshold: null })).toThrow(/maximum balance cannot be more than/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, dailyLossStop: "201" })).toThrow(/daily loss stop cannot be more than/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, perTrade: "501", daily: "600", total: "9000" })).toThrow(/per trade cannot be more than/);
  });

  it("refuses limits that do not fit together", () => {
    expect(() => parseTradingLimits("hyperliquid", { ...base, perTrade: "50", daily: "40" })).toThrow(/limits must go up/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, maxBalance: "0" })).toThrow(/more than zero/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, dailyLossStop: "0" })).toThrow(/more than zero/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, sweepThreshold: "300" })).toThrow(/pause before it ever swept/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, sweepThreshold: "100" })).toThrow(/more than the top-up target/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, topUpFloor: "100", topUpTarget: "50" })).toThrow(/target must be more than the floor/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, topUpFloor: null, sweepThreshold: null })).toThrow(/needs a floor/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, topUpTarget: null, sweepThreshold: null })).toThrow(/top-up target/);
    expect(() => parseTradingLimits("hyperliquid", { ...base, maxBalance: "20", sweepThreshold: null, topUpFloor: null, topUpTarget: null, perTrade: "25" })).toThrow(/per trade cannot be more than the maximum balance/);
  });

  it("refuses an amount with too many decimals instead of rounding it", () => {
    expect(() => parseTradingLimits("hyperliquid", { ...base, maxBalance: "100.1234567" })).toThrow(TradingLimitsError);
  });
});

describe("evaluateRoutineTrade", () => {
  const caps = { perTrade: 25n * USDC, daily: 100n * USDC, total: 500n * USDC, formatAmount: fmt };
  it("allows a trade inside every cap", () => {
    expect(evaluateRoutineTrade({ ...caps, amount: 25n * USDC, spentToday: 0n, spentTotal: 0n })).toEqual({ kind: "allow" });
  });
  it("refuses a trade over the per-trade cap, the daily cap and the total cap", () => {
    expect(evaluateRoutineTrade({ ...caps, amount: 26n * USDC, spentToday: 0n, spentTotal: 0n })).toMatchObject({ kind: "block", reason: expect.stringMatching(/per trade/) });
    expect(evaluateRoutineTrade({ ...caps, amount: 20n * USDC, spentToday: 90n * USDC, spentTotal: 0n })).toMatchObject({ kind: "block", reason: expect.stringMatching(/daily limit/) });
    expect(evaluateRoutineTrade({ ...caps, amount: 20n * USDC, spentToday: 0n, spentTotal: 490n * USDC })).toMatchObject({ kind: "block", reason: expect.stringMatching(/total limit/) });
    expect(evaluateRoutineTrade({ ...caps, amount: 0n, spentToday: 0n, spentTotal: 0n })).toMatchObject({ kind: "block" });
  });
});

describe("evaluateDailyLoss", () => {
  const today = "2026-10-29";
  it("starts from the balance as it is when there is no earlier reading", () => {
    expect(evaluateDailyLoss({ balance: 100n, outflowsToday: 0n, today, lossDay: null, lossDayPeak: null, previousBalance: 500n })).toMatchObject({ peak: 100n, loss: 0n });
  });
  it("measures from the day's highest balance, so profit given back counts as loss", () => {
    const up = evaluateDailyLoss({ balance: 130n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: 100n, previousBalance: 100n });
    expect(up).toMatchObject({ peak: 130n, loss: 0n });
    const down = evaluateDailyLoss({ balance: 110n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: up.peak, previousBalance: 130n });
    expect(down).toMatchObject({ peak: 130n, loss: 20n });
  });
  it("does not count the wallet's own confirmed sweeps as a loss", () => {
    const state = evaluateDailyLoss({ balance: 100n, outflowsToday: 50n, today, lossDay: today, lossDayPeak: 150n, previousBalance: 150n });
    expect(state).toMatchObject({ adjusted: 150n, loss: 0n });
  });
  it("does not let a deposit hide an earlier loss: the deposit lifts the bar but the loss stays", () => {
    const afterLoss = evaluateDailyLoss({ balance: 80n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: 100n, previousBalance: 100n });
    expect(afterLoss.loss).toBe(20n);
    const afterDeposit = evaluateDailyLoss({ balance: 180n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: afterLoss.peak, previousBalance: 80n });
    expect(afterDeposit).toMatchObject({ peak: 200n, loss: 20n });
    // ...and a further drop adds to it.
    expect(evaluateDailyLoss({ balance: 150n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: afterDeposit.peak, previousBalance: 180n }).loss).toBe(50n);
  });
  it("keeps the loss taken before a mid-day top-up, so the stop still trips (DUR-5087 N3)", () => {
    const stop = 10n * USDC;
    // 25 -> 19: a loss of 6.
    const down = evaluateDailyLoss({ balance: 19n * USDC, outflowsToday: 0n, today, lossDay: today, lossDayPeak: 25n * USDC, previousBalance: 25n * USDC });
    expect(down.loss).toBe(6n * USDC);
    // Top up to 100: the loss of 6 is still counted.
    const topUp = evaluateDailyLoss({ balance: 100n * USDC, outflowsToday: 0n, today, lossDay: today, lossDayPeak: down.peak, previousBalance: 19n * USDC });
    expect(topUp.loss).toBe(6n * USDC);
    // Lose 9.9 more: 15.9 in total, over the stop of 10.
    const lost = evaluateDailyLoss({ balance: 90_100_000n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: topUp.peak, previousBalance: 100n * USDC });
    expect(lost.loss).toBe(15_900_000n);
    expect(lost.loss >= stop).toBe(true);
  });
  it("still lets a gain raise the bar when nothing is owed, so given-back profit counts", () => {
    const up = evaluateDailyLoss({ balance: 130n, outflowsToday: 0n, today, lossDay: today, lossDayPeak: 100n, previousBalance: 100n });
    expect(up).toMatchObject({ peak: 130n, loss: 0n });
  });
  it("carries last night's balance into a new day so an overnight drop is not forgotten", () => {
    expect(evaluateDailyLoss({ balance: 70n, outflowsToday: 0n, today, lossDay: "2026-10-28", lossDayPeak: 120n, previousBalance: 100n })).toMatchObject({ peak: 100n, loss: 30n });
  });
});

describe("evaluateBalanceBreach", () => {
  const base = { chain: "hyperliquid" as const, maxBalance: 200n * USDC, dailyLossStop: 10n * USDC };
  it("is ok inside both stops", () => {
    expect(evaluateBalanceBreach({ ...base, effectiveBalance: 200n * USDC, loss: 9n * USDC })).toEqual({ kind: "ok" });
  });
  it("trips the daily loss stop at the stop, and the max balance above the max", () => {
    expect(evaluateBalanceBreach({ ...base, effectiveBalance: 100n * USDC, loss: 10n * USDC })).toMatchObject({ kind: "daily_loss" });
    expect(evaluateBalanceBreach({ ...base, effectiveBalance: 200n * USDC + 1n, loss: 0n })).toMatchObject({ kind: "max_balance" });
  });
  it("reports the loss stop first when both trip", () => {
    expect(evaluateBalanceBreach({ ...base, effectiveBalance: 300n * USDC, loss: 50n * USDC }).kind).toBe("daily_loss");
  });
});

describe("sweepAmount and topUpNeeded", () => {
  it("sweeps only the surplus above the threshold and only when it is worth more than dust", () => {
    expect(sweepAmount({ effectiveBalance: 150n * USDC, threshold: 100n * USDC, dust: USDC })).toBe(50n * USDC);
    expect(sweepAmount({ effectiveBalance: 100n * USDC, threshold: 100n * USDC, dust: USDC })).toBeNull();
    expect(sweepAmount({ effectiveBalance: 101n * USDC, threshold: 100n * USDC, dust: USDC })).toBeNull();
    expect(sweepAmount({ effectiveBalance: 50n * USDC, threshold: 100n * USDC, dust: USDC })).toBeNull();
  });
  it("asks for the difference up to the target, only below the floor", () => {
    expect(topUpNeeded({ balance: 15n * USDC, floor: 20n * USDC, target: 100n * USDC })).toBe(85n * USDC);
    expect(topUpNeeded({ balance: 20n * USDC, floor: 20n * USDC, target: 100n * USDC })).toBeNull();
  });
});
