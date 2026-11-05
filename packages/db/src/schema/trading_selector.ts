import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-5015 (migration 0273): the shadow tournament and the strategy selector.
 *
 *   * trading_selector_rules: the selector's rules, one immutable row per
 *     version, written before any shadow result exists. Instance-wide (no
 *     company_id), like the eligibility matrix; only the bypass login writes.
 *   * trading_shadow_cells: the trial registry. One row per
 *     (template version x weather x coin) per company the first time a shadow
 *     trade lands in it. The count of rows is the number of tests the
 *     false-discovery control has to pay for.
 *   * trading_shadow_trades: the simulated trades. A shadow run places no order,
 *     touches no paper cash, files no card; it only writes here. A closed row is
 *     final (trigger).
 *   * trading_selector_decisions: one immutable row per company per monthly
 *     checkpoint: what the selector saw (state_before), what it decided
 *     (output) and digests of both, so the decision can be recomputed from the
 *     stored shadow trades and compared.
 *   * trading_selector_confirmations: the fresh confirmation windows and which
 *     cells hold paper cash.
 *
 * Company-scoped except the rules (RLS in both lists of 0164 for the rest).
 * Rollback: see 0273_trading_shadow_selector.sql.
 */
export const tradingSelectorRules = pgTable(
  "trading_selector_rules",
  {
    version: integer("version").primaryKey(),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the canonical rules; app-computed. */
    digest: text("digest").notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionCheck: check("trading_selector_rules_version_check", sql`${table.version} >= 1`),
    digestCheck: check("trading_selector_rules_digest_check", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const tradingShadowCells = pgTable(
  "trading_shadow_cells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull(),
    family: text("family").notNull(),
    /** One of the eligibility matrix columns: up, range, down, squeeze, high_volatility. */
    weather: text("weather").notNull(),
    asset: text("asset").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cellUq: uniqueIndex("trading_shadow_cells_cell_uq").on(table.companyId, table.templateKey, table.templateVersion, table.weather, table.asset),
    companyIdx: index("trading_shadow_cells_company_idx").on(table.companyId),
    weatherCheck: check("trading_shadow_cells_weather_check", sql`${table.weather} IN ('up', 'range', 'down', 'squeeze', 'high_volatility')`),
    versionCheck: check("trading_shadow_cells_version_check", sql`${table.templateVersion} >= 1`),
  }),
);

export const tradingShadowTrades = pgTable(
  "trading_shadow_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    cellId: uuid("cell_id").notNull().references(() => tradingShadowCells.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull(),
    asset: text("asset").notNull(),
    timeframe: text("timeframe").notNull(),
    weather: text("weather").notNull(),
    /** Close of the bar the template said "enter" on. The simulated fill is the next open. */
    signalBarCloseAt: timestamp("signal_bar_close_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    /** The market-weather label the cell was chosen by (day, trend, volatility, squeeze, rules version). */
    weatherLabel: jsonb("weather_label").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("open"),
    /** Newest closed bar the resolver has already looked at; it only runs again when a newer one exists. */
    lastCheckedBarAt: timestamp("last_checked_bar_at", { withTimezone: true }),
    // Outcome: written once, together, when the trade closes.
    entryAt: timestamp("entry_at", { withTimezone: true }),
    exitAt: timestamp("exit_at", { withTimezone: true }),
    entryPrice: doublePrecision("entry_price"),
    exitPrice: doublePrecision("exit_price"),
    exitReason: text("exit_reason"),
    barsHeld: integer("bars_held"),
    /** Net result in R at the paper fee (0.40% per side) and at double the fee (the gate). Null when the risk could not be measured. */
    r1x: doublePrecision("r_1x"),
    r2x: doublePrecision("r_2x"),
    netReturn1x: doublePrecision("net_return_1x"),
    netReturn2x: doublePrecision("net_return_2x"),
    voidReason: text("void_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    engineVersion: integer("engine_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    onePerBarUq: uniqueIndex("trading_shadow_trades_one_per_bar_uq").on(table.companyId, table.templateKey, table.templateVersion, table.asset, table.signalBarCloseAt),
    // One position at a time per (template, coin): trades of a cell never overlap, which is what makes them independent.
    oneOpenUq: uniqueIndex("trading_shadow_trades_one_open_uq").on(table.companyId, table.templateKey, table.templateVersion, table.asset).where(sql`${table.status} = 'open'`),
    cellIdx: index("trading_shadow_trades_cell_idx").on(table.cellId, table.exitAt),
    openIdx: index("trading_shadow_trades_open_idx").on(table.asset, table.timeframe).where(sql`${table.status} = 'open'`),
    companyIdx: index("trading_shadow_trades_company_idx").on(table.companyId, table.signalBarCloseAt),
    statusCheck: check("trading_shadow_trades_status_check", sql`${table.status} IN ('open', 'closed', 'void')`),
    weatherCheck: check("trading_shadow_trades_weather_check", sql`${table.weather} IN ('up', 'range', 'down', 'squeeze', 'high_volatility')`),
    closedCheck: check(
      "trading_shadow_trades_closed_check",
      sql`(${table.status} = 'closed' AND ${table.entryAt} IS NOT NULL AND ${table.exitAt} IS NOT NULL AND ${table.entryPrice} IS NOT NULL AND ${table.exitPrice} IS NOT NULL AND ${table.exitReason} IS NOT NULL AND ${table.netReturn1x} IS NOT NULL AND ${table.netReturn2x} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.exitAt} >= ${table.entryAt} AND ${table.entryAt} >= ${table.signalBarCloseAt})
        OR (${table.status} = 'void' AND ${table.voidReason} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.entryAt} IS NULL AND ${table.exitAt} IS NULL AND ${table.r1x} IS NULL AND ${table.r2x} IS NULL)
        OR (${table.status} = 'open' AND ${table.entryAt} IS NULL AND ${table.exitAt} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.r1x} IS NULL AND ${table.r2x} IS NULL)`,
    ),
  }),
);

export const tradingSelectorDecisions = pgTable(
  "trading_selector_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The fixed monthly checkpoint (00:00 UTC on the 1st) this decision belongs to. */
    checkpointAt: timestamp("checkpoint_at", { withTimezone: true }).notNull(),
    rulesVersion: integer("rules_version").notNull().references(() => tradingSelectorRules.version),
    rulesDigest: text("rules_digest").notNull(),
    /** Shadow trades closed by this time (resolved_at <= decided_at, exit_at <= checkpoint_at) are what the decision saw. */
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    /** Confirmation windows and the last drawdown stop as they stood going in. */
    stateBefore: jsonb("state_before").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    inputDigest: text("input_digest").notNull(),
    outputDigest: text("output_digest").notNull(),
    choice: text("choice").notNull(),
    trials: integer("trials").notNull(),
    tested: integer("tested").notNull(),
    discoveries: integer("discoveries").notNull(),
    reason: text("reason").notNull(),
    /** The selector has no way to change a risk cap; the database refuses anything but false. */
    riskCapsChanged: boolean("risk_caps_changed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    onePerCheckpointUq: uniqueIndex("trading_selector_decisions_checkpoint_uq").on(table.companyId, table.checkpointAt),
    companyIdx: index("trading_selector_decisions_company_idx").on(table.companyId, table.checkpointAt),
    choiceCheck: check("trading_selector_decisions_choice_check", sql`${table.choice} IN ('cash', 'cells')`),
    riskCheck: check("trading_selector_decisions_risk_check", sql`${table.riskCapsChanged} = false`),
    digestCheck: check("trading_selector_decisions_digest_check", sql`${table.rulesDigest} ~ '^[0-9a-f]{64}$' AND ${table.inputDigest} ~ '^[0-9a-f]{64}$' AND ${table.outputDigest} ~ '^[0-9a-f]{64}$'`),
    countsCheck: check("trading_selector_decisions_counts_check", sql`${table.trials} >= 0 AND ${table.tested} >= 0 AND ${table.tested} <= ${table.trials} AND ${table.discoveries} >= 0`),
  }),
);

export const tradingSelectorConfirmations = pgTable(
  "trading_selector_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    cellId: uuid("cell_id").notNull().references(() => tradingShadowCells.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    /** The checkpoint that opened the window. Only trades entered at or after it count. */
    openedCheckpointAt: timestamp("opened_checkpoint_at", { withTimezone: true }).notNull(),
    openedDecisionId: uuid("opened_decision_id").notNull().references(() => tradingSelectorDecisions.id, { onDelete: "cascade" }),
    endedCheckpointAt: timestamp("ended_checkpoint_at", { withTimezone: true }),
    endedDecisionId: uuid("ended_decision_id").references(() => tradingSelectorDecisions.id, { onDelete: "cascade" }),
    /** The cell holds paper cash right now. */
    promoted: boolean("promoted").notNull().default(false),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    demotedAt: timestamp("demoted_at", { withTimezone: true }),
    windowTrades: integer("window_trades").notNull().default(0),
    windowMeanR: doublePrecision("window_mean_r"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneLivePerCellUq: uniqueIndex("trading_selector_confirmations_one_live_uq").on(table.cellId).where(sql`${table.status} IN ('running', 'passed')`),
    companyIdx: index("trading_selector_confirmations_company_idx").on(table.companyId, table.status),
    statusCheck: check("trading_selector_confirmations_status_check", sql`${table.status} IN ('running', 'passed', 'failed', 'expired')`),
    promotedCheck: check("trading_selector_confirmations_promoted_check", sql`${table.promoted} = false OR ${table.status} = 'passed'`),
  }),
);
