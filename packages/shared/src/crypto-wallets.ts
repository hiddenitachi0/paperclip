import { z } from "zod";

/**
 * Crypto wallets for agents (approved by Filip 17 Oct 2026): an agent may
 * hold its own Bitcoin, Ethereum, Solana or Hyperliquid wallet, for trading
 * or for paying for things. Safety first, throughout:
 *
 *   - The private key lives ONLY in the encrypted company secrets store, as
 *     a `crypto_wallet_key` secret (never bindable, never returned by any
 *     API, never logged, never shown to an agent). The server signs.
 *   - Every company starts on test networks (test coins have no value).
 *     Real money ("mainnet") needs an explicit switch by the company owner.
 *   - Every send is checked against per-wallet limits (in the wallet's own
 *     coin) and per-agent limits (in US dollars), an allow-list of
 *     destination addresses, and an approval threshold above which a
 *     person must say yes on an approval card first.
 *   - A kill switch per wallet and one for the whole company.
 *   - Hyperliquid: leverage capped (1x by default), withdrawals only to
 *     allow-listed addresses. No automatic swaps or bridges anywhere.
 *
 * This file holds the shared types, defaults, hard ceilings, validators and
 * the plain-English wording the UI and server both use. It holds no key
 * material and makes no network call.
 */

// ─── Chains and networks ────────────────────────────────────────────────────

export const CRYPTO_CHAINS = ["bitcoin", "ethereum", "solana", "hyperliquid"] as const;
export type CryptoChain = (typeof CRYPTO_CHAINS)[number];

export const CRYPTO_NETWORKS = ["testnet", "mainnet"] as const;
export type CryptoNetwork = (typeof CRYPTO_NETWORKS)[number];

/**
 * Bitcoin has two free test networks. A Bitcoin test wallet is on exactly one
 * of them from creation on (crypto_wallets.network_variant, never changed).
 * New wallets default to signet (stable); testnet4 stays available, and every
 * wallet that existed before signet was added is testnet4.
 */
export const BITCOIN_NETWORK_VARIANTS = ["testnet4", "signet"] as const;
export type BitcoinNetworkVariant = (typeof BITCOIN_NETWORK_VARIANTS)[number];
export const DEFAULT_BITCOIN_NETWORK_VARIANT: BitcoinNetworkVariant = "signet";

/**
 * Where a company's own network address for a wallet is stored: one slot per
 * chain x network x variant, so signet and testnet4 never share one. The
 * 'testnet' slot of Bitcoin keeps meaning testnet4 (what it meant before
 * signet existed); 'signet' is a Bitcoin-only slot.
 */
export const CRYPTO_ENDPOINT_SLOTS = ["testnet", "mainnet", "signet"] as const;
export type CryptoEndpointSlot = (typeof CRYPTO_ENDPOINT_SLOTS)[number];

export function cryptoEndpointSlot(chain: CryptoChain, network: CryptoNetwork, networkVariant?: BitcoinNetworkVariant | null): CryptoEndpointSlot {
  if (network === "mainnet") return "mainnet";
  return chain === "bitcoin" && networkVariant === "signet" ? "signet" : "testnet";
}

export interface CryptoChainInfo {
  chain: CryptoChain;
  label: string;
  /** What the wallet holds and what its amounts are counted in. */
  asset: string;
  decimals: number;
  /** Plain name of the free test network this chain uses by default. */
  testnetLabel: string;
  /** Where to get free test coins, shown with the funding instructions. */
  testnetFaucetHint: string;
  /** Extra plain-language cautions about getting test coins, one per line. */
  testnetFaucetNotes: readonly string[];
  /** One plain sentence about what an agent can do with this wallet. */
  whatAgentsCanDo: string;
}

/** When the faucet hints below were last checked by a person. Update it whenever the hints change. */
export const CRYPTO_FAUCET_HINTS_AS_OF = "27 Oct 2026";
export const CRYPTO_FAUCET_HINTS_CHANGE_NOTE = "Faucets change often.";

/** Shown next to every test-network address and payment link. */
export const CRYPTO_TESTNET_SEND_WARNING = "Do not send real coins here. They cannot be recovered.";
export const CRYPTO_TESTNET_ONLY_LABEL = "TEST NETWORK ONLY";

export const CRYPTO_CHAIN_INFO: Record<CryptoChain, CryptoChainInfo> = {
  bitcoin: {
    chain: "bitcoin",
    label: "Bitcoin",
    asset: "BTC",
    decimals: 8,
    testnetLabel: "Bitcoin test network (testnet4)",
    testnetFaucetHint:
      "Get free test bitcoin from the coinfaucet.eu testnet4 faucet. It takes about an hour for the coins to be confirmed, and they can be spent only once confirmed.",
    testnetFaucetNotes: [
      "Signet is a different Bitcoin test network. Its faucet is signetfaucet.com (backup: alt.signetfaucet.com). Signet coins do not show up in this wallet.",
    ],
    whatAgentsCanDo: "Send bitcoin to addresses on this wallet's allowed list, for example to pay for something.",
  },
  ethereum: {
    chain: "ethereum",
    label: "Ethereum",
    asset: "ETH",
    decimals: 18,
    testnetLabel: "Ethereum test network (Sepolia)",
    testnetFaucetHint:
      "Get free test ether from the pk910 proof-of-work faucet, or from Google Cloud's Web3 faucet (it needs a Google sign-in and may ask for real ETH).",
    testnetFaucetNotes: [
      "Claiming to your own wallet and then forwarding the coins only works if that wallet holds real ETH.",
      "Never use a faucet that needs real ETH on this address.",
    ],
    whatAgentsCanDo: "Send ether to addresses on this wallet's allowed list, for example to pay for something.",
  },
  solana: {
    chain: "solana",
    label: "Solana",
    asset: "SOL",
    decimals: 9,
    testnetLabel: "Solana test network (devnet)",
    testnetFaucetHint:
      "Claim free test SOL by hand at faucet.solana.com (choose devnet). The faucet forbids AI agents, so a person must do it.",
    testnetFaucetNotes: [],
    whatAgentsCanDo: "Send SOL to addresses on this wallet's allowed list, for example to pay for something.",
  },
  hyperliquid: {
    chain: "hyperliquid",
    label: "Hyperliquid",
    asset: "USDC",
    decimals: 6,
    testnetLabel: "Hyperliquid test exchange",
    testnetFaucetHint:
      "The Hyperliquid test faucet needs a real-money deposit from the same address, and so would your own account there. We do not use it, because of the no-real-money rule.",
    testnetFaucetNotes: [],
    whatAgentsCanDo:
      "Place trades on the Hyperliquid exchange (leverage capped, 1x by default) and withdraw USDC only to addresses on the allowed list.",
  },
};

/**
 * A payment link that names the network, so a wallet app cannot mistake a
 * test address for a real one. Ethereum uses the chain id (…@11155111 for
 * Sepolia); Bitcoin test links carry a visible "TEST NETWORK ONLY" label.
 * null where no standard link exists (Solana, Hyperliquid).
 */
export function cryptoPaymentLink(chain: CryptoChain, network: CryptoNetwork, address: string, evmChainId?: number | null): string | null {
  switch (chain) {
    case "ethereum":
      // A test wallet names its own stored chain; the default only covers a caller that has none to give.
      return `ethereum:${address}@${network === "mainnet" ? EVM_CHAIN_IDS.mainnet : (evmChainId ?? EVM_CHAIN_IDS.testnet)}`;
    case "bitcoin":
      return network === "mainnet"
        ? `bitcoin:${address}`
        : `bitcoin:${address}?label=${encodeURIComponent(CRYPTO_TESTNET_ONLY_LABEL)}`;
    case "solana":
    case "hyperliquid":
      return null;
    default: {
      const exhaustive: never = chain;
      return exhaustive;
    }
  }
}

export const BITCOIN_SIGNET_LABEL = "Bitcoin test network (signet)";
export const BITCOIN_SIGNET_FAUCET_HINT =
  "Get free test bitcoin from a signet faucet, such as alt.signetfaucet.com. Signet coins are confirmed within about ten minutes.";

/** Plain names of the allowed Ethereum test networks, by chain ID. */
export const EVM_TEST_CHAIN_NAMES: Record<number, string> = { 11155111: "Sepolia", 560048: "Hoodi" };

export function cryptoNetworkLabel(
  chain: CryptoChain,
  network: CryptoNetwork,
  wallet?: { networkVariant?: string | null; evmChainId?: number | null },
): string {
  if (network === "mainnet") return `${CRYPTO_CHAIN_INFO[chain].label} main network (real money)`;
  if (chain === "bitcoin" && wallet?.networkVariant === "signet") return BITCOIN_SIGNET_LABEL;
  const evmName = chain === "ethereum" && wallet?.evmChainId != null ? EVM_TEST_CHAIN_NAMES[wallet.evmChainId] : undefined;
  if (evmName) return `Ethereum test network (${evmName})`;
  return CRYPTO_CHAIN_INFO[chain].testnetLabel;
}

/**
 * Public endpoints used when a company has not set its own. Every call goes
 * through the server's safe outbound fetch (https only, public addresses
 * only, no redirects). A company may replace any of these with its own
 * provider in the crypto settings.
 */
export const DEFAULT_CRYPTO_RPC_ENDPOINTS: Record<CryptoChain, Record<CryptoNetwork, string>> = {
  bitcoin: { testnet: "https://mempool.space/testnet4/api", mainnet: "https://mempool.space/api" },
  ethereum: { testnet: "https://ethereum-sepolia-rpc.publicnode.com", mainnet: "https://ethereum-rpc.publicnode.com" },
  solana: { testnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" },
  hyperliquid: { testnet: "https://api.hyperliquid-testnet.xyz", mainnet: "https://api.hyperliquid.xyz" },
};

/** Signet has no slot in the table above (it is Bitcoin-only); see cryptoEndpointSlot. */
export const DEFAULT_BITCOIN_SIGNET_RPC_ENDPOINT = "https://mempool.space/signet/api";

/** The built-in network address for a slot, or undefined where the chain has none (signet outside Bitcoin). */
export function defaultCryptoRpcEndpoint(chain: CryptoChain, slot: CryptoEndpointSlot): string | undefined {
  if (slot === "signet") return chain === "bitcoin" ? DEFAULT_BITCOIN_SIGNET_RPC_ENDPOINT : undefined;
  return DEFAULT_CRYPTO_RPC_ENDPOINTS[chain][slot];
}

/**
 * The chain ID a NEW Ethereum test wallet gets when none is chosen. It is
 * written onto the wallet at creation; signing reads the wallet's own stored
 * chain ID, never this, so changing it later moves no existing wallet.
 */
export const EVM_CHAIN_IDS: Record<CryptoNetwork, number> = { testnet: 11155111, mainnet: 1 };

/**
 * The only EVM chains a test-network wallet may ever sign on: Sepolia and
 * Hoodi. This is code, not a setting, on purpose: with a per-company chain
 * ID an owner could point a "test" wallet at chain 1, 8453 or 42161 through
 * a mainnet RPC address and the real-money lock would never see it. A
 * successor to Sepolia is added here by a release, never by a setting.
 */
export const TEST_EVM_CHAIN_IDS: readonly number[] = [11155111, 560048];

export function isTestEvmChainId(chainId: number | bigint): boolean {
  return TEST_EVM_CHAIN_IDS.some((id) => BigInt(id) === BigInt(chainId));
}

// ─── Amounts (always integer base units on the server) ─────────────────────

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * "0.0015" BTC -> 150000n sats. Returns null for anything that is not a
 * plain non-negative decimal or has more decimals than the asset supports --
 * never rounds, so an amount is never silently changed.
 */
export function parseCryptoAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 150000n sats -> "0.0015". */
export function formatCryptoAmount(baseUnits: bigint | string, decimals: number): string {
  const value = typeof baseUnits === "string" ? BigInt(baseUnits) : baseUnits;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

export function formatChainAmount(chain: CryptoChain, baseUnits: bigint | string | null | undefined): string {
  if (baseUnits === null || baseUnits === undefined) return "-";
  return `${formatCryptoAmount(baseUnits, CRYPTO_CHAIN_INFO[chain].decimals)} ${CRYPTO_CHAIN_INFO[chain].asset}`;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * Per-agent limits are counted in US dollars so one agent's spending can be
 * capped across all its wallets. These are hard ceilings no company setting
 * may exceed -- raising them needs a code change someone can see in review,
 * not a settings tweak (same idea as TRADING_HARD_CEILING).
 */
export const CRYPTO_AGENT_HARD_CEILING_USD = {
  perTransaction: 1_000,
  daily: 2_000,
  total: 10_000,
} as const;

export interface CryptoAgentLimits {
  perTransactionUsd: number;
  dailyUsd: number;
  totalUsd: number;
  /** A send at or above this needs a person to approve it first. null = every send needs approval. */
  approvalAboveUsd: number | null;
}

export const DEFAULT_CRYPTO_AGENT_LIMITS: CryptoAgentLimits = {
  perTransactionUsd: 25,
  dailyUsd: 50,
  totalUsd: 200,
  approvalAboveUsd: 10,
};

/** Per-wallet limits, in the wallet's own coin, as decimal strings ("0.001"). */
export interface CryptoWalletLimits {
  perTransaction: string;
  daily: string;
  total: string;
  /** null = every send from this wallet needs approval. */
  approvalAbove: string | null;
}

export const DEFAULT_CRYPTO_WALLET_LIMITS: Record<CryptoChain, CryptoWalletLimits> = {
  bitcoin: { perTransaction: "0.0005", daily: "0.001", total: "0.005", approvalAbove: "0.0002" },
  ethereum: { perTransaction: "0.01", daily: "0.02", total: "0.1", approvalAbove: "0.004" },
  solana: { perTransaction: "0.2", daily: "0.4", total: "2", approvalAbove: "0.08" },
  hyperliquid: { perTransaction: "25", daily: "50", total: "200", approvalAbove: "10" },
};

/**
 * Network fees. A fee is set partly by the network service Paperclip talks
 * to, so it is never taken on trust: every payment reserves a fee budget up
 * front, the budget counts toward every limit together with the amount, the
 * signer refuses to pay more than the budget, and no fee may ever exceed
 * these hard ceilings (base units) or the payment itself.
 */
export const CRYPTO_NETWORK_FEE_CEILING: Record<CryptoChain, string> = {
  bitcoin: "50000", // 0.0005 BTC
  ethereum: "10000000000000000", // 0.01 ETH
  solana: "100000", // 0.0001 SOL (a plain transfer costs 0.000005)
  hyperliquid: "1000000", // Hyperliquid's fixed 1 USDC withdrawal fee
};

/** Ethereum gas price ceilings (wei per gas): the tip and the total price per gas unit. */
export const EVM_MAX_PRIORITY_FEE_PER_GAS = 5_000_000_000n; // 5 gwei
export const EVM_MAX_FEE_PER_GAS = 200_000_000_000n; // 200 gwei

/**
 * At or below this, a wallet counts as empty (what is left cannot be sent
 * on for less than it costs). A real-money wallet can only be archived, and
 * its key deleted, once its balance is at or below this.
 */
export const CRYPTO_DUST: Record<CryptoChain, string> = {
  bitcoin: "546",
  ethereum: "1000000000000", // 0.000001 ETH
  solana: "10000", // 0.00001 SOL
  hyperliquid: "1000000", // 1 USDC: no more than the withdrawal fee
};

/** Hyperliquid leverage: 1x by default, never above this ceiling. */
export const HYPERLIQUID_DEFAULT_MAX_LEVERAGE = 1;
export const HYPERLIQUID_HARD_MAX_LEVERAGE = 5;

/** How long an approval card for a wallet payment stays answerable. */
export const CRYPTO_TX_APPROVAL_EXPIRY_MS = 60 * 60 * 1000;

/** What a person must type to switch a company to real money. */
export const CRYPTO_MAINNET_CONFIRM_PHRASE = "REAL MONEY";

// ─── Statuses ───────────────────────────────────────────────────────────────

export const CRYPTO_WALLET_STATUSES = ["active", "frozen", "archived"] as const;
export type CryptoWalletStatus = (typeof CRYPTO_WALLET_STATUSES)[number];

export const CRYPTO_TX_KINDS = ["send", "order"] as const;
export type CryptoTxKind = (typeof CRYPTO_TX_KINDS)[number];

export const CRYPTO_TX_STATUSES = [
  "blocked",
  "pending_approval",
  "approved",
  "submitted",
  "confirmed",
  "failed",
  "rejected",
  "expired_approval",
] as const;
export type CryptoTxStatus = (typeof CRYPTO_TX_STATUSES)[number];

/** Statuses whose amount counts toward the daily and total limits (pending ones reserve their share). */
export const CRYPTO_TX_COUNTING_STATUSES: readonly CryptoTxStatus[] = ["pending_approval", "approved", "submitted", "confirmed"];

export function describeCryptoTxStatus(status: CryptoTxStatus): string {
  switch (status) {
    case "blocked":
      return "Stopped by a safety rule";
    case "pending_approval":
      return "Waiting for a person to approve";
    case "approved":
      return "Approved, about to be sent";
    case "submitted":
      return "Sent, waiting for the network to confirm";
    case "confirmed":
      return "Confirmed by the network";
    case "failed":
      return "Failed";
    case "rejected":
      return "Turned down";
    case "expired_approval":
      return "Nobody approved it in time, so it was not sent";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

// ─── Address format checks (offline, format only) ──────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_BECH32_MAINNET_RE = /^bc1[02-9ac-hj-np-z]{6,87}$/;
const BTC_BECH32_TESTNET_RE = /^tb1[02-9ac-hj-np-z]{6,87}$/;

/**
 * A quick format check for forms. The server checks the address again
 * properly (checksums) before it is ever saved or used. Bitcoin: only the
 * modern "bc1"/"tb1" addresses, which is what these wallets use and send to.
 */
export function looksLikeCryptoAddress(chain: CryptoChain, network: CryptoNetwork, address: string): boolean {
  const value = address.trim();
  switch (chain) {
    case "bitcoin":
      return network === "mainnet" ? BTC_BECH32_MAINNET_RE.test(value.toLowerCase()) : BTC_BECH32_TESTNET_RE.test(value.toLowerCase());
    case "ethereum":
    case "hyperliquid":
      return EVM_ADDRESS_RE.test(value);
    case "solana":
      return SOLANA_ADDRESS_RE.test(value);
    default: {
      const exhaustive: never = chain;
      return exhaustive;
    }
  }
}

// ─── API shapes ─────────────────────────────────────────────────────────────

/** What every API returns about a wallet. Never carries key material or the secret's id. */
export interface CryptoWalletSummary {
  id: string;
  companyId: string;
  agentId: string | null;
  chain: CryptoChain;
  network: CryptoNetwork;
  /** Bitcoin test wallets only (null otherwise). Fixed at creation. */
  networkVariant: BitcoinNetworkVariant | null;
  /** Ethereum test wallets only (null otherwise). Fixed at creation. */
  evmChainId: number | null;
  address: string;
  label: string;
  keyOrigin: "generated" | "imported";
  status: CryptoWalletStatus;
  frozenReason: string | null;
  limits: CryptoWalletLimits;
  maxLeverage: number;
  lastBalance: string | null;
  lastBalanceAt: string | null;
  /** 'agent': an agent's tools use it. 'trading_routine': held by Paperclip's trading code, no agent can use it. */
  holder: "agent" | "trading_routine";
  /** Hard limits, sweep and top-up settings; set only on a trading-routine wallet. */
  trading: import("./trading-wallets.js").TradingWalletSettings | null;
  createdAt: string;
  updatedAt: string;
}

export interface CryptoWalletDestination {
  id: string;
  walletId: string;
  address: string;
  label: string;
  createdAt: string;
}

export interface CryptoWalletTransactionSummary {
  id: string;
  walletId: string;
  agentId: string | null;
  initiatedBy: "agent" | "owner" | "routine";
  /** For the trading routine's own transactions: a profit sweep or a trade. */
  routineAction?: "sweep" | "trade" | null;
  kind: CryptoTxKind;
  chain: CryptoChain;
  network: CryptoNetwork;
  asset: string;
  destination: string | null;
  /** Integer base units, as a string. For a Hyperliquid order: its USDC value. */
  amount: string;
  /** Dollar value of the amount plus the network fee budget. */
  amountUsd: number | null;
  /** The most this payment may pay in network fees (base units), counted toward the limits. */
  feeUpperBound: string | null;
  orderDetail: Record<string, unknown> | null;
  purpose: string;
  status: CryptoTxStatus;
  blockReason: string | null;
  approvalId: string | null;
  approvalExpiresAt: string | null;
  txHash: string | null;
  error: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface CompanyCryptoSettings {
  companyId: string;
  mainnetEnabled: boolean;
  mainnetEnabledAt: string | null;
  /** True while the server's administrator has real money locked off (PAPERCLIP_CRYPTO_REAL_MONEY is not 'allowed'). mainnetEnabled is then ignored, not changed. */
  realMoneyLocked: boolean;
  allWalletsFrozen: boolean;
  frozenReason: string | null;
  /** Only the endpoints the company changed; anything missing uses DEFAULT_CRYPTO_RPC_ENDPOINTS. */
  rpcEndpoints: Partial<Record<CryptoChain, Partial<Record<CryptoEndpointSlot, string>>>>;
  /** The one AI Trader agent: may ask for top-ups of trading wallets, can never hold a wallet. null = none named. */
  traderAgentId: string | null;
  /** Only on the answer to turning real money on: how many agents' dollar limits went back to the defaults. */
  agentLimitsReset?: number;
}

export interface CryptoWalletBalance {
  walletId: string;
  balance: string;
  balanceDisplay: string;
  /** Hyperliquid only: what may be withdrawn right now. */
  withdrawable?: string | null;
  checkedAt: string;
  reconciliation: {
    ok: boolean;
    /** Plain sentence, set when something does not add up. */
    note: string | null;
  };
}

// ─── Validators ─────────────────────────────────────────────────────────────

const decimalAmount = z
  .string()
  .trim()
  .regex(DECIMAL_RE, "Write the amount as a plain number, like 0.01.")
  .max(40);

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url("Write a full address starting with https://")
  .refine((value) => value.startsWith("https://"), "The address must start with https://");

export const cryptoWalletLimitsSchema = z
  .object({
    perTransaction: decimalAmount,
    daily: decimalAmount,
    total: decimalAmount,
    approvalAbove: decimalAmount.nullable(),
  })
  .strict();

export const createCryptoWalletSchema = z
  .object({
    agentId: z.string().uuid(),
    chain: z.enum(CRYPTO_CHAINS),
    network: z.enum(CRYPTO_NETWORKS).default("testnet"),
    /** Bitcoin test wallets only; fixed at creation. Left out = DEFAULT_BITCOIN_NETWORK_VARIANT. */
    networkVariant: z.enum(BITCOIN_NETWORK_VARIANTS).optional(),
    /** Ethereum test wallets only, from TEST_EVM_CHAIN_IDS; fixed at creation. Left out = EVM_CHAIN_IDS.testnet. */
    evmChainId: z.number().int().positive().optional(),
    label: z.string().trim().min(1, "Give the wallet a name.").max(120),
    /** "generate": the server makes a brand-new key. "import": paste an existing private key. */
    mode: z.enum(["generate", "import"]),
    /** Only for mode "import". Write-only: never stored outside the secrets store, never echoed back. */
    privateKey: z.string().trim().min(1).max(400).optional(),
    limits: cryptoWalletLimitsSchema.optional(),
  })
  .strict()
  .refine((v) => v.networkVariant === undefined || (v.chain === "bitcoin" && v.network === "testnet"), {
    message: "Only a Bitcoin test wallet has a test network to choose.",
    path: ["networkVariant"],
  })
  .refine((v) => v.evmChainId === undefined || (v.chain === "ethereum" && v.network === "testnet" && isTestEvmChainId(v.evmChainId)), {
    message: "Pick one of the allowed Ethereum test networks for an Ethereum test wallet.",
    path: ["evmChainId"],
  })
  .refine((v) => v.mode === "generate" || (typeof v.privateKey === "string" && v.privateKey.length > 0), {
    message: "Paste the private key to import.",
    path: ["privateKey"],
  })
  .refine((v) => v.mode === "import" || v.privateKey === undefined, {
    message: "A new wallet makes its own key; do not paste one.",
    path: ["privateKey"],
  });
export type CreateCryptoWalletInput = z.infer<typeof createCryptoWalletSchema>;

export const updateCryptoWalletSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    limits: cryptoWalletLimitsSchema.optional(),
    maxLeverage: z.number().int().min(1).max(HYPERLIQUID_HARD_MAX_LEVERAGE).optional(),
    /** Move the wallet to another agent of the same company, or null to take it away from every agent. */
    agentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateCryptoWalletInput = z.infer<typeof updateCryptoWalletSchema>;

export const setCryptoWalletFrozenSchema = z
  .object({
    frozen: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const addCryptoWalletDestinationSchema = z
  .object({
    address: z.string().trim().min(10).max(120),
    label: z.string().trim().min(1, "Say who or what this address belongs to.").max(120),
  })
  .strict();

export const cryptoAgentLimitsSchema = z
  .object({
    perTransactionUsd: z.number().positive().max(CRYPTO_AGENT_HARD_CEILING_USD.perTransaction),
    dailyUsd: z.number().positive().max(CRYPTO_AGENT_HARD_CEILING_USD.daily),
    totalUsd: z.number().positive().max(CRYPTO_AGENT_HARD_CEILING_USD.total),
    approvalAboveUsd: z.number().positive().nullable(),
  })
  .strict();

export const updateCompanyCryptoSettingsSchema = z
  .object({
    /** Turning real money on is owner-only and needs the confirm phrase; turning it off never does. */
    mainnetEnabled: z.boolean().optional(),
    confirmPhrase: z.string().optional(),
    allWalletsFrozen: z.boolean().optional(),
    frozenReason: z.string().trim().max(500).optional(),
    /** Owner-only. The agent named here can never hold a wallet; an agent that holds one cannot be named. */
    traderAgentId: z.string().uuid().nullable().optional(),
    rpcEndpoints: z
      .record(z.enum(CRYPTO_CHAINS), z.record(z.enum(CRYPTO_ENDPOINT_SLOTS), httpsUrl.nullable()))
      .optional(),
  })
  .strict();
export type UpdateCompanyCryptoSettingsInput = z.infer<typeof updateCompanyCryptoSettingsSchema>;

/** An agent's (or an owner's) request to send coins to an allow-listed address. */
export const cryptoSendRequestSchema = z
  .object({
    to: z.string().trim().min(10).max(120),
    amount: decimalAmount,
    /** One sentence: what the money is for. Shown on the approval card. */
    purpose: z.string().trim().min(3, "Say what the payment is for.").max(500),
  })
  .strict();
export type CryptoSendRequest = z.infer<typeof cryptoSendRequestSchema>;

export const hyperliquidOrderRequestSchema = z
  .object({
    coin: z.string().trim().regex(/^[A-Z0-9]{1,15}$/, "Use the coin's ticker, like BTC."),
    side: z.enum(["buy", "sell"]),
    size: decimalAmount,
    limitPrice: decimalAmount,
    reduceOnly: z.boolean().optional().default(false),
    purpose: z.string().trim().min(3).max(500),
  })
  .strict();
export type HyperliquidOrderRequest = z.infer<typeof hyperliquidOrderRequestSchema>;

export const cryptoQuoteRequestSchema = z
  .object({
    to: z.string().trim().min(10).max(120).optional(),
    amount: decimalAmount.optional(),
    coin: z.string().trim().regex(/^[A-Z0-9]{1,15}$/).optional(),
  })
  .strict();
export type CryptoQuoteRequest = z.infer<typeof cryptoQuoteRequestSchema>;

// ─── Plain-English risk wording (UI) ───────────────────────────────────────

export const CRYPTO_RISK_EXPLANATIONS = {
  overview:
    "A crypto wallet holds real coins once it is on the main network. Payments cannot be undone: if coins go to the wrong address, they are gone.",
  keys:
    "Paperclip keeps the wallet's secret key locked in the company's encrypted secrets store. Nobody can read it back, not you and not the agent. The server signs payments; the agent can only ask.",
  testnet:
    "New wallets use a test network. Test coins are free and have no value, so you can try everything safely first.",
  mainnet:
    "Turning on the main network means agents can move real money, within the limits you set. Start with small amounts.",
  limits:
    "Limits cap how much one payment, one day and the wallet's whole life may spend, network fees included. Agent limits (in dollars) apply on top, across all the agent's wallets.",
  allowList:
    "An agent can only send to addresses you have put on this wallet's allowed list. Anything else is refused.",
  approval:
    "Payments at or above the approval amount wait for a person to approve them on an approval card. If nobody answers within an hour, nothing is sent.",
  fees:
    "Every payment also pays a small network fee. Paperclip sets aside the most it may cost, counts that toward the limits, caps it, and never pays more than the payment itself is worth.",
  killSwitch:
    "Freezing stops every new payment at once. Payments already sent to the network cannot be called back.",
  import:
    "Importing a key that is also used somewhere else is risky: anyone else with that key can still spend the coins. Paperclip freezes the wallet if coins leave it that it did not send.",
  hyperliquid:
    "Hyperliquid trades use leverage, which can lose more than the order size. Leverage is capped at 1x by default; withdrawals only go to allowed addresses.",
  recovery:
    "To get coins back out, add your own address to the allowed list and use \"Send funds\" here. The key itself is never shown.",
} as const;
