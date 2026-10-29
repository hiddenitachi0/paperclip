import { sql } from "drizzle-orm";
import { boolean, check, date, doublePrecision, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Crypto wallets for agents (migration 0251). See
 * packages/shared/src/crypto-wallets.ts for the design and the safety rules.
 *
 * Key material is NEVER stored in any of these tables: `crypto_wallets.secret_id`
 * points at a `crypto_wallet_key` secret in the encrypted company secrets
 * store, which only the server-side signer ever resolves.
 *
 * Amounts are integer base units (sats, wei, lamports, USDC micro-units) in
 * numeric(78,0) columns -- wide enough for any 256-bit amount, never a float.
 *
 * Tables:
 *   * company_crypto_settings -- one row per company that has touched the
 *     feature: real-money switch (off by default), company-wide kill switch,
 *     and the company's own network endpoints (optional).
 *   * crypto_wallets -- one row per wallet: chain, network (fixed at
 *     creation), address, the agent it belongs to, its limits and its kill
 *     switch (status 'frozen').
 *   * crypto_wallet_destinations -- the allow-list: the only addresses a
 *     wallet may ever send to.
 *   * crypto_agent_limits -- per-agent dollar limits across all its wallets.
 *   * crypto_wallet_transactions -- every payment/order attempt, including
 *     the blocked ones, with tx hash and status.
 *
 * Every event also lands in trading_ledger_entries (wallet_id set,
 * strategy_id null) -- the same append-only ledger the trading agent uses.
 */
export const companyCryptoSettings = pgTable("company_crypto_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  mainnetEnabled: boolean("mainnet_enabled").notNull().default(false),
  mainnetEnabledAt: timestamp("mainnet_enabled_at", { withTimezone: true }),
  mainnetEnabledByUserId: text("mainnet_enabled_by_user_id"),
  allWalletsFrozen: boolean("all_wallets_frozen").notNull().default(false),
  frozenReason: text("frozen_reason"),
  rpcEndpoints: jsonb("rpc_endpoints").notNull().default({}),
  // The one AI Trader agent (migration 0263, DUR-5026). It may ask for a
  // top-up of a code-held trading wallet and nothing else; it can never own
  // a wallet, and an agent that owns one cannot be named here.
  traderAgentId: uuid("trader_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cryptoWallets = pgTable(
  "crypto_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Null once the agent is gone or the owner took the wallet away from it;
    // the owner can still send the funds back out (to an allowed address).
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    chain: text("chain").notNull(),
    network: text("network").notNull().default("testnet"),
    // Which Bitcoin test network ('testnet4' | 'signet'); set only on Bitcoin
    // test wallets. Fixed at creation: a trigger refuses any later change.
    networkVariant: text("network_variant"),
    // EVM chain the wallet signs on; set only on Ethereum test wallets, from
    // the code allow-list. Fixed at creation (same trigger).
    evmChainId: integer("evm_chain_id"),
    address: text("address").notNull(),
    // The only pointer to the key. NO ACTION: the secret row cannot be
    // deleted while a wallet points at it (checked at the end of the
    // statement, so deleting a whole company still cascades cleanly).
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "no action" }),
    keyOrigin: text("key_origin").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull().default("active"),
    frozenReason: text("frozen_reason"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    perTransactionLimit: numeric("per_transaction_limit", { precision: 78, scale: 0 }).notNull(),
    dailyLimit: numeric("daily_limit", { precision: 78, scale: 0 }).notNull(),
    totalLimit: numeric("total_limit", { precision: 78, scale: 0 }).notNull(),
    // Null = every send needs approval.
    approvalAbove: numeric("approval_above", { precision: 78, scale: 0 }),
    maxLeverage: integer("max_leverage").notNull().default(1),
    lastBalance: numeric("last_balance", { precision: 78, scale: 0 }),
    lastBalanceAt: timestamp("last_balance_at", { withTimezone: true }),
    // Migration 0263 (DUR-5026): who holds the wallet. 'agent' = an agent's
    // tools use it (agent_id set). 'trading_routine' = held by Paperclip's
    // own trading code: agent_id is always null, no agent can ever use it,
    // and it exists on test networks only (CHECK below).
    holder: text("holder").notNull().default("agent"),
    // Hard limits and flows of a trading-routine wallet, in the wallet's own
    // coin (base units). Null on agent wallets. per_transaction_limit is the
    // max per trade, daily_limit the max traded per day.
    maxBalance: numeric("max_balance", { precision: 78, scale: 0 }),
    dailyLossStop: numeric("daily_loss_stop", { precision: 78, scale: 0 }),
    sweepThreshold: numeric("sweep_threshold", { precision: 78, scale: 0 }),
    topUpFloor: numeric("top_up_floor", { precision: 78, scale: 0 }),
    topUpTarget: numeric("top_up_target", { precision: 78, scale: 0 }),
    // The approved cold-wallet address profit is swept to; null = no sweep.
    sweepAddress: text("sweep_address"),
    sweepAddressApprovedAt: timestamp("sweep_address_approved_at", { withTimezone: true }),
    // A new address waiting on its owner approval card; it is never used until approved.
    pendingSweepAddress: text("pending_sweep_address"),
    pendingSweepApprovalId: uuid("pending_sweep_approval_id"),
    // The open "please top up" card, if any (one at a time per wallet).
    topUpApprovalId: uuid("top_up_approval_id"),
    // Daily loss tracking: the UTC day and the day's highest balance, with
    // the wallet's own sweeps/sends added back so they never count as a loss.
    lossDay: date("loss_day", { mode: "string" }),
    lossDayPeak: numeric("loss_day_peak", { precision: 78, scale: 0 }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("crypto_wallets_company_agent_idx").on(table.companyId, table.agentId),
    companyAddressUq: uniqueIndex("crypto_wallets_company_chain_network_address_uq").on(table.companyId, table.chain, table.network, table.address),
    chainCheck: check("crypto_wallets_chain_check", sql`${table.chain} IN ('bitcoin', 'ethereum', 'solana', 'hyperliquid')`),
    networkCheck: check("crypto_wallets_network_check", sql`${table.network} IN ('testnet', 'mainnet')`),
    networkVariantCheck: check(
      "crypto_wallets_network_variant_check",
      sql`(${table.chain} = 'bitcoin' AND ${table.network} = 'testnet') = (${table.networkVariant} IS NOT NULL) AND (${table.networkVariant} IS NULL OR ${table.networkVariant} IN ('testnet4', 'signet'))`,
    ),
    evmChainIdCheck: check(
      "crypto_wallets_evm_chain_id_check",
      sql`(${table.chain} = 'ethereum' AND ${table.network} = 'testnet') = (${table.evmChainId} IS NOT NULL) AND (${table.evmChainId} IS NULL OR ${table.evmChainId} > 0)`,
    ),
    statusCheck: check("crypto_wallets_status_check", sql`${table.status} IN ('active', 'frozen', 'archived')`),
    keyOriginCheck: check("crypto_wallets_key_origin_check", sql`${table.keyOrigin} IN ('generated', 'imported')`),
    leverageCheck: check("crypto_wallets_max_leverage_check", sql`${table.maxLeverage} >= 1 AND ${table.maxLeverage} <= 5`),
    limitsCheck: check(
      "crypto_wallets_limits_check",
      sql`${table.perTransactionLimit} >= 0 AND ${table.dailyLimit} >= 0 AND ${table.totalLimit} >= 0 AND (${table.approvalAbove} IS NULL OR ${table.approvalAbove} >= 0)`,
    ),
    holderCheck: check("crypto_wallets_holder_check", sql`${table.holder} IN ('agent', 'trading_routine')`),
    // A code-held wallet belongs to no agent, is test-network only and
    // always carries its two hard stops. The database refuses anything else.
    routineShapeCheck: check(
      "crypto_wallets_routine_shape_check",
      sql`${table.holder} = 'agent' OR (${table.agentId} IS NULL AND ${table.network} = 'testnet' AND ${table.maxBalance} IS NOT NULL AND ${table.dailyLossStop} IS NOT NULL)`,
    ),
    routineAmountsCheck: check(
      "crypto_wallets_routine_amounts_check",
      sql`(${table.maxBalance} IS NULL OR ${table.maxBalance} >= 0) AND (${table.dailyLossStop} IS NULL OR ${table.dailyLossStop} >= 0) AND (${table.sweepThreshold} IS NULL OR ${table.sweepThreshold} >= 0) AND (${table.topUpFloor} IS NULL OR ${table.topUpFloor} >= 0) AND (${table.topUpTarget} IS NULL OR ${table.topUpTarget} >= 0)`,
    ),
  }),
);

export const cryptoWalletDestinations = pgTable(
  "crypto_wallet_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id").notNull().references(() => cryptoWallets.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    label: text("label").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    walletAddressUq: uniqueIndex("crypto_wallet_destinations_wallet_address_uq").on(table.walletId, table.address),
  }),
);

export const cryptoAgentLimits = pgTable(
  "crypto_agent_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    perTransactionUsd: doublePrecision("per_transaction_usd").notNull(),
    dailyUsd: doublePrecision("daily_usd").notNull(),
    totalUsd: doublePrecision("total_usd").notNull(),
    approvalAboveUsd: doublePrecision("approval_above_usd"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUq: uniqueIndex("crypto_agent_limits_agent_uq").on(table.agentId),
    positiveCheck: check(
      "crypto_agent_limits_positive_check",
      sql`${table.perTransactionUsd} > 0 AND ${table.dailyUsd} > 0 AND ${table.totalUsd} > 0`,
    ),
  }),
);

export const cryptoWalletTransactions = pgTable(
  "crypto_wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id").notNull().references(() => cryptoWallets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    initiatedBy: text("initiated_by").notNull(),
    initiatedByUserId: text("initiated_by_user_id"),
    kind: text("kind").notNull(),
    chain: text("chain").notNull(),
    network: text("network").notNull(),
    asset: text("asset").notNull(),
    destination: text("destination"),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    amountUsd: doublePrecision("amount_usd"),
    // False for owner sends and reduce-only Hyperliquid orders (closing a
    // position must never be blocked by a spending limit).
    countsTowardLimits: boolean("counts_toward_limits").notNull().default(true),
    // Highest network fee this payment could cost (exact for Bitcoin and
    // Solana, gas limit x max fee for Ethereum) -- used by the balance check.
    feeUpperBound: numeric("fee_upper_bound", { precision: 78, scale: 0 }),
    orderDetail: jsonb("order_detail"),
    purpose: text("purpose").notNull(),
    // Migration 0263 (DUR-5026): what the trading routine was doing when it
    // initiated this (initiated_by 'routine'): a profit sweep or a trade.
    routineAction: text("routine_action"),
    status: text("status").notNull(),
    blockReason: text("block_reason"),
    approvalId: uuid("approval_id"),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    txHash: text("tx_hash"),
    // The signed transaction, saved before the first broadcast. A signed
    // transaction is public once sent and holds no key. Any later retry
    // re-sends exactly these bytes, never a newly signed payment, so a
    // payment whose first send got no clear answer can never land twice.
    signedRaw: text("signed_raw"),
    // What the network check needs to decide a payment is truly dead:
    // Ethereum nonce, Bitcoin inputs, Solana signing time, and so on.
    chainDetail: jsonb("chain_detail"),
    lastBroadcastAt: timestamp("last_broadcast_at", { withTimezone: true }),
    error: text("error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    walletIdx: index("crypto_wallet_transactions_wallet_idx").on(table.walletId, table.createdAt),
    agentIdx: index("crypto_wallet_transactions_agent_idx").on(table.agentId, table.createdAt),
    statusIdx: index("crypto_wallet_transactions_status_idx").on(table.status),
    initiatedByCheck: check("crypto_wallet_transactions_initiated_by_check", sql`${table.initiatedBy} IN ('agent', 'owner', 'routine')`),
    routineActionCheck: check("crypto_wallet_transactions_routine_action_check", sql`${table.routineAction} IS NULL OR ${table.routineAction} IN ('sweep', 'trade')`),
    kindCheck: check("crypto_wallet_transactions_kind_check", sql`${table.kind} IN ('send', 'order')`),
    statusCheck: check(
      "crypto_wallet_transactions_status_check",
      sql`${table.status} IN ('blocked', 'pending_approval', 'approved', 'submitted', 'confirmed', 'failed', 'rejected', 'expired_approval')`,
    ),
    amountCheck: check("crypto_wallet_transactions_amount_check", sql`${table.amount} >= 0`),
  }),
);

/**
 * Trading alerts (migration 0263, DUR-5026): the outbox the Telegram bridge
 * polls for the trading routine's safety stops and top-up / sweep notices.
 * Same lifecycle as watcher_alerts and payment_notices: written `ready` by the
 * server, delivered and acknowledged by the bridge, expired after a day.
 * `kind` is a plain label (not a CHECK) so later alert kinds need no migration.
 */
export const tradingAlerts = pgTable(
  "trading_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id").references(() => cryptoWallets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("ready"),
    text: text("text").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("trading_alerts_company_status_idx").on(table.companyId, table.status, table.createdAt),
    statusCheck: check("trading_alerts_status_check", sql`${table.status} IN ('ready', 'delivered', 'failed', 'expired')`),
  }),
);
