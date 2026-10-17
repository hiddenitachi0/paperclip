import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("crypto_wallets_company_agent_idx").on(table.companyId, table.agentId),
    companyAddressUq: uniqueIndex("crypto_wallets_company_chain_network_address_uq").on(table.companyId, table.chain, table.network, table.address),
    chainCheck: check("crypto_wallets_chain_check", sql`${table.chain} IN ('bitcoin', 'ethereum', 'solana', 'hyperliquid')`),
    networkCheck: check("crypto_wallets_network_check", sql`${table.network} IN ('testnet', 'mainnet')`),
    statusCheck: check("crypto_wallets_status_check", sql`${table.status} IN ('active', 'frozen', 'archived')`),
    keyOriginCheck: check("crypto_wallets_key_origin_check", sql`${table.keyOrigin} IN ('generated', 'imported')`),
    leverageCheck: check("crypto_wallets_max_leverage_check", sql`${table.maxLeverage} >= 1 AND ${table.maxLeverage} <= 5`),
    limitsCheck: check(
      "crypto_wallets_limits_check",
      sql`${table.perTransactionLimit} >= 0 AND ${table.dailyLimit} >= 0 AND ${table.totalLimit} >= 0 AND (${table.approvalAbove} IS NULL OR ${table.approvalAbove} >= 0)`,
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
    initiatedByCheck: check("crypto_wallet_transactions_initiated_by_check", sql`${table.initiatedBy} IN ('agent', 'owner')`),
    kindCheck: check("crypto_wallet_transactions_kind_check", sql`${table.kind} IN ('send', 'order')`),
    statusCheck: check(
      "crypto_wallet_transactions_status_check",
      sql`${table.status} IN ('blocked', 'pending_approval', 'approved', 'submitted', 'confirmed', 'failed', 'rejected', 'expired_approval')`,
    ),
    amountCheck: check("crypto_wallet_transactions_amount_check", sql`${table.amount} >= 0`),
  }),
);
