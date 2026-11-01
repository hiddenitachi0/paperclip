import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tradingStrategies, tradingStrategyVersions } from "./trading.js";

/**
 * DUR-5008 (migration 0267): the past-data test ("backtest") and its start gate.
 *
 *   * trading_backtest_runs: one row per requested test of one strategy
 *     version. The worker writes the report, the gate verdict and the result
 *     digest once; a trigger makes a finished row final. `gate_passed = true`
 *     is what the start gate in setStatus reads, so it can only be set on a
 *     succeeded 'gate' run and never changes afterwards.
 *   * trading_backtest_trials: the trial registry. One row per distinct
 *     variant ever tried for a strategy (spec digest), so the count of every
 *     variant and the Deflated Sharpe ratio rest on rows nobody can edit.
 *   * trading_backtest_holdout_reads: one row per read of the holdout, with
 *     the strategy and (when there is one) the template it came from, so a
 *     later read can be labelled "holdout already seen k times".
 *   * trading_start_gate_overrides: an owner's written reason for starting a
 *     version that has not passed (decision 7). Append-only.
 *
 * All four are company-scoped (RLS in both lists of 0164). Rollback: see
 * 0267_trading_backtest.sql.
 */
export const TRADING_BACKTEST_RUN_STATUSES_DB = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export const tradingBacktestRuns = pgTable(
  "trading_backtest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => tradingStrategyVersions.id, { onDelete: "cascade" }),
    /** 'explore' never reads the holdout and can never pass the gate; 'gate' reads it (once per lineage stretch). */
    purpose: text("purpose").notNull(),
    status: text("status").notNull().default("queued"),
    /** The version's spec digest when the run was queued; the verdict belongs to exactly these rules. */
    specDigest: text("spec_digest").notNull(),
    /** The template the strategy came from, if any; holdout reads count against it too. */
    templateKey: text("template_key"),
    /** Everything that decides the result: as-of time, source, costs, fee, variants, seed. A rerun with the same params gives the same report. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    report: jsonb("report").$type<Record<string, unknown>>(),
    gate: jsonb("gate").$type<Record<string, unknown>>(),
    gatePassed: boolean("gate_passed"),
    /** SHA-256 of the canonical report: two runs with the same params must have the same digest. */
    resultDigest: text("result_digest"),
    variantsTried: integer("variants_tried").notNull().default(0),
    error: text("error"),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("trading_backtest_runs_company_idx").on(table.companyId),
    strategyIdx: index("trading_backtest_runs_strategy_idx").on(table.strategyId, table.createdAt),
    versionGateIdx: index("trading_backtest_runs_version_gate_idx").on(table.versionId).where(sql`${table.gatePassed} = true`),
    queueIdx: index("trading_backtest_runs_queue_idx").on(table.status, table.createdAt).where(sql`${table.status} IN ('queued', 'running')`),
    oneActivePerVersionUq: uniqueIndex("trading_backtest_runs_one_active_per_version_uq").on(table.versionId, table.purpose).where(sql`${table.status} IN ('queued', 'running')`),
    purposeCheck: check("trading_backtest_runs_purpose_check", sql`${table.purpose} IN ('explore', 'gate')`),
    statusCheck: check("trading_backtest_runs_status_check", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
    requesterCheck: check("trading_backtest_runs_requester_check", sql`${table.requestedByType} IN ('user', 'agent', 'system')`),
    digestCheck: check("trading_backtest_runs_digest_check", sql`${table.specDigest} ~ '^[0-9a-f]{64}$'`),
    // A passing verdict exists only on a finished gate run.
    gatePassedCheck: check("trading_backtest_runs_gate_passed_check", sql`${table.gatePassed} IS NULL OR (${table.purpose} = 'gate' AND ${table.status} = 'succeeded')`),
  }),
);

export const tradingBacktestTrials = pgTable(
  "trading_backtest_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    templateKey: text("template_key"),
    runId: uuid("run_id").notNull().references(() => tradingBacktestRuns.id, { onDelete: "cascade" }),
    /** SHA-256 of the variant's canonical spec: the same variant tried twice is one trial. */
    variantDigest: text("variant_digest").notNull(),
    variantLabel: text("variant_label").notNull(),
    /** Per-bar Sharpe ratio of the variant out of sample at the gate fee multiple (not annualised); the Deflated Sharpe ratio's trial variance reads these. */
    oosSharpe: doublePrecision("oos_sharpe"),
    oosObservations: integer("oos_observations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    variantUq: uniqueIndex("trading_backtest_trials_variant_uq").on(table.companyId, table.strategyId, table.variantDigest),
    runIdx: index("trading_backtest_trials_run_idx").on(table.runId),
    templateIdx: index("trading_backtest_trials_template_idx").on(table.companyId, table.templateKey).where(sql`${table.templateKey} IS NOT NULL`),
    digestCheck: check("trading_backtest_trials_digest_check", sql`${table.variantDigest} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const tradingBacktestHoldoutReads = pgTable(
  "trading_backtest_holdout_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => tradingStrategyVersions.id, { onDelete: "cascade" }),
    templateKey: text("template_key"),
    runId: uuid("run_id").notNull().references(() => tradingBacktestRuns.id, { onDelete: "cascade" }),
    holdoutStart: timestamp("holdout_start", { withTimezone: true }).notNull(),
    holdoutEnd: timestamp("holdout_end", { withTimezone: true }).notNull(),
    /** How many earlier reads of this lineage overlapped this stretch when it was read (0 = a clean read). */
    seenCount: integer("seen_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUq: uniqueIndex("trading_backtest_holdout_reads_run_uq").on(table.runId),
    strategyIdx: index("trading_backtest_holdout_reads_strategy_idx").on(table.companyId, table.strategyId),
    templateIdx: index("trading_backtest_holdout_reads_template_idx").on(table.companyId, table.templateKey).where(sql`${table.templateKey} IS NOT NULL`),
    rangeCheck: check("trading_backtest_holdout_reads_range_check", sql`${table.holdoutEnd} > ${table.holdoutStart} AND ${table.seenCount} >= 0`),
  }),
);

export const tradingStartGateOverrides = pgTable(
  "trading_start_gate_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => tradingStrategyVersions.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    overriddenByUserId: text("overridden_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionUq: uniqueIndex("trading_start_gate_overrides_version_uq").on(table.versionId),
    companyIdx: index("trading_start_gate_overrides_company_idx").on(table.companyId),
    reasonCheck: check("trading_start_gate_overrides_reason_check", sql`char_length(btrim(${table.reason})) >= 10`),
  }),
);
