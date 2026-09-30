import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Trading agent (DUR-4153/DUR-4171, migration 0197): a fixed-rule,
 * paper-trading-only strategy runner. "Code trades, the AI explains" --
 * there is deliberately no agent_id/quick-agent column anywhere in this
 * file: no LLM call sits on the order path, so unlike watchers.ts or
 * mail_secretary.ts there is no persona/trust-level to attach a row to.
 *
 * One strategy currently trades exactly one asset with one deterministic
 * rule (Phase 1 of the design report posted on DUR-4141: "one simple rule").
 * `cash_nok`/`position_quantity` therefore live directly on the strategy row
 * rather than a separate positions table -- trading_fifo_lots is the
 * append-only source of truth for tax cost basis; the strategy row's
 * position_quantity/position_cost_nok are a maintained cache of what those
 * open lots sum to, kept for O(1) reads on the tick's own risk checks and
 * the dashboard.
 *
 * `mode` only ever accepts 'paper' right now (see TRADING_MODES in
 * packages/shared/src/trading.ts) -- this migration leaves room for a later
 * 'live' value, but nothing in this implementation task turns it on.
 *
 * Tables:
 *   * trading_strategies -- one row per configured strategy: its rule and
 *     risk config (both JSON, validated against the hard ceiling in
 *     packages/shared/src/trading.ts before ever being written), its
 *     claim-lock due/lease pair (same shape as watchers.check_lease_until),
 *     and its live paper balances. Starts (and, after any restart, always
 *     returns to) status='paused' -- see status_check below; nothing here
 *     auto-resumes a strategy, that is always an explicit operator action.
 *   * trading_orders -- one row per order attempt (filled, rejected by the
 *     risk gate, or awaiting/missed a trade-approval card), the rule version
 *     that produced it, the signal price and, once filled, the paper fill.
 *   * trading_fifo_lots -- open buy lots consumed oldest-first on a sell, so
 *     every sell's realized P&L and NOK cost basis is a real FIFO
 *     computation, not an average -- required for the Norwegian tax ledger.
 *   * trading_ledger_entries -- append-only: every signal, risk block,
 *     circuit breaker, kill-switch action and fill, so the full decision
 *     history survives independent of trading_orders' own row-per-order
 *     shape (a service function should only ever INSERT here).
 *   * trading_daily_stats -- one row per strategy per UTC day, for the
 *     dashboard's pass/fail and buy-and-hold comparison without re-summing
 *     the full ledger on every request.
 *
 * Strictly additive: five new tables, no row written, no existing row
 * touched. Every statement is guarded so a re-run is a no-op.
 *
 * Rollback: DROP TABLE "trading_daily_stats", "trading_ledger_entries",
 * "trading_fifo_lots", "trading_orders", then "trading_strategies" (that
 * order -- children before the parent they reference). Safe: nothing outside
 * this migration references any of the five tables, so a rollback loses only
 * this feature's own strategies, orders and ledger history.
 */
export const tradingStrategies = pgTable(
  "trading_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    asset: text("asset").notNull(),
    mode: text("mode").notNull().default("paper"),
    // paused -> running <-> halted_risk; every strategy is created paused
    // and a restart forces every running strategy back to paused
    // (pause_reason='restart') -- enforced in server/src/services/trading.ts,
    // not just a UI default, since this is a safety requirement.
    status: text("status").notNull().default("paused"),
    pauseReason: text("pause_reason"),
    checkEveryMinutes: integer("check_every_minutes").notNull().default(15),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    lastTickError: text("last_tick_error"),
    ruleConfig: jsonb("rule_config").notNull(),
    riskConfig: jsonb("risk_config").notNull(),
    startingCashNok: integer("starting_cash_nok").notNull(),
    cashNok: doublePrecision("cash_nok").notNull(),
    positionQuantity: doublePrecision("position_quantity").notNull().default(0),
    positionCostNok: doublePrecision("position_cost_nok").notNull().default(0),
    // Highest total-equity (cash + position value) ever observed, updated
    // each tick -- the denominator for the max-drawdown circuit breaker.
    peakEquityNok: doublePrecision("peak_equity_nok").notNull(),
    // Same "counters keyed by a UTC day string, reset on read" trick as
    // watchers.ts's alertsToday -- see services/trading.ts counters().
    ordersTodayDate: text("orders_today_date"),
    ordersToday: integer("orders_today").notNull().default(0),
    realizedPnlTodayDate: text("realized_pnl_today_date"),
    realizedPnlTodayNok: doublePrecision("realized_pnl_today_nok").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("trading_strategies_company_idx").on(table.companyId, table.createdAt),
    dueIdx: index("trading_strategies_due_idx").on(table.status, table.nextCheckAt),
    modeCheck: check("trading_strategies_mode_check", sql`${table.mode} IN ('paper')`),
    statusCheck: check("trading_strategies_status_check", sql`${table.status} IN ('paused', 'running', 'halted_risk')`),
    pauseReasonCheck: check(
      "trading_strategies_pause_reason_check",
      sql`${table.pauseReason} IS NULL OR ${table.pauseReason} IN ('manual', 'restart', 'daily_loss_limit', 'drawdown_limit', 'circuit_breaker', 'reconciliation_mismatch')`,
    ),
    assetCheck: check(
      "trading_strategies_asset_check",
      sql`${table.asset} IN ('BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'TRX', 'AVAX', 'DOT', 'LINK', 'LTC')`,
    ),
    checkEveryCheck: check("trading_strategies_check_every_minutes_check", sql`${table.checkEveryMinutes} >= 5 AND ${table.checkEveryMinutes} <= 240`),
    startingCashCheck: check("trading_strategies_starting_cash_nok_check", sql`${table.startingCashNok} > 0`),
    positionQuantityCheck: check("trading_strategies_position_quantity_check", sql`${table.positionQuantity} >= 0`),
  }),
);

export const tradingOrders = pgTable(
  "trading_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    side: text("side").notNull(),
    status: text("status").notNull(),
    ruleVersion: text("rule_version").notNull(),
    signalPriceNok: doublePrecision("signal_price_nok").notNull(),
    requestedQuantity: doublePrecision("requested_quantity").notNull(),
    filledQuantity: doublePrecision("filled_quantity"),
    filledPriceNok: doublePrecision("filled_price_nok"),
    feeNok: doublePrecision("fee_nok"),
    realizedPnlNok: doublePrecision("realized_pnl_nok"),
    rejectionReason: text("rejection_reason"),
    // Set when riskConfig.approvalAboveNok is crossed -- the "trade cards
    // must expire in minutes" requirement; resolved through the generic
    // approvals service the same way browser-service.ts's purchase gate
    // does (server/src/services/approvals.ts).
    approvalId: uuid("approval_id"),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    strategyIdx: index("trading_orders_strategy_idx").on(table.strategyId, table.createdAt),
    pendingApprovalIdx: index("trading_orders_pending_approval_idx").on(table.status, table.approvalExpiresAt),
    sideCheck: check("trading_orders_side_check", sql`${table.side} IN ('buy', 'sell')`),
    statusCheck: check(
      "trading_orders_status_check",
      sql`${table.status} IN ('filled', 'rejected', 'pending_approval', 'expired_approval')`,
    ),
    requestedQuantityCheck: check("trading_orders_requested_quantity_check", sql`${table.requestedQuantity} > 0`),
  }),
);

export const tradingFifoLots = pgTable(
  "trading_fifo_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    sourceOrderId: uuid("source_order_id").notNull().references(() => tradingOrders.id, { onDelete: "cascade" }),
    quantityRemaining: doublePrecision("quantity_remaining").notNull(),
    costNokPerUnit: doublePrecision("cost_nok_per_unit").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // FIFO consumption always claims the oldest lot with quantity_remaining >
    // 0 for a strategy, so this is the one index the consume path needs.
    fifoQueueIdx: index("trading_fifo_lots_fifo_queue_idx").on(table.strategyId, table.acquiredAt),
    quantityRemainingCheck: check("trading_fifo_lots_quantity_remaining_check", sql`${table.quantityRemaining} >= 0`),
  }),
);

export const tradingLedgerEntries = pgTable(
  "trading_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => tradingOrders.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    nokValue: doublePrecision("nok_value"),
    feeNok: doublePrecision("fee_nok"),
    fifoCostNok: doublePrecision("fifo_cost_nok"),
    realizedPnlNok: doublePrecision("realized_pnl_nok"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    strategyIdx: index("trading_ledger_entries_strategy_idx").on(table.strategyId, table.createdAt),
    eventTypeCheck: check(
      "trading_ledger_entries_event_type_check",
      sql`${table.eventType} IN ('signal', 'order_filled', 'order_rejected', 'risk_block', 'circuit_breaker', 'kill_switch', 'reconciliation')`,
    ),
  }),
);

export const tradingDailyStats = pgTable(
  "trading_daily_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    /** UTC calendar date, "YYYY-MM-DD". */
    statDate: text("stat_date").notNull(),
    realizedPnlNok: doublePrecision("realized_pnl_nok").notNull().default(0),
    feesNok: doublePrecision("fees_nok").notNull().default(0),
    ordersCount: integer("orders_count").notNull().default(0),
    equityNok: doublePrecision("equity_nok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    strategyDateUq: uniqueIndex("trading_daily_stats_strategy_date_uq").on(table.strategyId, table.statDate),
  }),
);
