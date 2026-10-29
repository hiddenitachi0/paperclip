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
  DEFAULT_CRYPTO_RPC_ENDPOINTS,
  DEFAULT_CRYPTO_WALLET_LIMITS,
  HYPERLIQUID_DEFAULT_MAX_LEVERAGE,
  cryptoNetworkLabel,
  formatChainAmount,
  formatCryptoAmount,
  parseCryptoAmount,
  type CompanyCryptoSettings,
  type CreateCryptoWalletInput,
  type CryptoAgentLimits,
  type CryptoChain,
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
  type TradingLedgerEventType,
  type UpdateCompanyCryptoSettingsInput,
  type UpdateCryptoWalletInput,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
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

/** The only shape a wallet ever leaves this service in. No key, no secret id. */
export function toWalletSummary(row: CryptoWalletRow): CryptoWalletSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    chain: row.chain as CryptoChain,
    network: row.network as CryptoNetwork,
    address: row.address,
    label: row.label,
    keyOrigin: row.keyOrigin as "generated" | "imported",
    status: row.status as CryptoWalletStatus,
    frozenReason: row.frozenReason,
    limits: toLimits(row),
    maxLeverage: row.maxLeverage,
    lastBalance: row.lastBalance,
    lastBalanceAt: row.lastBalanceAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTxSummary(row: CryptoWalletTxRow): CryptoWalletTransactionSummary {
  return {
    id: row.id,
    walletId: row.walletId,
    agentId: row.agentId,
    initiatedBy: row.initiatedBy as "agent" | "owner",
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

    if (input.rpcEndpoints) {
      // Which network service a wallet talks to decides which network it
      // really signs on, so this is the owner's call, like real money.
      if (!actor.isOwner) throw forbidden("Only the company's owner can change the crypto network addresses.");
      const merged: CompanyCryptoSettings["rpcEndpoints"] = JSON.parse(JSON.stringify(current.rpcEndpoints));
      for (const [chain, networks] of Object.entries(input.rpcEndpoints) as Array<[CryptoChain, Partial<Record<CryptoNetwork, string | null>>]>) {
        for (const [network, url] of Object.entries(networks ?? {}) as Array<[CryptoNetwork, string | null]>) {
          const forChain = (merged[chain] ??= {});
          if (url === null) {
            delete forChain[network];
          } else {
            try {
              createCryptoRpcOutboundPolicy(url);
            } catch (err) {
              throw unprocessable(err instanceof Error ? err.message : "That network address is not allowed.");
            }
            forChain[network] = url;
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

  function endpointFor(settings: CompanyCryptoSettings, chain: CryptoChain, network: CryptoNetwork): string {
    return settings.rpcEndpoints?.[chain]?.[network] ?? DEFAULT_CRYPTO_RPC_ENDPOINTS[chain][network];
  }

  async function chainContext(companyId: string, chain: CryptoChain, network: CryptoNetwork): Promise<ChainContext> {
    const settings = await getSettings(companyId);
    const rpcUrl = endpointFor(settings, chain, network);
    return { network, rpcUrl, fetch: fetchFor(rpcUrl) };
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
    if (input.network === "mainnet" && !settings.mainnetEnabled) {
      throw forbidden("Real money is switched off for this company. The owner can turn it on in the crypto settings; until then, use the test network.");
    }
    if (input.network === "mainnet" && input.limits !== undefined && !actor.isOwner) {
      throw forbidden("Only the company's owner can set limits on a real-money wallet. Leave the limits out to start with the safe defaults.");
    }
    const limits = limitsToBaseUnits(input.chain, input.limits ?? DEFAULT_CRYPTO_WALLET_LIMITS[input.chain]);
    const adapter = adapterFor(input.chain);

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
        description: `The secret key of ${agent.name}'s ${info.label} wallet ${material.address} (${cryptoNetworkLabel(input.chain, input.network)}). Only the server uses it, to sign payments. It cannot be shown or copied out.`,
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
      detail: { chain: input.chain, network: input.network, address: row!.address, keyOrigin: row!.keyOrigin, agentId: agent.id, byUserId: actor.userId },
    });
    return toWalletSummary(row!);
  }

  /** Real-money wallets: anything that widens what can leave (limits, allow-list, owner send, leverage, who uses it) is the owner's call. */
  function assertOwnerForRealMoney(wallet: CryptoWalletRow, actor: { isOwner: boolean }, what: string) {
    if (wallet.network === "mainnet" && !actor.isOwner) {
      throw forbidden(`Only the company's owner can ${what} on a real-money wallet.`);
    }
  }

  async function updateWallet(companyId: string, walletId: string, input: UpdateCryptoWalletInput, actor: { userId: string; isOwner: boolean }): Promise<CryptoWalletSummary> {
    const row = await requireWalletRow(companyId, walletId);
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
      if (input.agentId !== null) await requireAgent(companyId, input.agentId);
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
    const now = nowOf();
    const [updated] = await db
      .update(cryptoWallets)
      .set(
        frozen
          ? { status: "frozen", frozenReason: reason?.trim() || "Frozen by an owner or admin.", frozenAt: now, updatedAt: now }
          : { status: "active", frozenReason: null, frozenAt: null, updatedAt: now },
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

  async function removeDestination(companyId: string, walletId: string, destinationId: string, actor: { userId: string }): Promise<void> {
    await requireWalletRow(companyId, walletId);
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

  async function refreshBalance(companyId: string, walletId: string): Promise<CryptoWalletBalance> {
    const wallet = await requireWalletRow(companyId, walletId);
    const chain = wallet.chain as CryptoChain;
    const ctx = await chainContext(companyId, chain, wallet.network as CryptoNetwork);
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

  async function spentSoFar(tx: Pick<Db, "select">, wallet: CryptoWalletRow, agentId: string, now: Date) {
    const dayStartIso = utcDayStart(now).toISOString();
    const walletBase = and(eq(cryptoWalletTransactions.walletId, wallet.id), eq(cryptoWalletTransactions.countsTowardLimits, true), stillCostsSql);
    const agentBase = and(
      eq(cryptoWalletTransactions.agentId, agentId),
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
    const summary = `${agentName} wants to ${what} from the wallet "${wallet.label}". Reason given: "${tx.purpose}". ${reasonForOperator} ${
      realMoney ? "This is REAL money and cannot be undone." : "This is on a test network; test coins have no value."
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
          title: `${realMoney ? "Real money: " : "Test coins: "}${agentName} wants to ${tx.kind === "order" ? "trade" : "pay"} from a crypto wallet`,
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
    if (switchRefusal || !destinationOk) {
      const reason = switchRefusal ?? "The address is no longer on this wallet's allowed list.";
      return finish(txRow, { status: "blocked", blockReason: reason }, "wallet_tx_blocked", { reason });
    }

    const ctx = await chainContext(wallet.companyId, chain, wallet.network as CryptoNetwork);
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
    initiatedBy: "agent" | "owner";
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
      } else if (req.initiatedBy === "owner" || !req.countsTowardLimits) {
        verdict = { kind: "allow" };
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
      const agentName = req.agentId ? (await requireAgent(wallet.companyId, req.agentId)).name : "Someone";
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
      const ctx = await chainContext(wallet.companyId, chain, wallet.network as CryptoNetwork);
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

  async function agentHyperliquidOrder(companyId: string, agentId: string, walletId: string, input: HyperliquidOrderRequest): Promise<CryptoWalletTransactionSummary> {
    const wallet = await requireAgentWallet(companyId, agentId, walletId);
    if (wallet.chain !== "hyperliquid") throw unprocessable("Trading orders are only possible on a Hyperliquid wallet.");
    if (wallet.network === "mainnet") assertCryptoRealMoneyAllowed();
    const size = Number(input.size);
    const price = Number(input.limitPrice);
    if (!(size > 0) || !(price > 0)) throw unprocessable("Size and price must be more than zero.");
    const notionalUsd = size * price;
    const amount = parseCryptoAmount(notionalUsd.toFixed(6), 6) ?? 0n;

    let preBlockReason = await assertSwitchesAllow(wallet);
    if (!preBlockReason) {
      const ctx = await chainContext(companyId, "hyperliquid", wallet.network as CryptoNetwork);
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
    const ctx = await chainContext(companyId, chain, wallet.network as CryptoNetwork);
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
    const ctx = await chainContext(row.companyId, chain, row.network as CryptoNetwork);
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

  async function tick(now: Date = nowOf()): Promise<{ checked: number; changed: number }> {
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
    return { checked: rows.length, changed };
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
    tick,
  };
}

export type CryptoWalletService = ReturnType<typeof cryptoWalletService>;
