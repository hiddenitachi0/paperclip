import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companyCryptoSettings,
  cryptoAgentLimits,
  cryptoWalletDestinations,
  cryptoWallets,
  cryptoWalletTransactions,
  tradingLedgerEntries,
  withCompanyScope,
} from "@paperclipai/db";
import {
  CRYPTO_CHAIN_INFO,
  CRYPTO_DUST,
  CRYPTO_MAINNET_CONFIRM_PHRASE,
  CRYPTO_NETWORK_FEE_CEILING,
  CRYPTO_TX_APPROVAL_EXPIRY_MS,
  CRYPTO_TX_COUNTING_STATUSES,
  DEFAULT_CRYPTO_AGENT_LIMITS,
  DEFAULT_BITCOIN_NETWORK_VARIANT,
  DEFAULT_CRYPTO_WALLET_LIMITS,
  DEFAULT_TRADING_WALLET_LIMITS,
  HYPERLIQUID_DEFAULT_MAX_LEVERAGE,
  EVM_CHAIN_IDS,
  cryptoEndpointSlot,
  cryptoNetworkLabel,
  defaultCryptoRpcEndpoint,
  formatChainAmount,
  formatCryptoAmount,
  isTestEvmChainId,
  parseCryptoAmount,
  type BitcoinNetworkVariant,
  type CompanyCryptoSettings,
  type CreateCryptoWalletInput,
  type CreateTradingWalletInput,
  type CryptoAgentLimits,
  type CryptoChain,
  type CryptoEndpointSlot,
  type CryptoNetwork,
  type CryptoQuoteRequest,
  type CryptoSendRequest,
  type CryptoTxStatus,
  type CryptoWalletBalance,
  type CryptoWalletDestination,
  type CryptoWalletLimits,
  type CryptoWalletStatus,
  type CryptoWalletSummary,
  type CryptoWalletTransactionSummary,
  type HyperliquidOrderRequest,
  type TradingAlertKind,
  type TradingLedgerEventType,
  type TradingWalletLimitInput,
  type TradingWalletSettings,
  type UpdateCompanyCryptoSettingsInput,
  type UpdateCryptoWalletInput,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCryptoKeyImportAllowed, assertCryptoRealMoneyAllowed, CRYPTO_REAL_MONEY_LOCK_MESSAGE, isCryptoRealMoneyAllowed } from "./crypto-real-money-lock.js";
import {
  CryptoChainError,
  defaultCryptoChainAdapters,
  type ChainContext,
  type BroadcastResult,
  type TxStatusCheck,
  type CryptoChainAdapter,
  type CryptoChainAdapters,
  type SignedTransfer,
} from "./crypto-wallet-chains.js";
import { evaluateHyperliquidLeverage, evaluateWalletSpend } from "./crypto-wallet-policy.js";
import {
  evaluateBalanceBreach,
  evaluateDailyLoss,
  evaluateRoutineTrade,
  parseTradingLimits,
  sweepAmount,
  topUpNeeded,
  TradingLimitsError,
  utcDayKey,
} from "./trading-wallet-policy.js";
import { tradingAlertsService, type TradingAlertSink } from "./trading-alerts.js";
import { createCryptoRpcOutboundPolicy, createSafeOutboundFetch, SafeOutboundFetchError, type OutboundFetch } from "./safe-outbound-fetch.js";
import { secretService } from "./secrets.js";
import { ccxtTradingMarketData, isTradingMarketDataError, type TradingMarketDataSource } from "./trading-market-data.js";

/**
 * Crypto wallets for agents (see packages/shared/src/crypto-wallets.ts for
 * the design). This service is the only code that ever asks for a wallet's
 * key, and only at the moment of signing, after every check has passed:
 *
 *   company kill switch -> wallet frozen/archived -> real money allowed ->
 *   destination on the allow-list -> limits (wallet, agent) -> approval card
 *   above the threshold -> resolve key -> check it still derives the
 *   wallet's address -> sign -> record tx hash -> broadcast.
 *
 * The key string lives in a local variable for the duration of one signing
 * call. It is never returned, logged, written to the ledger, or included in
 * an error. Every outcome -- including blocked attempts -- is written to
 * crypto_wallet_transactions and to the trading ledger.
 */

export type CryptoWalletRow = typeof cryptoWallets.$inferSelect;
export type CryptoWalletTxRow = typeof cryptoWalletTransactions.$inferSelect;

export interface CryptoPriceSource {
  /** US dollars per one whole coin of this chain's asset, or null when unavailable. */
  usdPrice(chain: CryptoChain): Promise<number | null>;
}

const PRICE_TTL_MS = 60_000;

/** Prices from the trading agent's public market data (no credentials). Hyperliquid's USDC counts as $1. */
export function defaultCryptoPriceSource(marketData: TradingMarketDataSource = ccxtTradingMarketData()): CryptoPriceSource {
  const cache = new Map<CryptoChain, { at: number; price: number }>();
  const symbol: Record<Exclude<CryptoChain, "hyperliquid">, "BTC" | "ETH" | "SOL"> = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL" };
  return {
    async usdPrice(chain) {
      if (chain === "hyperliquid") return 1;
      const hit = cache.get(chain);
      if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
      const quote = await marketData.fetchQuote(symbol[chain], new Date());
      if (isTradingMarketDataError(quote)) return null;
      const price = (quote.bidUsd + quote.askUsd) / 2;
      if (!Number.isFinite(price) || price <= 0) return null;
      cache.set(chain, { at: Date.now(), price });
      return price;
    },
  };
}

type SecretsForWallets = Pick<ReturnType<typeof secretService>, "createManagedLocalSecret" | "resolveSecretValueForWalletSigning">;

export interface CryptoWalletServiceDeps {
  now?: () => Date;
  adapters?: CryptoChainAdapters;
  priceSource?: CryptoPriceSource;
  /** Builds the outbound fetch for one endpoint. Default: the safe outbound fetch pinned to that endpoint's host. */
  fetchFor?: (endpointUrl: string) => OutboundFetch;
  secrets?: SecretsForWallets;
  /** Where the trading routine queues its Telegram alerts. Default: the trading_alerts outbox. */
  alerts?: TradingAlertSink;
  /** How often the tick looks at each trading wallet's balance (the hard stops, sweep, top-up). Default 5 minutes. */
  tradingWatchIntervalMs?: number;
}

export interface CryptoActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
}

/** An unclear send is re-sent (the same signed bytes, never a new payment) at most this often. */
const REBROADCAST_INTERVAL_MS = 5 * 60_000;
/** A payment reserves its estimated network fee times this, capped by CRYPTO_NETWORK_FEE_CEILING, as its fee budget. */
const FEE_BUDGET_NUMERATOR = 3n;
const FEE_BUDGET_DENOMINATOR = 2n;
const APPROVED_WITHOUT_HASH_GIVE_UP_MS = 10 * 60_000;
const RECONCILE_WINDOW_MS = 60 * 60_000;
const TICK_BATCH = 25;

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function bigOrNull(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function toLimits(row: CryptoWalletRow): CryptoWalletLimits {
  const decimals = CRYPTO_CHAIN_INFO[row.chain as CryptoChain].decimals;
  return {
    perTransaction: formatCryptoAmount(row.perTransactionLimit, decimals),
    daily: formatCryptoAmount(row.dailyLimit, decimals),
    total: formatCryptoAmount(row.totalLimit, decimals),
    approvalAbove: row.approvalAbove === null ? null : formatCryptoAmount(row.approvalAbove, decimals),
  };
}

function toTradingSettings(row: CryptoWalletRow): TradingWalletSettings | null {
  if (row.holder !== "trading_routine") return null;
  const decimals = CRYPTO_CHAIN_INFO[row.chain as CryptoChain].decimals;
  const fmt = (value: string | null) => (value === null ? null : formatCryptoAmount(value, decimals));
  return {
    maxBalance: formatCryptoAmount(row.maxBalance ?? "0", decimals),
    dailyLossStop: formatCryptoAmount(row.dailyLossStop ?? "0", decimals),
    sweepThreshold: fmt(row.sweepThreshold),
    topUpFloor: fmt(row.topUpFloor),
    topUpTarget: fmt(row.topUpTarget),
    sweepAddress: row.sweepAddress,
    sweepAddressApprovedAt: row.sweepAddressApprovedAt?.toISOString() ?? null,
    pendingSweepAddress: row.pendingSweepAddress,
  };
}

/** The only shape a wallet ever leaves this service in. No key, no secret id. */
export function toWalletSummary(row: CryptoWalletRow): CryptoWalletSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    chain: row.chain as CryptoChain,
    network: row.network as CryptoNetwork,
    networkVariant: (row.networkVariant as BitcoinNetworkVariant | null) ?? null,
    evmChainId: row.evmChainId ?? null,
    address: row.address,
    label: row.label,
    keyOrigin: row.keyOrigin as "generated" | "imported",
    status: row.status as CryptoWalletStatus,
    frozenReason: row.frozenReason,
    limits: toLimits(row),
    maxLeverage: row.maxLeverage,
    lastBalance: row.lastBalance,
    lastBalanceAt: row.lastBalanceAt?.toISOString() ?? null,
    holder: row.holder as "agent" | "trading_routine",
    trading: toTradingSettings(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTxSummary(row: CryptoWalletTxRow): CryptoWalletTransactionSummary {
  return {
    id: row.id,
    walletId: row.walletId,
    agentId: row.agentId,
    initiatedBy: row.initiatedBy as "agent" | "owner" | "routine",
    routineAction: (row.routineAction as "sweep" | "trade" | null) ?? null,
    kind: row.kind as "send" | "order",
    chain: row.chain as CryptoChain,
    network: row.network as CryptoNetwork,
    asset: row.asset,
    destination: row.destination,
    amount: row.amount,
    amountUsd: row.amountUsd,
    feeUpperBound: row.feeUpperBound,
    orderDetail: (row.orderDetail as Record<string, unknown> | null) ?? null,
    purpose: row.purpose,
    status: row.status as CryptoTxStatus,
    blockReason: row.blockReason,
    approvalId: row.approvalId,
    approvalExpiresAt: row.approvalExpiresAt?.toISOString() ?? null,
    txHash: row.txHash,
    error: row.error,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function limitsToBaseUnits(chain: CryptoChain, limits: CryptoWalletLimits) {
  const decimals = CRYPTO_CHAIN_INFO[chain].decimals;
  const parse = (value: string, field: string) => {
    const parsed = parseCryptoAmount(value, decimals);
    if (parsed === null) throw unprocessable(`The ${field} limit is not a valid ${CRYPTO_CHAIN_INFO[chain].asset} amount (at most ${decimals} decimals).`);
    return parsed;
  };
  const perTransaction = parse(limits.perTransaction, "per-payment");
  const daily = parse(limits.daily, "daily");
  const total = parse(limits.total, "total");
  const approvalAbove = limits.approvalAbove === null ? null : parse(limits.approvalAbove, "approval");
  if (perTransaction > daily || daily > total) {
    throw unprocessable("The limits must go up: per payment no more than per day, and per day no more than in total.");
  }
  return {
    perTransactionLimit: perTransaction.toString(),
    dailyLimit: daily.toString(),
    totalLimit: total.toString(),
    approvalAbove: approvalAbove === null ? null : approvalAbove.toString(),
  };
}

/** A plain error for the caller. Never carries a key: only our own sentences. */
function chainFailure(err: unknown): string {
  if (err instanceof CryptoChainError) return err.message;
  if (err instanceof SafeOutboundFetchError) return `Could not reach the network service: ${err.message}`;
  if (err instanceof HttpError) return err.message;
  return "Something went wrong while talking to the network. Nothing more is known.";
}

export function cryptoWalletService(db: Db, rawDb: Db = db, deps: CryptoWalletServiceDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const adapters = deps.adapters ?? defaultCryptoChainAdapters();
  const priceSource = deps.priceSource ?? defaultCryptoPriceSource();
  const secrets: SecretsForWallets = deps.secrets ?? secretService(db, rawDb);
  const fetchFor = deps.fetchFor ?? ((url: string) => createSafeOutboundFetch(createCryptoRpcOutboundPolicy(url)));

  function adapterFor(chain: CryptoChain): CryptoChainAdapter {
    return adapters[chain];
  }

  // ─── Ledger ────────────────────────────────────────────────────────────

  async function writeLedger(params: {
    companyId: string;
    walletId: string;
    eventType: TradingLedgerEventType;
    tx?: CryptoWalletTxRow | null;
    txHash?: string | null;
    txStatus?: string | null;
    detail?: Record<string, unknown>;
  }) {
    await db.insert(tradingLedgerEntries).values({
      companyId: params.companyId,
      strategyId: null,
      walletId: params.walletId,
      walletTransactionId: params.tx?.id ?? null,
      txHash: params.txHash ?? params.tx?.txHash ?? null,
      txStatus: params.txStatus ?? params.tx?.status ?? null,
      eventType: params.eventType,
      nokValue: null,
      detail: params.detail ?? null,
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async function settingsRow(companyId: string) {
    const [row] = await db.select().from(companyCryptoSettings).where(eq(companyCryptoSettings.companyId, companyId));
    return row ?? null;
  }

  async function getSettings(companyId: string): Promise<CompanyCryptoSettings> {
    const row = await settingsRow(companyId);
    return {
      companyId,
      // The stored value, untouched: lifting the server lock later restores
      // exactly what the owner had chosen. realMoneyLocked is what decides.
      mainnetEnabled: row?.mainnetEnabled ?? false,
      mainnetEnabledAt: row?.mainnetEnabledAt?.toISOString() ?? null,
      realMoneyLocked: !isCryptoRealMoneyAllowed(),
      allWalletsFrozen: row?.allWalletsFrozen ?? false,
      frozenReason: row?.frozenReason ?? null,
      rpcEndpoints: (row?.rpcEndpoints as CompanyCryptoSettings["rpcEndpoints"]) ?? {},
      traderAgentId: row?.traderAgentId ?? null,
    };
  }

  async function updateSettings(
    companyId: string,
    input: UpdateCompanyCryptoSettingsInput,
    actor: { userId: string; isOwner: boolean },
  ): Promise<CompanyCryptoSettings & { agentLimitsReset?: number }> {
    const current = await getSettings(companyId);
    const now = nowOf();
    const patch: Partial<typeof companyCryptoSettings.$inferInsert> = { updatedAt: now };
    let turningMainnetOn = false;

    if (input.mainnetEnabled === true && !current.mainnetEnabled) {
      // The server lock comes first: not even an owner who types the phrase gets past it.
      assertCryptoRealMoneyAllowed();
      if (!actor.isOwner) throw forbidden("Only the company's owner can turn on real money for crypto wallets.");
      if ((input.confirmPhrase ?? "").trim() !== CRYPTO_MAINNET_CONFIRM_PHRASE) {
        throw unprocessable(`To turn on real money, type ${CRYPTO_MAINNET_CONFIRM_PHRASE} to confirm.`);
      }
      patch.mainnetEnabled = true;
      patch.mainnetEnabledAt = now;
      patch.mainnetEnabledByUserId = actor.userId;
      turningMainnetOn = true;
    } else if (input.mainnetEnabled === false) {
      patch.mainnetEnabled = false;
    }

    if (input.allWalletsFrozen !== undefined) {
      // Anyone allowed here may pull the brake; while real money is on, only
      // the owner may release it.
      if (input.allWalletsFrozen === false && current.allWalletsFrozen && (current.mainnetEnabled || turningMainnetOn) && !actor.isOwner) {
        throw forbidden("Real money is on for this company, so only the owner can unfreeze all wallets.");
      }
      patch.allWalletsFrozen = input.allWalletsFrozen;
      patch.frozenReason = input.allWalletsFrozen ? (input.frozenReason?.trim() || "Frozen by an owner or admin.") : null;
    }

    if (input.traderAgentId !== undefined) {
      if (!actor.isOwner) throw forbidden("Only the company's owner can name the Trader agent.");
      if (input.traderAgentId !== null) {
        await requireAgent(companyId, input.traderAgentId);
        // The Trader never holds a wallet: no agent that owns one can be named.
        const [holds] = await db
          .select({ id: cryptoWallets.id })
          .from(cryptoWallets)
          .where(and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.agentId, input.traderAgentId)))
          .limit(1);
        if (holds) throw unprocessable("That agent holds a wallet, so it cannot be the Trader. Take the wallet away from it first.");
      }
      patch.traderAgentId = input.traderAgentId;
    }

    if (input.rpcEndpoints) {
      // Which network service a wallet talks to decides which network it
      // really signs on, so this is the owner's call, like real money.
      if (!actor.isOwner) throw forbidden("Only the company's owner can change the crypto network addresses.");
      const merged: CompanyCryptoSettings["rpcEndpoints"] = JSON.parse(JSON.stringify(current.rpcEndpoints));
      for (const [chain, slots] of Object.entries(input.rpcEndpoints) as Array<[CryptoChain, Partial<Record<CryptoEndpointSlot, string | null>>]>) {
        for (const [slot, url] of Object.entries(slots ?? {}) as Array<[CryptoEndpointSlot, string | null]>) {
          if (defaultCryptoRpcEndpoint(chain, slot) === undefined) {
            throw unprocessable("Only Bitcoin has a signet network address.");
          }
          const forChain = (merged[chain] ??= {});
          if (url === null) {
            delete forChain[slot];
          } else {
            try {
              createCryptoRpcOutboundPolicy(url);
            } catch (err) {
              throw unprocessable(err instanceof Error ? err.message : "That network address is not allowed.");
            }
            forChain[slot] = url;
          }
        }
      }
      patch.rpcEndpoints = merged;
    }

    await db
      .insert(companyCryptoSettings)
      .values({ companyId, ...patch })
      .onConflictDoUpdate({ target: companyCryptoSettings.companyId, set: patch });

    // Agent dollar limits set while real money was off were never the
    // owner's real-money decision: turning real money on puts every agent
    // back on the safe defaults, which the owner can then raise on purpose.
    let agentLimitsReset: number | undefined;
    if (turningMainnetOn) {
      const removed = await db.delete(cryptoAgentLimits).where(eq(cryptoAgentLimits.companyId, companyId)).returning({ id: cryptoAgentLimits.id });
      agentLimitsReset = removed.length;
    }

    if (input.allWalletsFrozen !== undefined && input.allWalletsFrozen !== current.allWalletsFrozen) {
      const wallets = await db.select({ id: cryptoWallets.id }).from(cryptoWallets).where(eq(cryptoWallets.companyId, companyId));
      for (const wallet of wallets) {
        await writeLedger({
          companyId,
          walletId: wallet.id,
          eventType: "wallet_kill_switch",
          detail: { scope: "company", action: input.allWalletsFrozen ? "freeze" : "unfreeze", byUserId: actor.userId },
        });
      }
    }
    const settings = await getSettings(companyId);
    return agentLimitsReset === undefined ? settings : { ...settings, agentLimitsReset };
  }

  /** The company's own address for this wallet's slot (chain x network x variant), else the built-in one. */
  function endpointFor(settings: CompanyCryptoSettings, chain: CryptoChain, network: CryptoNetwork, networkVariant?: BitcoinNetworkVariant | null): string {
    const slot = cryptoEndpointSlot(chain, network, networkVariant);
    return settings.rpcEndpoints?.[chain]?.[slot] ?? defaultCryptoRpcEndpoint(chain, slot)!;
  }

  /**
   * What a chain adapter needs for one wallet. The network, Bitcoin variant
   * and Ethereum chain ID come from the wallet's stored (fixed) values, never
   * from a code default, so changing a default moves no existing wallet.
   */
  async function chainContext(
    companyId: string,
    chain: CryptoChain,
    wallet: Pick<CryptoWalletRow, "network" | "networkVariant" | "evmChainId">,
  ): Promise<ChainContext> {
    const settings = await getSettings(companyId);
    const network = wallet.network as CryptoNetwork;
    const networkVariant = (wallet.networkVariant as BitcoinNetworkVariant | null) ?? undefined;
    const rpcUrl = endpointFor(settings, chain, network, networkVariant);
    return { network, networkVariant, chainId: wallet.evmChainId ?? undefined, rpcUrl, fetch: fetchFor(rpcUrl) };
  }

  // ─── Wallets ───────────────────────────────────────────────────────────

  async function requireWalletRow(companyId: string, walletId: string): Promise<CryptoWalletRow> {
    const [row] = await db.select().from(cryptoWallets).where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId)));
    if (!row) throw notFound("Wallet not found.");
    return row;
  }

  async function requireAgent(companyId: string, agentId: string) {
    const [agent] = await db.select({ id: agents.id, name: agents.name, companyId: agents.companyId }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw notFound("Agent not found in this company.");
    return agent;
  }

  async function listWallets(companyId: string, filter: { agentId?: string } = {}): Promise<CryptoWalletSummary[]> {
    const rows = await db
      .select()
      .from(cryptoWallets)
      .where(filter.agentId ? and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.agentId, filter.agentId)) : eq(cryptoWallets.companyId, companyId))
      .orderBy(asc(cryptoWallets.createdAt));
    return rows.map(toWalletSummary);
  }

  async function createWallet(companyId: string, input: CreateCryptoWalletInput, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    if (input.network === "mainnet") assertCryptoRealMoneyAllowed();
    if (input.mode === "import") assertCryptoKeyImportAllowed();
    const agent = await requireAgent(companyId, input.agentId);
    const settings = await getSettings(companyId);
    if (settings.traderAgentId === agent.id) {
      throw unprocessable("This agent is the Trader. The Trader never holds a wallet: trading wallets are held by Paperclip's own trading code.");
    }
    if (input.network === "mainnet" && !settings.mainnetEnabled) {
      throw forbidden("Real money is switched off for this company. The owner can turn it on in the crypto settings; until then, use the test network.");
    }
    if (input.network === "mainnet" && input.limits !== undefined && !actor.isOwner) {
      throw forbidden("Only the company's owner can set limits on a real-money wallet. Leave the limits out to start with the safe defaults.");
    }
    // New test wallets ask a person for every agent send (approvalAbove
    // empty); explicit limits and the real-money defaults are unchanged.
    const defaultLimits: CryptoWalletLimits =
      input.network === "mainnet" ? DEFAULT_CRYPTO_WALLET_LIMITS[input.chain] : { ...DEFAULT_CRYPTO_WALLET_LIMITS[input.chain], approvalAbove: null };
    const limits = limitsToBaseUnits(input.chain, input.limits ?? defaultLimits);
    const adapter = adapterFor(input.chain);

    // Fixed for the wallet's whole life (a database trigger refuses any later
    // change). The defaults below apply to NEW wallets only.
    const testnet = input.network === "testnet";
    const networkVariant: BitcoinNetworkVariant | null =
      input.chain === "bitcoin" && testnet ? (input.networkVariant ?? DEFAULT_BITCOIN_NETWORK_VARIANT) : null;
    const evmChainId: number | null = input.chain === "ethereum" && testnet ? (input.evmChainId ?? EVM_CHAIN_IDS.testnet) : null;
    if (evmChainId !== null && !isTestEvmChainId(evmChainId)) {
      throw unprocessable("That Ethereum network is not an allowed test network.");
    }

    let material: { privateKey: string; address: string };
    try {
      material = input.mode === "generate" ? await adapter.generateKey(input.network) : await adapter.importKey(input.privateKey ?? "", input.network);
    } catch (err) {
      throw unprocessable(err instanceof CryptoChainError ? err.message : "Could not read that key.");
    }

    const [duplicate] = await db
      .select({ id: cryptoWallets.id })
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.chain, input.chain), eq(cryptoWallets.network, input.network), eq(cryptoWallets.address, material.address)));
    if (duplicate) throw conflict("This company already has a wallet with that key.");

    // One key, one network: the same key (or the address it makes) must never
    // back both a test wallet and a real-money wallet. EVM and Solana keys make
    // the same address on both networks; a bitcoin key makes a tb1 and a bc1
    // address, so the other network's address is derived from the key.
    const otherNetwork: CryptoNetwork = input.network === "mainnet" ? "testnet" : "mainnet";
    const sameKeyFamily = input.chain === "bitcoin" || input.chain === "solana" ? [input.chain] : ["ethereum", "hyperliquid"];
    let otherAddress: string;
    try {
      otherAddress = await adapter.deriveAddress(material.privateKey, otherNetwork);
    } catch {
      throw unprocessable("Could not read that key.");
    }
    const onOtherNetwork = await db
      .select({ address: cryptoWallets.address })
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.network, otherNetwork), inArray(cryptoWallets.chain, sameKeyFamily)));
    const reused = (address: string) => (sameKeyFamily.length > 1 ? address.toLowerCase() : address);
    if (onOtherNetwork.some((w) => reused(w.address) === reused(otherAddress) || reused(w.address) === reused(material.address))) {
      throw conflict("That key or address is already used by a wallet on the other network (test and real-money wallets must never share a key). Use a new wallet.");
    }

    const info = CRYPTO_CHAIN_INFO[input.chain];
    const shortAddress = `${material.address.slice(0, 8)}…${material.address.slice(-6)}`;
    const suffix = Math.random().toString(36).slice(2, 8);
    const secret = await secrets.createManagedLocalSecret(
      companyId,
      {
        name: `${info.label} wallet key: ${input.label} (${shortAddress}, ${suffix})`,
        key: `crypto_wallet_${input.chain}_${input.network}_${suffix}`,
        value: material.privateKey,
        description: `The secret key of ${agent.name}'s ${info.label} wallet ${material.address} (${cryptoNetworkLabel(input.chain, input.network, { networkVariant, evmChainId })}). Only the server uses it, to sign payments. It cannot be shown or copied out.`,
        kind: "crypto_wallet_key",
      },
      { userId: actor.userId },
    );
    // Drop our reference to the key as soon as it is stored.
    material = { privateKey: "", address: material.address };

    const now = nowOf();
    const [row] = await db
      .insert(cryptoWallets)
      .values({
        companyId,
        agentId: agent.id,
        chain: input.chain,
        network: input.network,
        networkVariant,
        evmChainId,
        address: material.address,
        secretId: secret.id,
        keyOrigin: input.mode === "generate" ? "generated" : "imported",
        label: input.label,
        status: "active",
        ...limits,
        maxLeverage: HYPERLIQUID_DEFAULT_MAX_LEVERAGE,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await writeLedger({
      companyId,
      walletId: row!.id,
      eventType: "wallet_created",
      detail: { chain: input.chain, network: input.network, networkVariant, evmChainId, address: row!.address, keyOrigin: row!.keyOrigin, agentId: agent.id, byUserId: actor.userId },
    });
    return toWalletSummary(row!);
  }

  /** Real-money wallets: anything that widens what can leave (limits, allow-list, owner send, leverage, who uses it) is the owner's call. */
  function assertOwnerForRealMoney(wallet: CryptoWalletRow, actor: { isOwner: boolean }, what: string) {
    if (wallet.network === "mainnet" && !actor.isOwner) {
      throw forbidden(`Only the company's owner can ${what} on a real-money wallet.`);
    }
  }

  /**
   * A code-held trading wallet's money paths (who it can send to, owner send,
   * leverage) are the owner's alone, on any network (DUR-5087 N1): a company
   * admin who could add their own address and send the balance would bypass
   * the sweep-to-cold-wallet design with no approval card.
   */
  function assertOwnerForRoutineWallet(wallet: CryptoWalletRow, actor: { isOwner: boolean }, what: string) {
    if (wallet.holder === "trading_routine" && !actor.isOwner) {
      throw forbidden(`Only the company's owner can ${what} on a trading wallet.`);
    }
  }

  async function updateWallet(companyId: string, walletId: string, input: UpdateCryptoWalletInput, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    const row = await requireWalletRow(companyId, walletId);
    if (row.holder === "trading_routine") {
      // A code-held wallet is never handed to an agent, and its limits have
      // their own owner-only route (they include the hard stops).
      if (input.agentId !== undefined && input.agentId !== null) {
        throw unprocessable("A trading wallet is held by Paperclip's trading code and can never be given to an agent.");
      }
      if (input.limits !== undefined) throw unprocessable("Change a trading wallet's limits on its trading limits screen.");
      if (input.maxLeverage !== undefined) assertOwnerForRoutineWallet(row, actor, "change leverage");
    }
    if (input.limits !== undefined || input.maxLeverage !== undefined || input.agentId !== undefined) {
      assertOwnerForRealMoney(row, actor, "change limits, leverage or which agent uses it");
    }
    const chain = row.chain as CryptoChain;
    const patch: Partial<typeof cryptoWallets.$inferInsert> = { updatedAt: nowOf() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.limits !== undefined) Object.assign(patch, limitsToBaseUnits(chain, input.limits));
    if (input.maxLeverage !== undefined) {
      if (chain !== "hyperliquid") throw unprocessable("Leverage only applies to Hyperliquid wallets.");
      patch.maxLeverage = input.maxLeverage;
    }
    if (input.agentId !== undefined) {
      if (input.agentId !== null) {
        await requireAgent(companyId, input.agentId);
        if ((await getSettings(companyId)).traderAgentId === input.agentId) {
          throw unprocessable("That agent is the Trader. The Trader never holds a wallet.");
        }
      }
      patch.agentId = input.agentId;
    }
    const [updated] = await db.update(cryptoWallets).set(patch).where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId))).returning();
    await writeLedger({
      companyId,
      walletId,
      eventType: "wallet_settings_changed",
      detail: {
        byUserId: actor.userId,
        changed: Object.keys(input),
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.maxLeverage !== undefined ? { maxLeverage: input.maxLeverage } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      },
    });
    return toWalletSummary(updated!);
  }

  async function setFrozen(
    companyId: string,
    walletId: string,
    frozen: boolean,
    reason: string | undefined,
    actor: CryptoActor & { isOwner: boolean },
  ): Promise<CryptoWalletSummary> {
    const row = await requireWalletRow(companyId, walletId);
    if (row.status === "archived") throw unprocessable("This wallet is archived.");
    // Freezing is always allowed; unfreezing a real-money wallet (perhaps
    // frozen because coins left it that Paperclip did not send) is the owner's call.
    if (!frozen && row.status === "frozen" && row.network === "mainnet" && !actor.isOwner) {
      throw forbidden("Only the company's owner can unfreeze a real-money wallet.");
    }
    // Starting a paused trading wallet again is the owner's decision, not an admin's.
    if (!frozen && row.status === "frozen" && row.holder === "trading_routine" && !actor.isOwner) {
      throw forbidden("Only the company's owner can start a paused trading wallet again.");
    }
    const now = nowOf();
    const [updated] = await db
      .update(cryptoWallets)
      .set(
        frozen
          ? { status: "frozen", frozenReason: reason?.trim() || "Frozen by an owner or admin.", frozenAt: now, updatedAt: now }
          : // The daily loss count starts again from the balance as it is (see evaluateDailyLoss).
            { status: "active", frozenReason: null, frozenAt: null, lossDay: null, lossDayPeak: null, updatedAt: now },
      )
      .where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId)))
      .returning();
    await writeLedger({ companyId, walletId, eventType: "wallet_kill_switch", detail: { scope: "wallet", action: frozen ? "freeze" : "unfreeze", reason: reason ?? null, by: actor } });
    return toWalletSummary(updated!);
  }

  async function archiveWallet(companyId: string, walletId: string, actor: { userId: string }): Promise<CryptoWalletSummary> {
    const row = await requireWalletRow(companyId, walletId);
    if (row.status === "archived") return toWalletSummary(row);
    if (row.status !== "frozen") throw unprocessable("Freeze the wallet first, then archive it.");
    const [inFlight] = await db
      .select({ id: cryptoWalletTransactions.id })
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.walletId, walletId), inArray(cryptoWalletTransactions.status, ["pending_approval", "approved", "submitted"])))
      .limit(1);
    if (inFlight) throw unprocessable("This wallet still has a payment on its way or waiting for approval. Wait until it settles, then archive.");
    if (row.network === "mainnet") {
      // Archiving is final and lets the key be deleted later, so a
      // real-money wallet must be empty -- checked on the network now, not
      // from an old reading.
      const fresh = await refreshBalance(companyId, walletId);
      if (BigInt(fresh.balance) > BigInt(CRYPTO_DUST[row.chain as CryptoChain])) {
        throw unprocessable(
          `This wallet still holds ${fresh.balanceDisplay}. Send the coins out first (add your own address to the allowed list and use Send funds), then archive it.`,
        );
      }
    }
    const now = nowOf();
    const [updated] = await db
      .update(cryptoWallets)
      .set({ status: "archived", agentId: null, updatedAt: now })
      .where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId)))
      .returning();
    await writeLedger({ companyId, walletId, eventType: "wallet_settings_changed", detail: { action: "archive", byUserId: actor.userId } });
    return toWalletSummary(updated!);
  }

  // ─── Allow-list ────────────────────────────────────────────────────────

  async function listDestinations(companyId: string, walletId: string): Promise<CryptoWalletDestination[]> {
    await requireWalletRow(companyId, walletId);
    const rows = await db
      .select()
      .from(cryptoWalletDestinations)
      .where(and(eq(cryptoWalletDestinations.companyId, companyId), eq(cryptoWalletDestinations.walletId, walletId)))
      .orderBy(asc(cryptoWalletDestinations.createdAt));
    return rows.map((r) => ({ id: r.id, walletId: r.walletId, address: r.address, label: r.label, createdAt: r.createdAt.toISOString() }));
  }

  async function addDestination(
    companyId: string,
    walletId: string,
    input: { address: string; label: string },
    actor: { userId: string; isOwner: boolean },
  ): Promise<CryptoWalletDestination> {
    const wallet = await requireWalletRow(companyId, walletId);
    assertOwnerForRealMoney(wallet, actor, "add an allowed address");
    assertOwnerForRoutineWallet(wallet, actor, "add an allowed address");
    const chain = wallet.chain as CryptoChain;
    let normalized: string | null;
    try {
      normalized = await adapterFor(chain).validateAddress(input.address, wallet.network as CryptoNetwork);
    } catch (err) {
      throw unprocessable(chainFailure(err));
    }
    if (!normalized) {
      throw unprocessable(`That is not a valid ${CRYPTO_CHAIN_INFO[chain].label} address for the ${wallet.network === "mainnet" ? "main" : "test"} network. Check it letter by letter.`);
    }
    if (normalized === wallet.address) throw unprocessable("A wallet cannot send to itself.");
    const [existing] = await db
      .select({ id: cryptoWalletDestinations.id })
      .from(cryptoWalletDestinations)
      .where(and(eq(cryptoWalletDestinations.walletId, walletId), eq(cryptoWalletDestinations.address, normalized)));
    if (existing) throw conflict("That address is already on the allowed list.");
    const [row] = await db
      .insert(cryptoWalletDestinations)
      .values({ companyId, walletId, address: normalized, label: input.label, createdByUserId: actor.userId })
      .returning();
    await writeLedger({ companyId, walletId, eventType: "wallet_settings_changed", detail: { action: "allow_list_add", address: normalized, label: input.label, byUserId: actor.userId } });
    return { id: row!.id, walletId, address: row!.address, label: row!.label, createdAt: row!.createdAt.toISOString() };
  }

  async function removeDestination(companyId: string, walletId: string, destinationId: string, actor: { userId: string; isOwner: boolean }): Promise<void> {
    const wallet = await requireWalletRow(companyId, walletId);
    assertOwnerForRoutineWallet(wallet, actor, "remove an allowed address");
    const [removed] = await db
      .delete(cryptoWalletDestinations)
      .where(and(eq(cryptoWalletDestinations.id, destinationId), eq(cryptoWalletDestinations.walletId, walletId), eq(cryptoWalletDestinations.companyId, companyId)))
      .returning();
    if (!removed) throw notFound("Address not found on the allowed list.");
    await writeLedger({ companyId, walletId, eventType: "wallet_settings_changed", detail: { action: "allow_list_remove", address: removed.address, byUserId: actor.userId } });
  }

  // ─── Agent limits ──────────────────────────────────────────────────────

  async function getAgentLimits(companyId: string, agentId: string): Promise<CryptoAgentLimits> {
    const [row] = await db.select().from(cryptoAgentLimits).where(and(eq(cryptoAgentLimits.companyId, companyId), eq(cryptoAgentLimits.agentId, agentId)));
    if (!row) return { ...DEFAULT_CRYPTO_AGENT_LIMITS };
    return { perTransactionUsd: row.perTransactionUsd, dailyUsd: row.dailyUsd, totalUsd: row.totalUsd, approvalAboveUsd: row.approvalAboveUsd };
  }

  async function setAgentLimits(companyId: string, agentId: string, input: CryptoAgentLimits, actor: { userId: string; isOwner: boolean }): Promise<CryptoAgentLimits> {
    await requireAgent(companyId, agentId);
    if ((await getSettings(companyId)).mainnetEnabled && !actor.isOwner) {
      throw forbidden("Real money is on for this company, so only the owner can change an agent's crypto limits.");
    }
    if (input.perTransactionUsd > input.dailyUsd || input.dailyUsd > input.totalUsd) {
      throw unprocessable("The limits must go up: per payment no more than per day, and per day no more than in total.");
    }
    const now = nowOf();
    await db
      .insert(cryptoAgentLimits)
      .values({ companyId, agentId, ...input, updatedByUserId: actor.userId, updatedAt: now })
      .onConflictDoUpdate({ target: cryptoAgentLimits.agentId, set: { ...input, updatedByUserId: actor.userId, updatedAt: now } });
    return getAgentLimits(companyId, agentId);
  }

  // ─── Transactions and ledger (read) ────────────────────────────────────

  async function listTransactions(companyId: string, walletId: string, limit = 100): Promise<CryptoWalletTransactionSummary[]> {
    await requireWalletRow(companyId, walletId);
    const rows = await db
      .select()
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.companyId, companyId), eq(cryptoWalletTransactions.walletId, walletId)))
      .orderBy(desc(cryptoWalletTransactions.createdAt))
      .limit(limit);
    return rows.map(toTxSummary);
  }

  async function listLedger(companyId: string, walletId: string, limit = 200) {
    await requireWalletRow(companyId, walletId);
    return db
      .select()
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.companyId, companyId), eq(tradingLedgerEntries.walletId, walletId)))
      .orderBy(desc(tradingLedgerEntries.createdAt))
      .limit(limit);
  }

  // ─── Balance and reconciliation ────────────────────────────────────────

  /**
   * Reads a wallet's balance from the network and reconciles it. A trading
   * wallet is always read through watchTradingWallet, so no caller (the
   * owner's balance screen, the Trader's top-up request) can refresh the
   * reading without the daily-loss and max-balance stops being applied to
   * it: a refresh stamps lastBalanceAt, and the scheduler skips a wallet it
   * saw recently (DUR-5087 N2).
   */
  async function refreshBalance(companyId: string, walletId: string): Promise<CryptoWalletBalance> {
    const wallet = await requireWalletRow(companyId, walletId);
    if (wallet.holder === "trading_routine" && wallet.status !== "archived") {
      return (await watchTradingWallet(wallet, nowOf())).fresh;
    }
    return readBalance(companyId, walletId);
  }

  async function readBalance(companyId: string, walletId: string): Promise<CryptoWalletBalance> {
    const wallet = await requireWalletRow(companyId, walletId);
    const chain = wallet.chain as CryptoChain;
    const ctx = await chainContext(companyId, chain, wallet);
    let result: { balance: bigint; withdrawable?: bigint };
    try {
      result = await adapterFor(chain).getBalance(ctx, wallet.address);
    } catch (err) {
      throw new HttpError(502, chainFailure(err));
    }
    const now = nowOf();

    // Reconciliation: did coins leave this wallet that Paperclip did not
    // send? Compare the drop since the last check with everything this
    // wallet sent (amount + highest possible fee) in that window. More
    // leaving than that means someone else has the key: freeze at once.
    // Hyperliquid balances move with trading profit and loss, so only
    // recorded there, never used to freeze.
    let note: string | null = null;
    let ok = true;
    const previous = bigOrNull(wallet.lastBalance);
    if (previous !== null && wallet.lastBalanceAt && chain !== "hyperliquid") {
      const since = new Date(wallet.lastBalanceAt.getTime() - RECONCILE_WINDOW_MS);
      const [sent] = await db
        .select({
          // Sent payments (amount + highest fee), and the fee a reverted
          // payment still paid -- both really left the wallet.
          total: sql<string>`coalesce(sum(${costSql}), 0)::text`,
        })
        .from(cryptoWalletTransactions)
        .where(
          and(
            eq(cryptoWalletTransactions.walletId, walletId),
            isNotNull(cryptoWalletTransactions.txHash),
            or(inArray(cryptoWalletTransactions.status, ["approved", "submitted", "confirmed"]), stillCostsSql),
            sql`${cryptoWalletTransactions.status} <> 'pending_approval'`,
            gte(cryptoWalletTransactions.updatedAt, since),
          ),
        );
      const explained = BigInt(String(sent?.total ?? "0").split(".")[0]!);
      const drop = previous - result.balance;
      if (drop > explained) {
        ok = false;
        const unexplained = drop - explained;
        note = `${formatChainAmount(chain, unexplained)} left this wallet that Paperclip did not send. The wallet has been frozen: someone else may have its key.`;
        if (wallet.status === "active") {
          await db
            .update(cryptoWallets)
            .set({ status: "frozen", frozenReason: note, frozenAt: now, updatedAt: now })
            .where(eq(cryptoWallets.id, walletId));
          await writeLedger({ companyId, walletId, eventType: "wallet_kill_switch", detail: { scope: "wallet", action: "freeze", reason: "unexplained_outflow", by: { actorType: "system", actorId: "reconciliation" } } });
          // The owner is told at the moment of the freeze, whoever asked for this reading.
          if (wallet.holder === "trading_routine") {
            await queueAlert(wallet, "wallet_paused", `Safety stop: the trading wallet "${wallet.label}" was paused. ${note}`);
          }
        }
        logger.warn({ companyId, walletId, chain }, "crypto wallet: unexplained outflow, wallet frozen");
      }
    }

    await db.update(cryptoWallets).set({ lastBalance: result.balance.toString(), lastBalanceAt: now }).where(eq(cryptoWallets.id, walletId));
    await writeLedger({
      companyId,
      walletId,
      eventType: "wallet_reconciliation",
      detail: { balance: result.balance.toString(), previousBalance: previous?.toString() ?? null, ok, note },
    });
    return {
      walletId,
      balance: result.balance.toString(),
      balanceDisplay: formatChainAmount(chain, result.balance),
      withdrawable: result.withdrawable !== undefined ? result.withdrawable.toString() : null,
      checkedAt: now.toISOString(),
      reconciliation: { ok, note },
    };
  }

  // ─── Gate checks shared by every money-moving path ─────────────────────

  async function assertSwitchesAllow(wallet: CryptoWalletRow): Promise<string | null> {
    // Checked on every request and never written to the wallet row: lifting
    // the server lock needs no clean-up, because nothing was changed.
    if (wallet.network === "mainnet" && !isCryptoRealMoneyAllowed()) return CRYPTO_REAL_MONEY_LOCK_MESSAGE;
    const settings = await getSettings(wallet.companyId);
    if (settings.allWalletsFrozen) return `All crypto wallets in this company are frozen${settings.frozenReason ? `: ${settings.frozenReason}` : "."}`;
    if (wallet.status === "frozen") return `This wallet is frozen${wallet.frozenReason ? `: ${wallet.frozenReason}` : "."}`;
    if (wallet.status === "archived") return "This wallet is archived and can no longer be used.";
    if (wallet.network === "mainnet" && !settings.mainnetEnabled) {
      return "Real money is switched off for this company, so this main-network wallet cannot be used.";
    }
    return null;
  }

  async function allowListed(wallet: CryptoWalletRow, rawAddress: string): Promise<string | null> {
    let normalized: string | null;
    try {
      normalized = await adapterFor(wallet.chain as CryptoChain).validateAddress(rawAddress, wallet.network as CryptoNetwork);
    } catch {
      normalized = null;
    }
    if (!normalized) return null;
    const [hit] = await db
      .select({ address: cryptoWalletDestinations.address })
      .from(cryptoWalletDestinations)
      .where(and(eq(cryptoWalletDestinations.walletId, wallet.id), eq(cryptoWalletDestinations.address, normalized)));
    return hit?.address ?? null;
  }

  /**
   * What a transaction still costs the wallet, for the limits: amount + fee
   * budget while it may still go through, and just the fee actually paid
   * when it was mined but rejected by the receiver ("reverted": recorded in
   * chain_detail.feePaid). Everything else counts nothing.
   */
  const COUNTING_SQL = sql.raw(CRYPTO_TX_COUNTING_STATUSES.map((st) => `'${st}'`).join(", "));
  const costSql = sql`case when ${cryptoWalletTransactions.status} in (${COUNTING_SQL}) then ${cryptoWalletTransactions.amount} + coalesce(${cryptoWalletTransactions.feeUpperBound}, 0) when ${cryptoWalletTransactions.status} = 'failed' then coalesce((${cryptoWalletTransactions.chainDetail} ->> 'feePaid')::numeric, 0) else 0 end`;
  const costUsdSql = sql`case when ${cryptoWalletTransactions.status} in (${COUNTING_SQL}) then coalesce(${cryptoWalletTransactions.amountUsd}, 0) when ${cryptoWalletTransactions.status} = 'failed' then coalesce((${cryptoWalletTransactions.chainDetail} ->> 'feePaidUsd')::float8, 0) else 0 end`;
  const stillCostsSql = sql`(${cryptoWalletTransactions.status} in (${COUNTING_SQL}) or (${cryptoWalletTransactions.status} = 'failed' and (${cryptoWalletTransactions.chainDetail} ->> 'feePaid') is not null))`;

  async function spentSoFar(tx: Pick<Db, "select">, wallet: CryptoWalletRow, agentId: string | null, now: Date) {
    const dayStartIso = utcDayStart(now).toISOString();
    const walletBase = and(eq(cryptoWalletTransactions.walletId, wallet.id), eq(cryptoWalletTransactions.countsTowardLimits, true), stillCostsSql);
    const agentBase = and(
      agentId === null ? sql`false` : eq(cryptoWalletTransactions.agentId, agentId),
      eq(cryptoWalletTransactions.companyId, wallet.companyId),
      eq(cryptoWalletTransactions.countsTowardLimits, true),
      stillCostsSql,
    );
    const [walletRow] = await tx
      .select({
        today: sql<string>`coalesce(sum(case when ${cryptoWalletTransactions.createdAt} >= ${dayStartIso}::timestamptz then ${costSql} else 0 end), 0)::text`,
        total: sql<string>`coalesce(sum(${costSql}), 0)::text`,
      })
      .from(cryptoWalletTransactions)
      .where(walletBase);
    const [agentRow] = await tx
      .select({
        today: sql<number>`coalesce(sum(case when ${cryptoWalletTransactions.createdAt} >= ${dayStartIso}::timestamptz then ${costUsdSql} else 0 end), 0)::float8`,
        total: sql<number>`coalesce(sum(${costUsdSql}), 0)::float8`,
      })
      .from(cryptoWalletTransactions)
      .where(agentBase);
    return {
      walletToday: BigInt(String(walletRow?.today ?? "0").split(".")[0]!),
      walletTotal: BigInt(String(walletRow?.total ?? "0").split(".")[0]!),
      agentTodayUsd: Number(agentRow?.today ?? 0),
      agentTotalUsd: Number(agentRow?.total ?? 0),
    };
  }

  function amountUsdOf(chain: CryptoChain, amount: bigint, price: number | null): number | null {
    if (price === null) return null;
    return Number(formatCryptoAmount(amount, CRYPTO_CHAIN_INFO[chain].decimals)) * price;
  }

  async function fileApprovalCard(wallet: CryptoWalletRow, tx: CryptoWalletTxRow, agentName: string, reasonForOperator: string, destinationLabel: string | null): Promise<string> {
    const chain = wallet.chain as CryptoChain;
    const realMoney = wallet.network === "mainnet";
    const what =
      tx.kind === "order"
        ? `place a Hyperliquid order: ${String((tx.orderDetail as Record<string, unknown> | null)?.side ?? "")} ${String((tx.orderDetail as Record<string, unknown> | null)?.size ?? "")} ${String((tx.orderDetail as Record<string, unknown> | null)?.coin ?? "")} (about $${(tx.amountUsd ?? 0).toFixed(2)})`
        : `send ${formatChainAmount(chain, tx.amount)} to ${destinationLabel ? `${destinationLabel} (${tx.destination})` : tx.destination}${
            tx.feeUpperBound && BigInt(tx.feeUpperBound) > 0n ? `, plus a network fee of at most ${formatChainAmount(chain, tx.feeUpperBound)}` : ""
          }`;
    const expiresAt = tx.approvalExpiresAt ?? new Date(nowOf().getTime() + CRYPTO_TX_APPROVAL_EXPIRY_MS);
    const isSweep = tx.routineAction === "sweep";
    const networkLabel = cryptoNetworkLabel(chain, wallet.network as CryptoNetwork, wallet);
    const summary = `${agentName} wants to ${what} from the wallet "${wallet.label}". Network: ${networkLabel}. Reason given: "${tx.purpose}". ${reasonForOperator} ${
      realMoney ? "This is REAL money and cannot be undone." : "Test coins: no real value."
    }`;
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId: wallet.companyId,
        type: "request_board_approval",
        requestedByAgentId: tx.agentId,
        requestedByUserId: null,
        status: "pending",
        payload: {
          kind: "crypto_wallet_tx",
          walletId: wallet.id,
          transactionId: tx.id,
          chain,
          network: wallet.network,
          networkLabel,
          destination: tx.destination,
          destinationLabel,
          // 'sweep' makes the approvals route ask for the owner, not any admin.
          ...(isSweep ? { routineAction: "sweep" } : {}),
          title: isSweep
            ? `${realMoney ? "Real money: " : "Test coins: "}sweep trading profit to your cold wallet`
            : `${realMoney ? "Real money: " : "Test coins: "}${agentName} wants to ${tx.kind === "order" ? "trade" : "pay"} from a crypto wallet`,
          summary,
          plainSummary: `${summary} If nobody answers within an hour, nothing is sent.`,
          expiresAt: expiresAt.toISOString(),
        },
      })
      .returning({ id: approvals.id });
    return approval!.id;
  }

  // ─── Sending ───────────────────────────────────────────────────────────

  /**
   * Signs and broadcasts one already-approved transaction. The caller must
   * have claimed the row (status 'approved') so nobody else sends it too.
   *
   * Once a transaction is signed, its bytes and hash are saved BEFORE the
   * first send. From then on the payment stays counted ("submitted") unless
   * the network gives a definite answer that it did not happen; any unclear
   * answer is settled later by checkOnNetwork, which only ever re-sends
   * those same saved bytes -- never a newly signed payment.
   */
  async function executeApproved(txRow: CryptoWalletTxRow, actor: CryptoActor): Promise<CryptoWalletTxRow> {
    const wallet = await requireWalletRow(txRow.companyId, txRow.walletId);
    const chain = wallet.chain as CryptoChain;
    const adapter = adapterFor(chain);
    const now = nowOf();

    // Everything is checked again at the moment of sending: a switch or the
    // allow-list may have changed while the approval card was open.
    const switchRefusal = await assertSwitchesAllow(wallet);
    const destinationOk = txRow.kind === "order" || (txRow.destination !== null && (await allowListed(wallet, txRow.destination)) !== null);
    // A profit sweep goes only to the cold-wallet address as it is NOW: if the owner changed it while the card was open, nothing is sent.
    const sweepRefusal =
      txRow.routineAction === "sweep" && (wallet.sweepAddress === null || txRow.destination !== wallet.sweepAddress)
        ? "The cold-wallet address changed (or was removed) while this sweep waited, so nothing was sent."
        : null;
    if (switchRefusal || sweepRefusal || !destinationOk) {
      const reason = switchRefusal ?? sweepRefusal ?? "The address is no longer on this wallet's allowed list.";
      return finish(txRow, { status: "blocked", blockReason: reason }, "wallet_tx_blocked", { reason });
    }

    const ctx = await chainContext(wallet.companyId, chain, wallet);
    let privateKey = "";
    let signed: SignedTransfer;
    try {
      privateKey = await secrets.resolveSecretValueForWalletSigning(wallet.companyId, wallet.secretId, {
        walletId: wallet.id,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      // Make sure the stored key still belongs to this wallet. If not,
      // something changed it: freeze rather than sign with it.
      const derived = await adapter.deriveAddress(privateKey, wallet.network as CryptoNetwork);
      if (derived !== wallet.address) {
        privateKey = "";
        await db.update(cryptoWallets).set({ status: "frozen", frozenReason: "The stored key no longer matches this wallet's address.", frozenAt: now, updatedAt: now }).where(eq(cryptoWallets.id, wallet.id));
        await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_kill_switch", detail: { scope: "wallet", action: "freeze", reason: "key_mismatch" } });
        return finish(txRow, { status: "failed", error: "The wallet's stored key does not match its address, so the wallet was frozen. Nothing was sent." }, "wallet_tx_failed", { reason: "key_mismatch" });
      }

      if (txRow.kind === "order") {
        const detail = (txRow.orderDetail ?? {}) as Record<string, unknown>;
        const prepared = await adapters.hyperliquid.signOrder(ctx, {
          privateKey,
          coin: String(detail.coin),
          isBuy: detail.side === "buy",
          size: String(detail.size),
          limitPrice: String(detail.limitPrice),
          reduceOnly: detail.reduceOnly === true,
          leverage: wallet.maxLeverage,
        });
        privateKey = "";
        // The leverage cap goes first. If that does not clearly succeed, the
        // order is never sent at all -- so failing here is always safe.
        await adapters.hyperliquid.applyLeverage(ctx, prepared.leverageRaw);
        signed = prepared.order;
      } else {
        const maxFee = BigInt(txRow.feeUpperBound ?? "0");
        signed = await adapter.signTransfer(ctx, { privateKey, from: wallet.address, to: txRow.destination!, amount: BigInt(txRow.amount), maxFee });
        privateKey = "";
      }
    } catch (err) {
      // Nothing has been sent at this point.
      privateKey = "";
      logger.warn({ walletId: wallet.id, txId: txRow.id, code: err instanceof CryptoChainError ? err.code : err instanceof Error ? err.name : "unknown" }, "crypto wallet: signing failed, nothing sent");
      return finish(txRow, { status: "failed", error: `Nothing was sent. ${chainFailure(err)}` }, "wallet_tx_failed", { reason: chainFailure(err), stage: "before_send" });
    }

    // Record the signed bytes and hash before sending, so a crash or an
    // unclear answer can be traced on the network instead of sent twice.
    const [withHash] = await db
      .update(cryptoWalletTransactions)
      .set({
        status: "submitted",
        txHash: signed.txHash,
        signedRaw: signed.raw,
        chainDetail: { ...(signed.chainDetail ?? {}), from: wallet.address, signedAt: now.toISOString() },
        // Never more than the budget the limits were checked against.
        feeUpperBound: signed.feeUpperBound.toString(),
        submittedAt: now,
        lastBroadcastAt: now,
        updatedAt: nowOf(),
      })
      .where(eq(cryptoWalletTransactions.id, txRow.id))
      .returning();
    return sendSigned(withHash!, ctx, signed, true);
  }

  /** One send of the saved signed bytes; see executeApproved for the rules. */
  async function sendSigned(row: CryptoWalletTxRow, ctx: ChainContext, signed: SignedTransfer, firstSend: boolean): Promise<CryptoWalletTxRow> {
    const now = nowOf();
    let result: BroadcastResult;
    try {
      result = await adapterFor(row.chain as CryptoChain).broadcast(ctx, signed);
    } catch (err) {
      const note = `No clear answer from the network (${chainFailure(err)}). It may still go through, so it keeps counting toward the limits; Paperclip keeps checking and only ever re-sends this same payment.`;
      if (firstSend) {
        return finish(row, { status: "submitted", error: note, lastBroadcastAt: now }, "wallet_tx_submitted", { unclear: true });
      }
      const [updated] = await db.update(cryptoWalletTransactions).set({ lastBroadcastAt: now, error: note, updatedAt: now }).where(eq(cryptoWalletTransactions.id, row.id)).returning();
      return updated ?? row;
    }
    const withDetail = (patch: Partial<typeof cryptoWalletTransactions.$inferInsert>) =>
      row.kind === "order" && result.detail ? { ...patch, orderDetail: { ...((row.orderDetail as Record<string, unknown>) ?? {}), resultDetail: result.detail } } : patch;
    if (result.status === "confirmed") {
      return finish(row, withDetail({ status: "confirmed", confirmedAt: now, error: null, lastBroadcastAt: now }), "wallet_tx_confirmed", { detail: result.detail ?? null });
    }
    if (result.status === "failed") {
      if (!firstSend) {
        // A refusal of a RE-send says nothing certain about the first send.
        const [updated] = await db.update(cryptoWalletTransactions).set({ lastBroadcastAt: now, updatedAt: now }).where(eq(cryptoWalletTransactions.id, row.id)).returning();
        return updated ?? row;
      }
      return finish(row, withDetail({ status: "failed", error: result.detail ?? "The network refused it. Nothing was sent." }), "wallet_tx_failed", { reason: result.detail ?? null });
    }
    if (firstSend) return finish(row, { status: "submitted", error: null, lastBroadcastAt: now }, "wallet_tx_submitted", {});
    const [updated] = await db.update(cryptoWalletTransactions).set({ lastBroadcastAt: now, updatedAt: now }).where(eq(cryptoWalletTransactions.id, row.id)).returning();
    return updated ?? row;
  }

  async function finish(
    txRow: CryptoWalletTxRow,
    patch: Partial<typeof cryptoWalletTransactions.$inferInsert>,
    eventType: TradingLedgerEventType,
    detail: Record<string, unknown>,
  ): Promise<CryptoWalletTxRow> {
    const [updated] = await db
      .update(cryptoWalletTransactions)
      .set({ ...patch, updatedAt: nowOf() })
      .where(eq(cryptoWalletTransactions.id, txRow.id))
      .returning();
    await writeLedger({ companyId: txRow.companyId, walletId: txRow.walletId, eventType, tx: updated!, detail });
    if (updated!.routineAction === "sweep" && ["confirmed", "failed", "blocked"].includes(updated!.status)) {
      await alertSweepOutcome(updated!);
    }
    return updated!;
  }

  /** Agent-facing: the agent may only touch wallets assigned to it, in its own company. */
  async function requireAgentWallet(companyId: string, agentId: string, walletId: string): Promise<CryptoWalletRow> {
    const [row] = await db
      .select()
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.agentId, agentId)));
    if (!row) throw notFound("Wallet not found. You can only use wallets that belong to you.");
    return row;
  }

  interface SpendRequest {
    wallet: CryptoWalletRow;
    agentId: string | null;
    initiatedBy: "agent" | "owner" | "routine";
    initiatedByUserId: string | null;
    kind: "send" | "order";
    destination: string | null;
    destinationLabel: string | null;
    amount: bigint;
    /** Network fee budget, base units (0 for Hyperliquid orders). Counted with the amount everywhere. */
    fee: bigint;
    /** Dollar value of amount + fee. */
    amountUsd: number | null;
    countsTowardLimits: boolean;
    orderDetail: Record<string, unknown> | null;
    purpose: string;
    preBlockReason: string | null;
    actor: CryptoActor;
    /** Trading routine only: what it was doing. */
    routineAction?: "sweep" | "trade";
    /** A plain sentence: when set, this spend always waits for a person's approval card. */
    forceApproval?: string;
  }

  /** Records the attempt, runs the gate under a lock, and either blocks, files a card, or sends. */
  async function processSpend(req: SpendRequest): Promise<CryptoWalletTransactionSummary> {
    const { wallet } = req;
    if (wallet.network === "mainnet") assertCryptoRealMoneyAllowed();
    const chain = wallet.chain as CryptoChain;
    const now = nowOf();
    const base = {
      companyId: wallet.companyId,
      walletId: wallet.id,
      agentId: req.agentId,
      initiatedBy: req.initiatedBy,
      initiatedByUserId: req.initiatedByUserId,
      kind: req.kind,
      chain,
      network: wallet.network,
      asset: CRYPTO_CHAIN_INFO[chain].asset,
      destination: req.destination,
      amount: req.amount.toString(),
      amountUsd: req.amountUsd,
      feeUpperBound: req.fee > 0n ? req.fee.toString() : null,
      countsTowardLimits: req.countsTowardLimits,
      orderDetail: req.orderDetail,
      purpose: req.purpose,
      routineAction: req.routineAction ?? null,
      createdAt: now,
      updatedAt: now,
    };

    if (req.preBlockReason) {
      const [blocked] = await db.insert(cryptoWalletTransactions).values({ ...base, status: "blocked", blockReason: req.preBlockReason }).returning();
      await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_tx_blocked", tx: blocked!, detail: { reason: req.preBlockReason } });
      return toTxSummary(blocked!);
    }

    // The limit check and the insert happen under one lock per agent (or
    // per wallet for owner sends), so two requests at once cannot both
    // squeeze under the same limit.
    const decided = await withCompanyScope(rawDb, wallet.companyId, async (tx) => {
      const lockKey = req.agentId ? `crypto_wallet_agent:${req.agentId}` : `crypto_wallet:${wallet.id}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      let verdict: ReturnType<typeof evaluateWalletSpend>;
      if (req.fee > req.amount) {
        verdict = { kind: "block", reason: `The network fee could be up to ${formatChainAmount(chain, req.fee)}, more than the payment itself. Nothing was sent.` };
      } else if (req.forceApproval) {
        verdict = { kind: "needs_approval", reasonForOperator: req.forceApproval };
      } else if (req.initiatedBy === "owner" || !req.countsTowardLimits) {
        // Owner sends, sweeps and reduce-only orders: no spending limit applies (an exit is never blocked).
        verdict = { kind: "allow" };
      } else if (req.initiatedBy === "routine") {
        // The trading routine's own trades: the wallet's hard caps, no agent limits, no approval card.
        const spent = await spentSoFar(tx as unknown as Db, wallet, null, now);
        verdict = evaluateRoutineTrade({
          amount: req.amount,
          perTrade: BigInt(wallet.perTransactionLimit),
          daily: BigInt(wallet.dailyLimit),
          total: BigInt(wallet.totalLimit),
          spentToday: spent.walletToday,
          spentTotal: spent.walletTotal,
          formatAmount: (v) => formatChainAmount(chain, v),
        });
      } else {
        const spent = await spentSoFar(tx as unknown as Db, wallet, req.agentId!, now);
        const agentLimits = await getAgentLimits(wallet.companyId, req.agentId!);
        verdict = evaluateWalletSpend({
          amount: req.amount,
          fee: req.fee,
          amountUsd: req.amountUsd,
          assetLabel: CRYPTO_CHAIN_INFO[chain].asset,
          formatAmount: (v) => formatChainAmount(chain, v),
          wallet: {
            perTransactionLimit: BigInt(wallet.perTransactionLimit),
            dailyLimit: BigInt(wallet.dailyLimit),
            totalLimit: BigInt(wallet.totalLimit),
            approvalAbove: bigOrNull(wallet.approvalAbove),
            spentToday: spent.walletToday,
            spentTotal: spent.walletTotal,
          },
          agent: { ...agentLimits, spentTodayUsd: spent.agentTodayUsd, spentTotalUsd: spent.agentTotalUsd },
        });
      }
      const status: CryptoTxStatus = verdict.kind === "block" ? "blocked" : verdict.kind === "needs_approval" ? "pending_approval" : "approved";
      const [row] = await tx
        .insert(cryptoWalletTransactions)
        .values({
          ...base,
          status,
          blockReason: verdict.kind === "block" ? verdict.reason : null,
          approvalExpiresAt: verdict.kind === "needs_approval" ? new Date(now.getTime() + CRYPTO_TX_APPROVAL_EXPIRY_MS) : null,
        })
        .returning();
      return { row: row!, verdict };
    });

    const { row, verdict } = decided;
    if (verdict.kind === "block") {
      await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_tx_blocked", tx: row, detail: { reason: verdict.reason } });
      return toTxSummary(row);
    }
    await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_tx_requested", tx: row, detail: { initiatedBy: req.initiatedBy } });

    if (verdict.kind === "needs_approval") {
      const agentName = req.agentId ? (await requireAgent(wallet.companyId, req.agentId)).name : req.initiatedBy === "routine" ? "The trading routine" : "Someone";
      const approvalId = await fileApprovalCard(wallet, row, agentName, verdict.reasonForOperator, req.destinationLabel);
      const [withCard] = await db.update(cryptoWalletTransactions).set({ approvalId, updatedAt: nowOf() }).where(eq(cryptoWalletTransactions.id, row.id)).returning();
      await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_tx_approval_requested", tx: withCard!, detail: { approvalId, reason: verdict.reasonForOperator } });
      return toTxSummary(withCard!);
    }

    return toTxSummary(await executeApproved(row, req.actor));
  }

  /**
   * The fee budget a payment reserves: the network's current estimate
   * (already capped by the adapter) with headroom, never above the chain's
   * hard ceiling. The signer refuses to pay more than this.
   */
  async function feeBudget(wallet: CryptoWalletRow, to: string, amount: bigint): Promise<{ fee: bigint } | { refusal: string }> {
    const chain = wallet.chain as CryptoChain;
    const ceiling = BigInt(CRYPTO_NETWORK_FEE_CEILING[chain]);
    try {
      const ctx = await chainContext(wallet.companyId, chain, wallet);
      const estimate = await adapterFor(chain).estimateFee(ctx, { from: wallet.address, to, amount });
      if (estimate < 0n || estimate > ceiling) return { refusal: "The network fee is above Paperclip's ceiling right now. Nothing was sent; try again later." };
      const padded = (estimate * FEE_BUDGET_NUMERATOR + FEE_BUDGET_DENOMINATOR - 1n) / FEE_BUDGET_DENOMINATOR;
      return { fee: padded > ceiling ? ceiling : padded };
    } catch (err) {
      return { refusal: `Could not work out the network fee, so nothing was sent. ${chainFailure(err)}` };
    }
  }

  async function prepareSend(wallet: CryptoWalletRow, input: CryptoSendRequest) {
    if (wallet.network === "mainnet") assertCryptoRealMoneyAllowed();
    const chain = wallet.chain as CryptoChain;
    const decimals = CRYPTO_CHAIN_INFO[chain].decimals;
    const amount = parseCryptoAmount(input.amount, decimals);
    if (amount === null) {
      throw unprocessable(`That is not a valid ${CRYPTO_CHAIN_INFO[chain].asset} amount (at most ${decimals} decimals).`);
    }
    const switchRefusal = await assertSwitchesAllow(wallet);
    const destination = await allowListed(wallet, input.to);
    let destinationLabel: string | null = null;
    if (destination) {
      const [dest] = await db
        .select({ label: cryptoWalletDestinations.label })
        .from(cryptoWalletDestinations)
        .where(and(eq(cryptoWalletDestinations.walletId, wallet.id), eq(cryptoWalletDestinations.address, destination)));
      destinationLabel = dest?.label ?? null;
    }
    let preBlockReason =
      switchRefusal ??
      (destination ? null : "That address is not on this wallet's allowed list. Only an owner or admin can add addresses to it.");
    let fee = 0n;
    if (!preBlockReason && destination) {
      const budget = await feeBudget(wallet, destination, amount);
      if ("refusal" in budget) preBlockReason = budget.refusal;
      else fee = budget.fee;
    }
    const price = await priceSource.usdPrice(chain).catch(() => null);
    return { amount, fee, destination: destination ?? input.to.trim(), destinationLabel, preBlockReason, amountUsd: amountUsdOf(chain, amount + fee, price) };
  }

  // ─── Agent-facing operations ───────────────────────────────────────────

  async function agentListWallets(companyId: string, agentId: string): Promise<CryptoWalletSummary[]> {
    const rows = await db
      .select()
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.agentId, agentId)))
      .orderBy(asc(cryptoWallets.createdAt));
    return rows.filter((r) => r.status !== "archived").map(toWalletSummary);
  }

  async function agentBalance(companyId: string, agentId: string, walletId: string): Promise<CryptoWalletBalance> {
    await requireAgentWallet(companyId, agentId, walletId);
    return refreshBalance(companyId, walletId);
  }

  async function agentDestinations(companyId: string, agentId: string, walletId: string) {
    await requireAgentWallet(companyId, agentId, walletId);
    return listDestinations(companyId, walletId);
  }

  async function agentSend(companyId: string, agentId: string, walletId: string, input: CryptoSendRequest): Promise<CryptoWalletTransactionSummary> {
    // On Hyperliquid a "send" is a USDC withdrawal; the allow-list rule is the same.
    const wallet = await requireAgentWallet(companyId, agentId, walletId);
    const prepared = await prepareSend(wallet, input);
    return processSpend({
      wallet,
      agentId,
      initiatedBy: "agent",
      initiatedByUserId: null,
      kind: "send",
      destination: prepared.destination,
      destinationLabel: prepared.destinationLabel,
      amount: prepared.amount,
      fee: prepared.fee,
      amountUsd: prepared.amountUsd,
      countsTowardLimits: true,
      orderDetail: null,
      purpose: input.purpose,
      preBlockReason: prepared.preBlockReason,
      actor: { actorType: "agent", actorId: agentId },
    });
  }

  /** Sizes an order and runs every pre-check (switches, price sanity, leverage cap). Shared by the agent path and the trading routine. */
  async function prepareHyperliquidOrder(wallet: CryptoWalletRow, input: HyperliquidOrderRequest) {
    const companyId = wallet.companyId;
    const size = Number(input.size);
    const price = Number(input.limitPrice);
    if (!(size > 0) || !(price > 0)) throw unprocessable("Size and price must be more than zero.");
    const notionalUsd = size * price;
    const amount = parseCryptoAmount(notionalUsd.toFixed(6), 6) ?? 0n;

    let preBlockReason = await assertSwitchesAllow(wallet);
    if (!preBlockReason) {
      const ctx = await chainContext(companyId, "hyperliquid", wallet);
      try {
        const [state, mid] = await Promise.all([
          adapters.hyperliquid.accountState(ctx, wallet.address),
          adapters.hyperliquid.midPrice(ctx, input.coin),
        ]);
        if (mid === null) {
          preBlockReason = `Hyperliquid has no current price for ${input.coin}.`;
        } else if (Math.abs(price - mid) / mid > 0.1) {
          preBlockReason = `The limit price is more than 10% away from the current price (${mid}). Check the price and try again.`;
        } else {
          const leverage = evaluateHyperliquidLeverage({
            orderValueUsd: notionalUsd,
            reduceOnly: input.reduceOnly,
            accountValueUsd: state.accountValueUsd,
            openPositionsValueUsd: state.positions.reduce((sum, p) => sum + p.positionValueUsd, 0),
            maxLeverage: wallet.maxLeverage,
          });
          if (!leverage.ok) preBlockReason = leverage.reason;
        }
      } catch (err) {
        preBlockReason = chainFailure(err);
      }
    }
    return { amount, notionalUsd, preBlockReason };
  }

  async function agentHyperliquidOrder(companyId: string, agentId: string, walletId: string, input: HyperliquidOrderRequest): Promise<CryptoWalletTransactionSummary> {
    const wallet = await requireAgentWallet(companyId, agentId, walletId);
    if (wallet.chain !== "hyperliquid") throw unprocessable("Trading orders are only possible on a Hyperliquid wallet.");
    if (wallet.network === "mainnet") assertCryptoRealMoneyAllowed();
    const { amount, notionalUsd, preBlockReason } = await prepareHyperliquidOrder(wallet, input);

    return processSpend({
      wallet,
      agentId,
      initiatedBy: "agent",
      initiatedByUserId: null,
      kind: "order",
      destination: null,
      destinationLabel: null,
      amount,
      fee: 0n,
      amountUsd: notionalUsd,
      // Closing (reduce-only) can never be blocked by a spending limit.
      countsTowardLimits: !input.reduceOnly,
      orderDetail: { coin: input.coin, side: input.side, size: input.size, limitPrice: input.limitPrice, reduceOnly: input.reduceOnly, maxLeverage: wallet.maxLeverage },
      purpose: input.purpose,
      preBlockReason,
      actor: { actorType: "agent", actorId: agentId },
    });
  }

  /** A dry run: what a payment would cost and whether it would go through, wait for approval, or be refused. Never sends. */
  async function agentQuote(companyId: string, agentId: string, walletId: string, input: CryptoQuoteRequest) {
    const wallet = await requireAgentWallet(companyId, agentId, walletId);
    const chain = wallet.chain as CryptoChain;
    const price = await priceSource.usdPrice(chain).catch(() => null);
    const ctx = await chainContext(companyId, chain, wallet);
    const out: Record<string, unknown> = { walletId, chain, network: wallet.network, assetPriceUsd: price };
    if (chain === "hyperliquid" && input.coin) {
      out.coin = input.coin;
      out.midPrice = await adapters.hyperliquid.midPrice(ctx, input.coin).catch(() => null);
      out.maxLeverage = wallet.maxLeverage;
    }
    if (input.amount) {
      const amount = parseCryptoAmount(input.amount, CRYPTO_CHAIN_INFO[chain].decimals);
      if (amount === null) throw unprocessable("That amount is not valid for this coin.");
      const switchRefusal = await assertSwitchesAllow(wallet);
      const destination = input.to ? await allowListed(wallet, input.to) : null;
      const budget = destination ? await feeBudget(wallet, destination, amount) : null;
      const fee = budget && "fee" in budget ? budget.fee : 0n;
      const amountUsd = amountUsdOf(chain, amount + fee, price);
      const spent = await spentSoFar(db, wallet, agentId, nowOf());
      const verdict =
        switchRefusal !== null
          ? { kind: "block" as const, reason: switchRefusal }
          : input.to && !destination
            ? { kind: "block" as const, reason: "That address is not on this wallet's allowed list." }
            : budget && "refusal" in budget
              ? { kind: "block" as const, reason: budget.refusal }
            : evaluateWalletSpend({
                amount,
                fee,
                amountUsd,
                assetLabel: CRYPTO_CHAIN_INFO[chain].asset,
                formatAmount: (v) => formatChainAmount(chain, v),
                wallet: {
                  perTransactionLimit: BigInt(wallet.perTransactionLimit),
                  dailyLimit: BigInt(wallet.dailyLimit),
                  totalLimit: BigInt(wallet.totalLimit),
                  approvalAbove: bigOrNull(wallet.approvalAbove),
                  spentToday: spent.walletToday,
                  spentTotal: spent.walletTotal,
                },
                agent: { ...(await getAgentLimits(companyId, agentId)), spentTodayUsd: spent.agentTodayUsd, spentTotalUsd: spent.agentTotalUsd },
              });
      out.amount = formatChainAmount(chain, amount);
      out.amountUsd = amountUsd;
      out.networkFeeAtMost = fee > 0n ? formatChainAmount(chain, fee) : null;
      out.outcome =
        verdict.kind === "allow"
          ? "Would be sent straight away."
          : verdict.kind === "needs_approval"
            ? `Would wait for a person to approve it. ${verdict.reasonForOperator}`
            : `Would be refused: ${verdict.reason}`;
    }
    return out;
  }

  async function agentGetTransaction(companyId: string, agentId: string, txId: string): Promise<CryptoWalletTransactionSummary> {
    const [row] = await db
      .select()
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.id, txId), eq(cryptoWalletTransactions.companyId, companyId), eq(cryptoWalletTransactions.agentId, agentId)));
    if (!row) throw notFound("Transaction not found.");
    const progressed = await progressOne(row, nowOf());
    return toTxSummary(progressed);
  }

  // ─── Owner-initiated send (recovery path) ──────────────────────────────

  /**
   * An owner/admin sends coins out of a wallet -- the way to get funds back,
   * since the key is never shown. Still only to allow-listed addresses, and
   * still stopped by the kill switches and the real-money switch; limits and
   * approval cards are for agents and do not apply.
   */
  async function ownerSend(companyId: string, walletId: string, input: CryptoSendRequest, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletTransactionSummary> {
    const wallet = await requireWalletRow(companyId, walletId);
    assertOwnerForRealMoney(wallet, actor, "send funds");
    assertOwnerForRoutineWallet(wallet, actor, "send funds");
    const prepared = await prepareSend(wallet, input);
    return processSpend({
      wallet,
      agentId: null,
      initiatedBy: "owner",
      initiatedByUserId: actor.userId,
      kind: "send",
      destination: prepared.destination,
      destinationLabel: prepared.destinationLabel,
      amount: prepared.amount,
      fee: prepared.fee,
      amountUsd: prepared.amountUsd,
      countsTowardLimits: false,
      orderDetail: null,
      purpose: input.purpose,
      preBlockReason: prepared.preBlockReason,
      actor: { actorType: "user", actorId: actor.userId },
    });
  }

  // ─── Trading-routine wallets (DUR-5026) ────────────────────────────────
  //
  // Wallets held by Paperclip's trading code, not by any agent. Everything
  // here runs from the server's own code: there is no agent tool for any of
  // it, and the one Trader agent can only list these wallets and ask for a
  // top-up. Test networks only: the database refuses anything else (CHECK
  // crypto_wallets_routine_shape_check) and every function asserts it again.

  const alertSink: TradingAlertSink = deps.alerts ?? tradingAlertsService(db);
  const ROUTINE_ACTOR: CryptoActor = { actorType: "system", actorId: "trading-routine" };
  /** After a sweep fails or is turned down, wait before trying again, so a refusal is not repeated every tick. */
  const SWEEP_RETRY_AFTER_FAILURE_MS = 60 * 60_000;
  const SWEEP_RETRY_AFTER_REFUSAL_MS = 24 * 60 * 60_000;
  const TOP_UP_REASK_MS = 24 * 60 * 60_000;
  const RECENT_RESULTS_WINDOW_MS = 7 * 24 * 60 * 60_000;
  const SWEEP_ADDRESS_LABEL = "Cold wallet";
  const tradingWatchIntervalMs = deps.tradingWatchIntervalMs ?? 5 * 60_000;

  /** An alert must never stop the money logic around it: a failed write is logged (without text) and dropped. */
  async function queueAlert(wallet: Pick<CryptoWalletRow, "companyId" | "id">, kind: TradingAlertKind, text: string) {
    try {
      await alertSink.write({ companyId: wallet.companyId, walletId: wallet.id, kind, text });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : "unknown", walletId: wallet.id, kind }, "trading wallet: could not queue an alert");
    }
  }

  function assertRoutineWallet(wallet: CryptoWalletRow) {
    if (wallet.holder !== "trading_routine") throw unprocessable("This is not a trading wallet.");
    // Belt and braces next to the database CHECK: test networks only.
    if (wallet.network !== "testnet") throw unprocessable("Trading wallets work on test networks only.");
  }

  async function requireRoutineWallet(companyId: string, walletId: string): Promise<CryptoWalletRow> {
    const wallet = await requireWalletRow(companyId, walletId);
    assertRoutineWallet(wallet);
    return wallet;
  }

  function limitColumns(chain: CryptoChain, input: TradingWalletLimitInput) {
    let amounts: ReturnType<typeof parseTradingLimits>;
    try {
      amounts = parseTradingLimits(chain, input);
    } catch (err) {
      if (err instanceof TradingLimitsError) throw unprocessable(err.message);
      throw err;
    }
    const text = (value: bigint | null) => (value === null ? null : value.toString());
    return {
      perTransactionLimit: amounts.perTrade.toString(),
      dailyLimit: amounts.daily.toString(),
      totalLimit: amounts.total.toString(),
      approvalAbove: null,
      maxBalance: amounts.maxBalance.toString(),
      dailyLossStop: amounts.dailyLossStop.toString(),
      sweepThreshold: text(amounts.sweepThreshold),
      topUpFloor: text(amounts.topUpFloor),
      topUpTarget: text(amounts.topUpTarget),
    };
  }

  /**
   * Makes a wallet for the trading routine: the server generates the key,
   * which goes straight into the encrypted secrets store. There is no import
   * (the key is never typed or pasted anywhere), no agent and no main network.
   */
  async function createTradingWallet(companyId: string, input: CreateTradingWalletInput, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    if (!actor.isOwner) throw forbidden("Only the company's owner can create a trading wallet.");
    const chain = input.chain;
    const network: CryptoNetwork = "testnet";
    const limits = limitColumns(chain, input.limits ?? DEFAULT_TRADING_WALLET_LIMITS[chain]);
    const adapter = adapterFor(chain);
    // Same rule as an agent's test wallet: the test network is fixed at creation
    // (the columns are required by CHECK for Bitcoin and Ethereum test wallets).
    const networkVariant: BitcoinNetworkVariant | null = chain === "bitcoin" ? DEFAULT_BITCOIN_NETWORK_VARIANT : null;
    const evmChainId: number | null = chain === "ethereum" ? EVM_CHAIN_IDS.testnet : null;
    if (evmChainId !== null && !isTestEvmChainId(evmChainId)) {
      throw unprocessable("That Ethereum network is not an allowed test network.");
    }

    let material: { privateKey: string; address: string };
    try {
      material = await adapter.generateKey(network);
    } catch (err) {
      throw unprocessable(err instanceof CryptoChainError ? err.message : "Could not make a key.");
    }
    const info = CRYPTO_CHAIN_INFO[chain];
    const shortAddress = `${material.address.slice(0, 8)}…${material.address.slice(-6)}`;
    const suffix = Math.random().toString(36).slice(2, 8);
    const secret = await secrets.createManagedLocalSecret(
      companyId,
      {
        name: `${info.label} trading wallet key: ${input.label} (${shortAddress}, ${suffix})`,
        key: `crypto_wallet_${chain}_${network}_${suffix}`,
        value: material.privateKey,
        description: `The secret key of the trading routine's ${info.label} wallet ${material.address} (${cryptoNetworkLabel(chain, network, { networkVariant, evmChainId })}). Only the server uses it, to sign trades and sweeps. It cannot be shown or copied out, and no agent can use it.`,
        kind: "crypto_wallet_key",
      },
      { userId: actor.userId },
    );
    material = { privateKey: "", address: material.address };

    const now = nowOf();
    const [row] = await db
      .insert(cryptoWallets)
      .values({
        companyId,
        agentId: null,
        holder: "trading_routine",
        chain,
        network,
        networkVariant,
        evmChainId,
        address: material.address,
        secretId: secret.id,
        keyOrigin: "generated",
        label: input.label,
        status: "active",
        ...limits,
        maxLeverage: HYPERLIQUID_DEFAULT_MAX_LEVERAGE,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await writeLedger({
      companyId,
      walletId: row!.id,
      eventType: "wallet_created",
      detail: { chain, network, networkVariant, evmChainId, address: row!.address, keyOrigin: "generated", holder: "trading_routine", byUserId: actor.userId },
    });
    return toWalletSummary(row!);
  }

  /** The owner changes the hard limits and flows of a trading wallet. Owner only: raising a limit widens what can be lost. */
  async function updateTradingLimits(companyId: string, walletId: string, limits: TradingWalletLimitInput, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    if (!actor.isOwner) throw forbidden("Only the company's owner can change a trading wallet's limits.");
    const wallet = await requireRoutineWallet(companyId, walletId);
    const columns = limitColumns(wallet.chain as CryptoChain, limits);
    const [updated] = await db
      .update(cryptoWallets)
      .set({ ...columns, updatedAt: nowOf() })
      .where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId)))
      .returning();
    await writeLedger({ companyId, walletId, eventType: "wallet_settings_changed", detail: { action: "trading_limits", byUserId: actor.userId, limits } });
    return toWalletSummary(updated!);
  }

  async function fileCard(wallet: CryptoWalletRow, requestedByAgentId: string | null, payload: Record<string, unknown>): Promise<string> {
    const [approval] = await db
      .insert(approvals)
      .values({ companyId: wallet.companyId, type: "request_board_approval", requestedByAgentId, requestedByUserId: null, status: "pending", payload })
      .returning({ id: approvals.id });
    return approval!.id;
  }

  /**
   * The owner proposes the cold-wallet address profit is swept to. Nothing
   * changes until the owner approves the card this files; the address that
   * is in force stays in force meanwhile. A newer proposal replaces an older
   * one that is still waiting.
   */
  async function proposeSweepAddress(companyId: string, walletId: string, rawAddress: string, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    if (!actor.isOwner) throw forbidden("Only the company's owner can set the cold-wallet address.");
    const wallet = await requireRoutineWallet(companyId, walletId);
    const chain = wallet.chain as CryptoChain;
    let normalized: string | null;
    try {
      normalized = await adapterFor(chain).validateAddress(rawAddress, wallet.network as CryptoNetwork);
    } catch (err) {
      throw unprocessable(chainFailure(err));
    }
    if (!normalized) {
      throw unprocessable(`That is not a valid ${CRYPTO_CHAIN_INFO[chain].label} address for the test network. Check it letter by letter.`);
    }
    if (normalized === wallet.address) throw unprocessable("A wallet cannot sweep to itself.");
    if (normalized === wallet.sweepAddress && !wallet.pendingSweepAddress) throw conflict("That is already the cold-wallet address.");

    if (wallet.pendingSweepApprovalId) {
      await db
        .update(approvals)
        .set({ status: "cancelled", updatedAt: nowOf() })
        .where(and(eq(approvals.id, wallet.pendingSweepApprovalId), eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    }
    const label = wallet.label;
    const change = wallet.sweepAddress ? `change the cold-wallet address from ${wallet.sweepAddress} to ${normalized}` : `set ${normalized} as the cold-wallet address`;
    const summary = `Trading wallet "${label}" (${cryptoNetworkLabel(chain, "testnet")}): ${change}. Profit above the sweep amount is sent only to this address, and only after you approve. Check it letter by letter: coins sent to a wrong address cannot be recovered.`;
    const approvalId = await fileCard(wallet, null, {
      kind: "crypto_sweep_address",
      walletId,
      chain,
      network: wallet.network,
      oldAddress: wallet.sweepAddress,
      newAddress: normalized,
      title: wallet.sweepAddress ? "Test coins: change the cold-wallet address" : "Test coins: set the cold-wallet address",
      summary,
      plainSummary: summary,
    });
    const [updated] = await db
      .update(cryptoWallets)
      .set({ pendingSweepAddress: normalized, pendingSweepApprovalId: approvalId, updatedAt: nowOf() })
      .where(and(eq(cryptoWallets.id, walletId), eq(cryptoWallets.companyId, companyId)))
      .returning();
    await writeLedger({ companyId, walletId, eventType: "wallet_settings_changed", detail: { action: "sweep_address_proposed", address: normalized, approvalId, byUserId: actor.userId } });
    await queueAlert(updated!, "sweep_address_requested", `Waiting for you: approve the cold-wallet address for the trading wallet "${label}" on its approval card. Profit is not swept until you do.`);
    return toWalletSummary(updated!);
  }

  /** Reads the sweep-address card and applies the owner's answer. The card's own address must still be the pending one. */
  async function resolveSweepAddressCard(wallet: CryptoWalletRow, now: Date): Promise<void> {
    if (!wallet.pendingSweepApprovalId) return;
    const [approval] = await db.select().from(approvals).where(and(eq(approvals.id, wallet.pendingSweepApprovalId), eq(approvals.companyId, wallet.companyId)));
    if (approval && (approval.status === "pending" || approval.status === "revision_requested")) return;
    const cardAddress = (approval?.payload as Record<string, unknown> | undefined)?.newAddress;
    const approved = approval?.status === "approved" && cardAddress === wallet.pendingSweepAddress && wallet.pendingSweepAddress !== null;
    if (!approved) {
      await db
        .update(cryptoWallets)
        .set({ pendingSweepAddress: null, pendingSweepApprovalId: null, updatedAt: now })
        .where(and(eq(cryptoWallets.id, wallet.id), eq(cryptoWallets.pendingSweepApprovalId, wallet.pendingSweepApprovalId)));
      await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_settings_changed", detail: { action: "sweep_address_not_approved", approvalStatus: approval?.status ?? "missing" } });
      return;
    }
    const newAddress = wallet.pendingSweepAddress!;
    // The destination must be on the allow-list for the send path to take it; the old cold wallet leaves the list.
    await db
      .insert(cryptoWalletDestinations)
      .values({ companyId: wallet.companyId, walletId: wallet.id, address: newAddress, label: SWEEP_ADDRESS_LABEL, createdByUserId: approval!.decidedByUserId ?? null })
      .onConflictDoNothing();
    if (wallet.sweepAddress && wallet.sweepAddress !== newAddress) {
      await db
        .delete(cryptoWalletDestinations)
        .where(and(eq(cryptoWalletDestinations.walletId, wallet.id), eq(cryptoWalletDestinations.address, wallet.sweepAddress), eq(cryptoWalletDestinations.label, SWEEP_ADDRESS_LABEL)));
    }
    await db
      .update(cryptoWallets)
      .set({ sweepAddress: newAddress, sweepAddressApprovedAt: now, pendingSweepAddress: null, pendingSweepApprovalId: null, updatedAt: now })
      .where(and(eq(cryptoWallets.id, wallet.id), eq(cryptoWallets.pendingSweepApprovalId, wallet.pendingSweepApprovalId!)));
    await writeLedger({
      companyId: wallet.companyId,
      walletId: wallet.id,
      eventType: "wallet_settings_changed",
      detail: { action: "sweep_address_approved", address: newAddress, previous: wallet.sweepAddress, approvalId: approval!.id, byUserId: approval!.decidedByUserId ?? null },
    });
  }

  /** Pauses a trading wallet at once (a hard stop) and queues the Telegram alert. Only the active -> frozen change alerts. */
  async function pauseTradingWallet(wallet: CryptoWalletRow, code: string, reason: string, now: Date): Promise<boolean> {
    const [paused] = await db
      .update(cryptoWallets)
      .set({ status: "frozen", frozenReason: reason, frozenAt: now, updatedAt: now })
      .where(and(eq(cryptoWallets.id, wallet.id), eq(cryptoWallets.status, "active")))
      .returning();
    if (!paused) return false;
    await writeLedger({
      companyId: wallet.companyId,
      walletId: wallet.id,
      eventType: "wallet_kill_switch",
      detail: { scope: "wallet", action: "freeze", reason: code, by: { actorType: "system", actorId: "trading-routine" } },
    });
    logger.warn({ walletId: wallet.id, code }, "trading wallet paused by a hard stop");
    await queueAlert(wallet, "wallet_paused", `Safety stop: the trading wallet "${wallet.label}" (${CRYPTO_CHAIN_INFO[wallet.chain as CryptoChain].label}, test network) was paused. ${reason} Nothing more will be traded or swept until the owner starts it again.`);
    return true;
  }

  async function sentTotals(walletId: string, dayStart: Date) {
    const [row] = await db
      .select({
        confirmedToday: sql<string>`coalesce(sum(case when ${cryptoWalletTransactions.status} = 'confirmed' and coalesce(${cryptoWalletTransactions.submittedAt}, ${cryptoWalletTransactions.createdAt}) >= ${dayStart.toISOString()}::timestamptz then ${cryptoWalletTransactions.amount} else 0 end), 0)::text`,
        unconfirmed: sql<string>`coalesce(sum(case when ${cryptoWalletTransactions.status} in ('approved', 'submitted') then ${cryptoWalletTransactions.amount} else 0 end), 0)::text`,
      })
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.walletId, walletId), eq(cryptoWalletTransactions.kind, "send")));
    return {
      confirmedToday: BigInt(String(row?.confirmedToday ?? "0").split(".")[0]!),
      unconfirmed: BigInt(String(row?.unconfirmed ?? "0").split(".")[0]!),
    };
  }

  interface WatchResult {
    wallet: CryptoWalletRow;
    balance: bigint;
    /** True when the wallet is not running (already paused, or just paused by this look). */
    paused: boolean;
    /** The balance less whatever the wallet itself already sent that the network has not confirmed yet. */
    effectiveBalance: bigint;
    /** Hyperliquid only: what the exchange lets the wallet withdraw right now. */
    withdrawable: bigint | null;
    /** The reading this look was based on. */
    fresh: CryptoWalletBalance;
  }

  /**
   * One look at a trading wallet: reads the balance from the network, then
   * applies the two balance-based hard stops (daily loss, maximum balance).
   * A breach pauses the wallet and queues the alert. A balance that cannot be
   * read throws, and the caller must treat that as "do not trade".
   */
  async function watchTradingWallet(wallet: CryptoWalletRow, now: Date): Promise<WatchResult> {
    assertRoutineWallet(wallet);
    const previousBalance = bigOrNull(wallet.lastBalance);
    // readBalance, not refreshBalance: the latter comes back here. It freezes the wallet and queues the alert itself when coins left that Paperclip did not send.
    const fresh = await readBalance(wallet.companyId, wallet.id);
    const balance = BigInt(fresh.balance);
    const row = await requireWalletRow(wallet.companyId, wallet.id);
    const withdrawable = fresh.withdrawable === null || fresh.withdrawable === undefined ? null : BigInt(fresh.withdrawable);
    if (row.status !== "active") return { wallet: row, balance, paused: true, effectiveBalance: balance, withdrawable, fresh };

    const totals = await sentTotals(row.id, utcDayStart(now));
    const today = utcDayKey(now);
    const loss = evaluateDailyLoss({
      balance,
      outflowsToday: totals.confirmedToday,
      today,
      lossDay: row.lossDay,
      lossDayPeak: bigOrNull(row.lossDayPeak),
      previousBalance,
    });
    await db.update(cryptoWallets).set({ lossDay: today, lossDayPeak: loss.peak.toString() }).where(eq(cryptoWallets.id, row.id));
    const effectiveBalance = balance > totals.unconfirmed ? balance - totals.unconfirmed : 0n;
    const breach = evaluateBalanceBreach({
      chain: row.chain as CryptoChain,
      effectiveBalance,
      loss: loss.loss,
      maxBalance: BigInt(row.maxBalance!),
      dailyLossStop: BigInt(row.dailyLossStop!),
    });
    if (breach.kind !== "ok") {
      await pauseTradingWallet(row, breach.kind, breach.reason, now);
      return { wallet: await requireWalletRow(row.companyId, row.id), balance, paused: true, effectiveBalance, withdrawable, fresh };
    }
    return { wallet: row, balance, paused: false, effectiveBalance, withdrawable, fresh };
  }

  /**
   * A trade placed by Paperclip's trading code on a code-held Hyperliquid test
   * wallet. No route calls this: only server code does. The hard stops are
   * checked against a fresh balance first; the per-trade, per-day and total
   * caps are checked under the wallet's lock; a reduce-only order (an exit)
   * is never stopped by a spending cap. No approval card is involved.
   */
  async function routineHyperliquidOrder(companyId: string, walletId: string, input: HyperliquidOrderRequest): Promise<CryptoWalletTransactionSummary> {
    const wallet = await requireRoutineWallet(companyId, walletId);
    if (wallet.chain !== "hyperliquid") throw unprocessable("Trading orders are only possible on a Hyperliquid wallet.");
    let latest = wallet;
    let watchRefusal: string | null = null;
    try {
      latest = (await watchTradingWallet(wallet, nowOf())).wallet;
    } catch (err) {
      watchRefusal = `The wallet's balance could not be checked, so the hard limits could not be applied and nothing was traded. ${chainFailure(err)}`;
    }
    const prepared = await prepareHyperliquidOrder(latest, input);
    return processSpend({
      wallet: latest,
      agentId: null,
      initiatedBy: "routine",
      initiatedByUserId: null,
      kind: "order",
      destination: null,
      destinationLabel: null,
      amount: prepared.amount,
      fee: 0n,
      amountUsd: prepared.notionalUsd,
      countsTowardLimits: !input.reduceOnly,
      orderDetail: { coin: input.coin, side: input.side, size: input.size, limitPrice: input.limitPrice, reduceOnly: input.reduceOnly, maxLeverage: latest.maxLeverage },
      purpose: input.purpose,
      preBlockReason: (input.reduceOnly ? null : watchRefusal) ?? prepared.preBlockReason,
      actor: ROUTINE_ACTOR,
      routineAction: "trade",
    });
  }

  async function alertSweepOutcome(tx: CryptoWalletTxRow) {
    const [wallet] = await db.select().from(cryptoWallets).where(eq(cryptoWallets.id, tx.walletId));
    if (!wallet) return;
    const chain = wallet.chain as CryptoChain;
    if (tx.status === "confirmed") {
      await queueAlert(wallet, "sweep_sent", `Profit swept: ${formatChainAmount(chain, tx.amount)} from the trading wallet "${wallet.label}" went to your cold wallet.`);
    } else {
      await queueAlert(wallet, "sweep_sent", `A profit sweep from the trading wallet "${wallet.label}" did not go through: ${tx.blockReason ?? tx.error ?? "stopped by a safety rule"}. Nothing left the wallet.`);
    }
  }

  /** Sends the surplus above the sweep amount to the approved cold wallet. The first sweep to an address waits for the owner's card. */
  async function maybeSweep(wallet: CryptoWalletRow, effectiveBalance: bigint, withdrawable: bigint | null, now: Date): Promise<void> {
    if (wallet.sweepThreshold === null || wallet.sweepAddress === null || wallet.sweepAddressApprovedAt === null) return;
    const chain = wallet.chain as CryptoChain;
    const dust = BigInt(CRYPTO_DUST[chain]);
    let surplus = sweepAmount({ effectiveBalance, threshold: BigInt(wallet.sweepThreshold), dust });
    if (surplus === null) return;
    // On Hyperliquid, margin for open positions cannot be withdrawn: never ask for more than the exchange will release (less its fee).
    if (chain === "hyperliquid" && withdrawable !== null) {
      const fee = BigInt(CRYPTO_NETWORK_FEE_CEILING.hyperliquid);
      const releasable = withdrawable > fee ? withdrawable - fee : 0n;
      if (surplus > releasable) surplus = releasable;
      if (surplus <= dust) return;
    }

    const recent = await db
      .select()
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.walletId, wallet.id), eq(cryptoWalletTransactions.routineAction, "sweep")))
      .orderBy(desc(cryptoWalletTransactions.createdAt))
      .limit(20);
    if (recent.some((tx) => ["pending_approval", "approved", "submitted"].includes(tx.status))) return;
    const latest = recent[0];
    if (latest) {
      const age = now.getTime() - latest.createdAt.getTime();
      if ((latest.status === "rejected" || latest.status === "expired_approval") && age < SWEEP_RETRY_AFTER_REFUSAL_MS) return;
      if ((latest.status === "failed" || latest.status === "blocked") && age < SWEEP_RETRY_AFTER_FAILURE_MS) return;
    }
    const firstToThisAddress = !recent.some((tx) => tx.destination === wallet.sweepAddress && (tx.status === "submitted" || tx.status === "confirmed"));

    const prepared = await prepareSend(wallet, {
      to: wallet.sweepAddress,
      amount: formatCryptoAmount(surplus, CRYPTO_CHAIN_INFO[chain].decimals),
      purpose: "Profit sweep to the cold wallet",
    });
    const result = await processSpend({
      wallet,
      agentId: null,
      initiatedBy: "routine",
      initiatedByUserId: null,
      kind: "send",
      destination: prepared.destination,
      destinationLabel: prepared.destinationLabel,
      amount: prepared.amount,
      fee: prepared.fee,
      amountUsd: prepared.amountUsd,
      countsTowardLimits: false,
      orderDetail: null,
      purpose: "Profit sweep to the cold wallet",
      preBlockReason: prepared.preBlockReason,
      actor: ROUTINE_ACTOR,
      routineAction: "sweep",
      ...(firstToThisAddress ? { forceApproval: "This is the first sweep to this cold-wallet address, so you decide first." } : {}),
    });
    if (result.status === "pending_approval") {
      await queueAlert(wallet, "sweep_waiting_approval", `Waiting for you: the trading wallet "${wallet.label}" wants to sweep ${formatChainAmount(chain, result.amount)} of profit to your cold wallet. Approve or turn it down on the approval card.`);
    }
  }

  /** Plain sentences about how the wallet has done lately, built from the server's own records. */
  async function recentResultsFor(wallet: CryptoWalletRow, balance: bigint, now: Date): Promise<string[]> {
    const chain = wallet.chain as CryptoChain;
    const since = new Date(now.getTime() - RECENT_RESULTS_WINDOW_MS);
    const rows = await db
      .select({ status: cryptoWalletTransactions.status, kind: cryptoWalletTransactions.kind, routineAction: cryptoWalletTransactions.routineAction })
      .from(cryptoWalletTransactions)
      .where(and(eq(cryptoWalletTransactions.walletId, wallet.id), gte(cryptoWalletTransactions.createdAt, since)));
    const trades = rows.filter((r) => r.routineAction === "trade");
    const placed = trades.filter((r) => ["submitted", "confirmed"].includes(r.status)).length;
    const refused = trades.filter((r) => r.status === "blocked").length;
    const results = [`Last 7 days: ${placed} trade${placed === 1 ? "" : "s"} placed, ${refused} refused by a limit.`];
    const [first] = await db
      .select({ detail: tradingLedgerEntries.detail })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.walletId, wallet.id), eq(tradingLedgerEntries.eventType, "wallet_reconciliation"), gte(tradingLedgerEntries.createdAt, since)))
      .orderBy(asc(tradingLedgerEntries.createdAt))
      .limit(1);
    const earlier = (first?.detail as Record<string, unknown> | null)?.balance;
    if (typeof earlier === "string" && /^\d+$/.test(earlier)) {
      results.push(`Balance a week ago: ${formatChainAmount(chain, earlier)}; now: ${formatChainAmount(chain, balance)}.`);
    }
    const [lastStop] = await db
      .select({ createdAt: tradingLedgerEntries.createdAt })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.walletId, wallet.id), eq(tradingLedgerEntries.eventType, "wallet_kill_switch"), gte(tradingLedgerEntries.createdAt, since)))
      .orderBy(desc(tradingLedgerEntries.createdAt))
      .limit(1);
    if (lastStop) results.push(`The wallet was paused by a safety stop on ${lastStop.createdAt.toISOString().slice(0, 10)}.`);
    return results;
  }

  /**
   * Files the "please top up" card: how much, why, and how the wallet has
   * done lately. One card is open per wallet at a time; after an answer,
   * the next request waits a day. The owner sends the funds himself; this
   * card moves no money. Returns the open card when one already exists.
   */
  async function fileTopUpCard(
    wallet: CryptoWalletRow,
    balance: bigint,
    reason: string,
    requestedByAgentId: string | null,
    now: Date,
  ): Promise<{ approvalId: string; created: boolean } | null> {
    if (wallet.topUpFloor === null || wallet.topUpTarget === null) return null;
    const chain = wallet.chain as CryptoChain;
    const needed = topUpNeeded({ balance, floor: BigInt(wallet.topUpFloor), target: BigInt(wallet.topUpTarget) });
    if (needed === null) return null;
    if (wallet.topUpApprovalId) {
      const [open] = await db.select().from(approvals).where(and(eq(approvals.id, wallet.topUpApprovalId), eq(approvals.companyId, wallet.companyId)));
      if (open && (open.status === "pending" || open.status === "revision_requested")) return { approvalId: open.id, created: false };
      const answeredAt = open?.decidedAt ?? open?.updatedAt;
      if (answeredAt && now.getTime() - answeredAt.getTime() < TOP_UP_REASK_MS) return null;
    }
    const recent = await recentResultsFor(wallet, balance, now);
    const asset = CRYPTO_CHAIN_INFO[chain].asset;
    const amountText = formatChainAmount(chain, needed);
    // The Trader's words are quoted and labelled as theirs: the address and amounts above come from the server, not from the Trader.
    const why = requestedByAgentId ? `The Trader says (its own words, not checked): "${reason}"` : `Why: ${reason}`;
    const summary = `The trading wallet "${wallet.label}" (${cryptoNetworkLabel(chain, "testnet")}) holds ${formatChainAmount(chain, balance)}, below its floor of ${formatChainAmount(chain, wallet.topUpFloor)}. Please send about ${amountText} to ${wallet.address} to bring it back to ${formatChainAmount(chain, wallet.topUpTarget)}. ${recent.join(" ")} ${why} You send the funds yourself; nothing is taken from anywhere. These are test coins with no value.`;
    const approvalId = await fileCard(wallet, requestedByAgentId, {
      kind: "crypto_topup_request",
      walletId: wallet.id,
      chain,
      network: wallet.network,
      address: wallet.address,
      asset,
      suggestedAmount: amountText,
      balance: formatChainAmount(chain, balance),
      floor: formatChainAmount(chain, wallet.topUpFloor),
      target: formatChainAmount(chain, wallet.topUpTarget),
      reason,
      recentResults: recent,
      title: `Test coins: the trading wallet "${wallet.label}" needs a top-up`,
      summary,
      plainSummary: summary,
    });
    await db.update(cryptoWallets).set({ topUpApprovalId: approvalId, updatedAt: now }).where(eq(cryptoWallets.id, wallet.id));
    await writeLedger({ companyId: wallet.companyId, walletId: wallet.id, eventType: "wallet_settings_changed", detail: { action: "top_up_requested", approvalId, suggestedAmount: amountText, byAgentId: requestedByAgentId } });
    await queueAlert(wallet, "top_up_requested", `Top-up needed: the trading wallet "${wallet.label}" holds ${formatChainAmount(chain, balance)}. Please send about ${amountText} (details on the approval card).`);
    return { approvalId, created: true };
  }

  async function requireTraderAgent(companyId: string, agentId: string) {
    const settings = await getSettings(companyId);
    if (!settings.traderAgentId || settings.traderAgentId !== agentId) {
      throw forbidden("Only the company's Trader agent can use the trading wallet tools.");
    }
  }

  /** The Trader's read-only view of the code-held wallets: no key, no secret id, nothing it can spend. */
  async function traderListTradingWallets(companyId: string, agentId: string): Promise<CryptoWalletSummary[]> {
    await requireTraderAgent(companyId, agentId);
    const rows = await db
      .select()
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.companyId, companyId), eq(cryptoWallets.holder, "trading_routine")))
      .orderBy(asc(cryptoWallets.createdAt));
    return rows.filter((r) => r.status !== "archived").map(toWalletSummary);
  }

  /** One top-up request per wallet per watch interval: the Trader cannot use this endpoint to make the network read the wallet over and over. */
  const lastTopUpRequestAt = new Map<string, number>();

  /**
   * The Trader asks the owner for funds. Only possible while the balance is
   * below the floor. The floor is checked against the stored reading first,
   * so a request made while the wallet is above it never touches the network;
   * otherwise the wallet gets a proper watch (balance read plus the hard
   * stops), never a bare refresh -- a bare refresh would stamp lastBalanceAt
   * and make the scheduler skip the stops for the next few minutes (DUR-5087 N2).
   */
  async function traderRequestTopUp(companyId: string, agentId: string, walletId: string, reason: string): Promise<{ approvalId: string; created: boolean }> {
    await requireTraderAgent(companyId, agentId);
    const wallet = await requireRoutineWallet(companyId, walletId);
    if (wallet.status === "archived") throw unprocessable("This wallet is archived.");
    if (wallet.topUpFloor === null || wallet.topUpTarget === null) throw unprocessable("This wallet has no top-up floor set, so a top-up cannot be requested.");
    const now = nowOf();
    const last = lastTopUpRequestAt.get(walletId);
    if (last !== undefined && now.getTime() - last < tradingWatchIntervalMs) {
      throw tooManyRequests("A top-up was asked for on this wallet a moment ago. Try again in a few minutes.");
    }
    lastTopUpRequestAt.set(walletId, now.getTime());
    const notBelowFloor = () =>
      unprocessable("The balance is not below the floor (or a request was answered less than a day ago), so no top-up card was filed.");
    const stored = bigOrNull(wallet.lastBalance);
    const floor = { floor: BigInt(wallet.topUpFloor), target: BigInt(wallet.topUpTarget) };
    if (stored !== null && topUpNeeded({ balance: stored, ...floor }) === null) throw notBelowFloor();
    // A reading the scheduler or a trade took within the last interval already went through the hard stops: use it.
    const recent = wallet.lastBalanceAt !== null && stored !== null && now.getTime() - wallet.lastBalanceAt.getTime() < tradingWatchIntervalMs;
    const watched = recent ? { wallet, balance: stored } : await watchTradingWallet(wallet, now);
    const filed = await fileTopUpCard(watched.wallet, watched.balance, reason, agentId, now);
    if (!filed) throw notBelowFloor();
    return filed;
  }

  /** One pass over every trading wallet: apply the owner's card answers, the hard stops, the sweep and the top-up request. */
  async function tradingTick(now: Date): Promise<number> {
    const rows = await db
      .select()
      .from(cryptoWallets)
      .where(and(eq(cryptoWallets.holder, "trading_routine"), inArray(cryptoWallets.status, ["active", "frozen"])))
      // Never-looked-at wallets first, then the one looked at longest ago, so none starves behind a full batch.
      .orderBy(sql`${cryptoWallets.lastBalanceAt} asc nulls first`)
      .limit(TICK_BATCH);
    let looked = 0;
    for (const row of rows) {
      try {
        await resolveSweepAddressCard(row, now);
        if (row.status !== "active") continue;
        // The network is asked only now and then, not on every scheduler tick.
        if (row.lastBalanceAt && now.getTime() - row.lastBalanceAt.getTime() < tradingWatchIntervalMs) continue;
        const fresh = await requireWalletRow(row.companyId, row.id);
        const watched = await watchTradingWallet(fresh, now);
        looked++;
        if (watched.paused) continue;
        await maybeSweep(watched.wallet, watched.effectiveBalance, watched.withdrawable, now);
        await fileTopUpCard(watched.wallet, watched.balance, "The balance fell below the floor.", null, now);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.name : "unknown", walletId: row.id }, "trading wallet tick: one wallet failed");
      }
    }
    return looked;
  }

  // ─── The tick: approvals, expiry, network status ───────────────────────

  async function progressOne(row: CryptoWalletTxRow, now: Date): Promise<CryptoWalletTxRow> {
    if (row.status === "pending_approval") {
      if (row.approvalExpiresAt && row.approvalExpiresAt.getTime() <= now.getTime()) {
        const [expired] = await db
          .update(cryptoWalletTransactions)
          .set({ status: "expired_approval", updatedAt: now })
          .where(and(eq(cryptoWalletTransactions.id, row.id), eq(cryptoWalletTransactions.status, "pending_approval")))
          .returning();
        if (!expired) return row;
        // Close the board card too, so no dead card stays in "Needs you" and
        // approving it later does nothing. A card a person already decided is
        // left as it is.
        if (row.approvalId) {
          await db
            .update(approvals)
            .set({ status: "cancelled", decisionNote: "Expired: nobody answered in time, so nothing was sent.", decidedAt: now, updatedAt: now })
            .where(and(eq(approvals.id, row.approvalId), eq(approvals.companyId, row.companyId), inArray(approvals.status, ["pending", "revision_requested"])));
        }
        await writeLedger({ companyId: row.companyId, walletId: row.walletId, eventType: "wallet_tx_rejected", tx: expired, detail: { reason: "approval_expired" } });
        return expired;
      }
      if (!row.approvalId) return row;
      const [approval] = await db.select().from(approvals).where(and(eq(approvals.id, row.approvalId), eq(approvals.companyId, row.companyId)));
      if (!approval || approval.status === "pending" || approval.status === "revision_requested") return row;
      if (approval.status === "approved") {
        // Claim it: only the caller that flips pending -> approved sends it.
        const [claimed] = await db
          .update(cryptoWalletTransactions)
          .set({ status: "approved", updatedAt: now })
          .where(and(eq(cryptoWalletTransactions.id, row.id), eq(cryptoWalletTransactions.status, "pending_approval")))
          .returning();
        if (!claimed) return row;
        return executeApproved(claimed, { actorType: "user", actorId: approval.decidedByUserId ?? "board" });
      }
      const [rejected] = await db
        .update(cryptoWalletTransactions)
        .set({ status: "rejected", updatedAt: now, blockReason: "A person turned the request down on the approval card." })
        .where(and(eq(cryptoWalletTransactions.id, row.id), eq(cryptoWalletTransactions.status, "pending_approval")))
        .returning();
      if (!rejected) return row;
      await writeLedger({ companyId: row.companyId, walletId: row.walletId, eventType: "wallet_tx_rejected", tx: rejected, detail: { reason: "approval_rejected" } });
      return rejected;
    }

    if (row.status === "approved" && now.getTime() - row.updatedAt.getTime() > APPROVED_WITHOUT_HASH_GIVE_UP_MS) {
      // Stuck between approval and signing (e.g. a server restart). Signed
      // bytes are always saved together with status "submitted", so an
      // "approved" row was never signed and never sent.
      if (!row.txHash) {
        return finish(row, { status: "failed", error: "Sending was interrupted before anything was signed. Nothing was sent." }, "wallet_tx_failed", { reason: "interrupted_before_signing" });
      }
      return checkOnNetwork(row, now);
    }

    if (row.status === "submitted" && row.txHash) return checkOnNetwork(row, now);
    return row;
  }

  /**
   * Settles a sent payment. "failed" only on the chain adapter's definite
   * answer (Solana: its block id has long expired; Ethereum: its nonce was
   * used by another mined transaction; Bitcoin: one of its inputs was spent
   * elsewhere; or a clear refusal of the first send). Network trouble or
   * "not seen yet" keeps it counted and re-sends the same signed bytes now
   * and then -- never a newly signed payment, so it cannot land twice.
   */
  async function checkOnNetwork(row: CryptoWalletTxRow, now: Date): Promise<CryptoWalletTxRow> {
    const chain = row.chain as CryptoChain;
    const wallet = await requireWalletRow(row.companyId, row.walletId);
    const ctx = await chainContext(row.companyId, chain, wallet);
    const detail = (row.chainDetail as Record<string, unknown> | null) ?? null;
    let status: TxStatusCheck;
    try {
      status = await adapterFor(chain).getTxStatus(ctx, {
        txHash: row.txHash!,
        raw: row.signedRaw,
        chainDetail: detail,
        from: wallet.address,
        feeUpperBound: BigInt(row.feeUpperBound ?? "0"),
        checkedAt: now,
      });
    } catch {
      status = "unknown";
    }
    if (status === "confirmed") {
      return finish(row, { status: "confirmed", confirmedAt: now, error: null }, "wallet_tx_confirmed", {});
    }
    if (typeof status === "object" && status.status === "reverted") {
      // The payment was mined but the receiver rejected it: the coins
      // stayed, the network fee did not. That fee keeps counting toward the
      // limits and explains the balance drop (so no false "stolen key").
      const price = await priceSource.usdPrice(chain).catch(() => null);
      const feePaidUsd = amountUsdOf(chain, status.feePaid, price);
      return finish(
        row,
        {
          status: "failed",
          confirmedAt: now,
          chainDetail: { ...(detail ?? {}), feePaid: status.feePaid.toString(), feePaidUsd: feePaidUsd ?? 0 },
          error: `The payment was rejected by the receiving ${chain === "solana" ? "program" : "contract"}, so the coins did not move. The network fee (${formatChainAmount(chain, status.feePaid)}) was still paid and still counts toward the limits.`,
        },
        "wallet_tx_failed",
        { reason: "reverted", feePaid: status.feePaid.toString() },
      );
    }
    if (status === "failed") {
      return finish(
        row,
        {
          status: "failed",
          error:
            chain === "hyperliquid"
              ? "Hyperliquid has no record of this and can no longer accept it (more than two days have passed), so it did not happen. It no longer counts toward the limits."
              : "The network shows this payment can never go through, so the coins did not leave. It no longer counts toward the limits.",
        },
        "wallet_tx_failed",
        { reason: "definitely_not_landed" },
      );
    }
    const lastSend = row.lastBroadcastAt?.getTime() ?? 0;
    // Orders are never re-sent: a late re-send could run at whatever
    // leverage the exchange account has by then. An order with an unclear
    // answer is only looked up (by its own order id) until it is found or
    // can no longer be accepted. Withdrawals carry no leverage and are
    // re-sent as the same signed bytes (same nonce, so at most once).
    // Not on a main network while real money is locked off: sending is real money moving.
    if (row.kind !== "order" && row.signedRaw && now.getTime() - lastSend >= REBROADCAST_INTERVAL_MS && !(row.network === "mainnet" && !isCryptoRealMoneyAllowed())) {
      const signed: SignedTransfer = {
        raw: row.signedRaw,
        txHash: row.txHash!,
        feeUpperBound: BigInt(row.feeUpperBound ?? "0"),
        chainDetail: detail ?? undefined,
      };
      const after = await sendSigned(row.status === "submitted" ? row : { ...row, status: "submitted" }, ctx, signed, false);
      if (row.status !== "submitted" && after.status === row.status) {
        const [moved] = await db.update(cryptoWalletTransactions).set({ status: "submitted", updatedAt: now }).where(eq(cryptoWalletTransactions.id, row.id)).returning();
        return moved ?? after;
      }
      return after;
    }
    // Touch it so the tick's batch keeps rotating through every open payment.
    const [touched] = await db
      .update(cryptoWalletTransactions)
      .set({ status: "submitted", updatedAt: now })
      .where(eq(cryptoWalletTransactions.id, row.id))
      .returning();
    return touched ?? row;
  }

  async function tick(now: Date = nowOf()): Promise<{ checked: number; changed: number; tradingWalletsChecked: number }> {
    const rows = await db
      .select()
      .from(cryptoWalletTransactions)
      .where(
        or(
          eq(cryptoWalletTransactions.status, "pending_approval"),
          eq(cryptoWalletTransactions.status, "submitted"),
          and(eq(cryptoWalletTransactions.status, "approved"), lt(cryptoWalletTransactions.updatedAt, new Date(now.getTime() - APPROVED_WITHOUT_HASH_GIVE_UP_MS))),
        ),
      )
      .orderBy(asc(cryptoWalletTransactions.updatedAt))
      .limit(TICK_BATCH);
    let changed = 0;
    for (const row of rows) {
      try {
        const after = await progressOne(row, now);
        if (after.status !== row.status) changed++;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.name : "unknown", txId: row.id }, "crypto wallet tick: one transaction failed to progress");
      }
    }
    // Trading wallets: the payments above are settled first, so the balance
    // the hard stops read already reflects them.
    const tradingWalletsChecked = await tradingTick(now);
    return { checked: rows.length, changed, tradingWalletsChecked };
  }

  return {
    getSettings,
    updateSettings,
    listWallets,
    getWallet: async (companyId: string, walletId: string) => toWalletSummary(await requireWalletRow(companyId, walletId)),
    createWallet,
    updateWallet,
    setFrozen,
    archiveWallet,
    listDestinations,
    addDestination,
    removeDestination,
    getAgentLimits,
    setAgentLimits,
    listTransactions,
    listLedger,
    refreshBalance,
    ownerSend,
    agentListWallets,
    agentBalance,
    agentDestinations,
    agentSend,
    agentHyperliquidOrder,
    agentQuote,
    agentGetTransaction,
    createTradingWallet,
    updateTradingLimits,
    proposeSweepAddress,
    routineHyperliquidOrder,
    traderListTradingWallets,
    traderRequestTopUp,
    tick,
  };
}

export type CryptoWalletService = ReturnType<typeof cryptoWalletService>;
