import { z } from "zod";
import { CRYPTO_CHAINS, type CryptoChain } from "./crypto-wallets.js";

/**
 * Trading wallets held by code (Filip, 28 Oct 2026, decision #2). A trading
 * wallet belongs to Paperclip's trading routine, not to any agent:
 *
 *   - The key is generated on the server and kept only as a
 *     `crypto_wallet_key` secret. No API returns it, no agent can use the
 *     wallet's tools, and the one AI Trader agent never sees a key. Paperclip
 *     code places every trade.
 *   - Hard limits per wallet, enforced in code: maximum balance, maximum per
 *     trade, daily loss stop. Breaching one pauses the wallet and queues a
 *     Telegram alert.
 *   - Profit sweep: above an owner-set threshold the routine sends the
 *     surplus, and only to the owner-set cold-wallet address. The first sweep
 *     and any change of that address need an owner approval card.
 *   - Top-up: below a floor the Trader files a plain-language "please top
 *     up" card. The owner sends the funds himself.
 *   - Test networks only. The database refuses a code-held wallet on a main
 *     network, and the server-wide real-money lock stays on.
 *
 * No key material and no network call lives in this file.
 */

export const CRYPTO_WALLET_HOLDERS = ["agent", "trading_routine"] as const;
export type CryptoWalletHolder = (typeof CRYPTO_WALLET_HOLDERS)[number];

/** Amounts of a trading wallet's hard limits and flows, in its own coin, as decimal strings ("0.01"). */
export interface TradingWalletSettings {
  /** The most the wallet may ever hold. Above it, the wallet is paused. */
  maxBalance: string;
  /** The most the day may lose, counted from the day's highest balance. At it, the wallet is paused. */
  dailyLossStop: string;
  /** Above this balance, the surplus is swept to the cold wallet. null = no sweeping. */
  sweepThreshold: string | null;
  /** Below this balance, a "please top up" card is filed. null = no top-up cards. */
  topUpFloor: string | null;
  /** What a top-up should bring the balance to. */
  topUpTarget: string | null;
  /** The approved cold-wallet address, or null. Sweeps go only here. */
  sweepAddress: string | null;
  sweepAddressApprovedAt: string | null;
  /** A new address waiting for the owner's approval card; never used before it is approved. */
  pendingSweepAddress: string | null;
}

/** Hard ceilings no setting may exceed (test coins; a release raises them, never a setting). */
export const TRADING_WALLET_HARD_CEILING: Record<CryptoChain, { maxBalance: string; dailyLossStop: string; perTrade: string }> = {
  bitcoin: { maxBalance: "0.05", dailyLossStop: "0.01", perTrade: "0.01" },
  ethereum: { maxBalance: "2", dailyLossStop: "0.5", perTrade: "0.5" },
  solana: { maxBalance: "20", dailyLossStop: "5", perTrade: "5" },
  hyperliquid: { maxBalance: "1000", dailyLossStop: "200", perTrade: "500" },
};

export interface TradingWalletLimitInput {
  /** Max per trade. */
  perTrade: string;
  /** Max traded per day. */
  daily: string;
  /** Max traded in the wallet's whole life. */
  total: string;
  maxBalance: string;
  dailyLossStop: string;
  sweepThreshold: string | null;
  topUpFloor: string | null;
  topUpTarget: string | null;
}

export const DEFAULT_TRADING_WALLET_LIMITS: Record<CryptoChain, TradingWalletLimitInput> = {
  bitcoin: { perTrade: "0.0005", daily: "0.001", total: "0.01", maxBalance: "0.01", dailyLossStop: "0.001", sweepThreshold: null, topUpFloor: "0.0005", topUpTarget: "0.002" },
  ethereum: { perTrade: "0.01", daily: "0.02", total: "0.5", maxBalance: "0.2", dailyLossStop: "0.02", sweepThreshold: null, topUpFloor: "0.01", topUpTarget: "0.05" },
  solana: { perTrade: "0.2", daily: "0.4", total: "10", maxBalance: "5", dailyLossStop: "0.5", sweepThreshold: null, topUpFloor: "0.3", topUpTarget: "1" },
  hyperliquid: { perTrade: "25", daily: "100", total: "5000", maxBalance: "200", dailyLossStop: "10", sweepThreshold: null, topUpFloor: "20", topUpTarget: "100" },
};

/** Alerts the trading routine queues for the Telegram bridge. */
export const TRADING_ALERT_KINDS = [
  "wallet_paused",
  "top_up_requested",
  "sweep_address_requested",
  "sweep_waiting_approval",
  "sweep_sent",
] as const;
export type TradingAlertKind = (typeof TRADING_ALERT_KINDS)[number];

export interface TradingAlertOutboxItem {
  id: string;
  companyId: string;
  walletId: string | null;
  kind: string;
  text: string;
  createdAt: string;
}

export const ackTradingAlertOutboxSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AckTradingAlertOutboxInput = z.infer<typeof ackTradingAlertOutboxSchema>;

const decimalAmount = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Write the amount as a plain number, like 0.01.")
  .max(40);

export const tradingWalletLimitsSchema = z
  .object({
    perTrade: decimalAmount,
    daily: decimalAmount,
    total: decimalAmount,
    maxBalance: decimalAmount,
    dailyLossStop: decimalAmount,
    sweepThreshold: decimalAmount.nullable(),
    topUpFloor: decimalAmount.nullable(),
    topUpTarget: decimalAmount.nullable(),
  })
  .strict();

export const createTradingWalletSchema = z
  .object({
    chain: z.enum(CRYPTO_CHAINS),
    label: z.string().trim().min(1, "Give the wallet a name.").max(120),
    /** Omit to start from DEFAULT_TRADING_WALLET_LIMITS for the chain. */
    limits: tradingWalletLimitsSchema.optional(),
  })
  // No `mode`, `privateKey`, `agentId` or `network`: the server makes its own
  // key, no agent holds the wallet and it lives on the test network only.
  .strict();
export type CreateTradingWalletInput = z.infer<typeof createTradingWalletSchema>;

export const updateTradingWalletLimitsSchema = z
  .object({
    limits: tradingWalletLimitsSchema,
  })
  .strict();
export type UpdateTradingWalletLimitsInput = z.infer<typeof updateTradingWalletLimitsSchema>;

/** The owner proposes a cold-wallet address; it only takes effect once the owner approves the card it files. */
export const proposeSweepAddressSchema = z
  .object({
    address: z.string().trim().min(10).max(120),
  })
  .strict();
export type ProposeSweepAddressInput = z.infer<typeof proposeSweepAddressSchema>;

/** The Trader's plain-language reason on a "please top up" card. The amount and the recent results are filled in by the server. */
export const requestTradingTopUpSchema = z
  .object({
    reason: z.string().trim().min(3, "Say in a sentence why the wallet needs more funds.").max(600),
  })
  .strict();
export type RequestTradingTopUpInput = z.infer<typeof requestTradingTopUpSchema>;

export const setTraderAgentSchema = z
  .object({
    traderAgentId: z.string().uuid().nullable(),
  })
  .strict();

export const TRADING_WALLET_WORDING = {
  holds:
    "Held by Paperclip's trading code. The key is made on the server and kept locked; no agent, and not the Trader, can see or use it. Test network only.",
  limits:
    "Three hard stops pause the wallet and send you a Telegram alert: more than the maximum balance, more than the maximum per trade (the trade is refused), and a daily loss at the stop. You decide when to start it again.",
  sweep:
    "When the balance goes above the sweep amount, the surplus is sent to your cold wallet, and only there. The first sweep and any change of that address wait for your approval.",
  topUp:
    "When the balance falls below the floor, the Trader files a card saying how much to add and why. You send the funds yourself.",
} as const;
