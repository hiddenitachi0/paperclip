import { sql } from "drizzle-orm";
import { bigint, boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tradingStrategies } from "./trading.js";

/**
 * The prediction ledger (DUR-5010, migration 0267). Every call a forecaster
 * makes is written BEFORE its outcome is known and resolved exactly once from
 * closed candles. The database protects the rows (trigger
 * trading_predictions_guard): decided_at is the server's clock, the data a call
 * used ends before it was made, forecast columns never change, the outcome is
 * written once and no earlier than resolves_at. DELETE stays possible so the
 * company and strategy cascades work; every foreign key is ON DELETE CASCADE
 * (SET NULL would be an UPDATE of a forecast column). App code has no delete
 * path.
 *
 * Retention: kept for as long as the strategy exists; nothing prunes it.
 * Rollback is in the header of the migration.
 */
export const tradingPredictions = pgTable(
  "trading_predictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    specVersion: integer("spec_version").notNull(),
    forecasterKind: text("forecaster_kind").notNull(),
    forecasterKey: text("forecaster_key").notNull(),
    asset: text("asset").notNull(),
    timeframe: text("timeframe").notNull(),
    barCloseAt: timestamp("bar_close_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    dataCutoffAt: timestamp("data_cutoff_at", { withTimezone: true }).notNull(),
    horizonBars: integer("horizon_bars").notNull(),
    resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("direction"),
    direction: text("direction").notNull(),
    /** Only for forecasters with real probabilities (a model, the AI, or a rule fitted out-of-sample). */
    probability: doublePrecision("probability"),
    probabilitySource: text("probability_source"),
    referencePrice: doublePrecision("reference_price").notNull(),
    targetPrice: doublePrecision("target_price"),
    stopPrice: doublePrecision("stop_price"),
    /** The version's flat band, copied here so a row is self-contained. */
    flatBandPct: doublePrecision("flat_band_pct").notNull(),
    /** The R unit in price terms at decision time: the stop distance, or 1 ATR(14). */
    rDistance: doublePrecision("r_distance"),
    regime: jsonb("regime").$type<Record<string, unknown> | null>(),
    indicatorSnapshot: jsonb("indicator_snapshot").$type<Record<string, unknown> | null>(),
    // Outcome: written once, together, by the resolver.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    outcome: text("outcome"),
    realizedReturn: doublePrecision("realized_return"),
    mfe: doublePrecision("mfe"),
    mae: doublePrecision("mae"),
    resolverVersion: integer("resolver_version"),
    independent: boolean("independent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    onePerBar: uniqueIndex("trading_predictions_one_per_bar_uq").on(table.forecasterKey, table.strategyId, table.specVersion, table.asset, table.barCloseAt),
    seriesIdx: index("trading_predictions_series_idx").on(table.strategyId, table.specVersion, table.forecasterKey, table.barCloseAt),
    unresolvedIdx: index("trading_predictions_unresolved_idx").on(table.resolvesAt).where(sql`${table.resolvedAt} IS NULL`),
    companyIdx: index("trading_predictions_company_idx").on(table.companyId, table.barCloseAt),
    kindCheck: check("trading_predictions_kind_check", sql`${table.forecasterKind} IN ('rule', 'shadow_template', 'baseline', 'model', 'llm')`),
    typeCheck: check("trading_predictions_type_check", sql`${table.kind} IN ('direction', 'target_before_stop')`),
    directionCheck: check("trading_predictions_direction_check", sql`${table.direction} IN ('up', 'down', 'flat')`),
    outcomeCheck: check("trading_predictions_outcome_check", sql`${table.outcome} IS NULL OR ${table.outcome} IN ('hit', 'miss', 'flat', 'void')`),
    probabilityCheck: check(
      "trading_predictions_probability_check",
      sql`(${table.probability} IS NULL) = (${table.probabilitySource} IS NULL) AND (${table.probability} IS NULL OR (${table.probability} >= 0 AND ${table.probability} <= 1)) AND (${table.probabilitySource} IS NULL OR ${table.probabilitySource} IN ('model', 'llm', 'fitted_out_of_sample'))`,
    ),
    horizonCheck: check("trading_predictions_horizon_check", sql`${table.horizonBars} >= 1 AND ${table.specVersion} >= 1`),
    priceCheck: check("trading_predictions_price_check", sql`${table.referencePrice} > 0 AND ${table.flatBandPct} >= 0 AND (${table.rDistance} IS NULL OR ${table.rDistance} > 0)`),
    cutoffCheck: check("trading_predictions_cutoff_check", sql`${table.dataCutoffAt} <= ${table.barCloseAt} AND ${table.dataCutoffAt} < ${table.decidedAt}`),
    beforeOutcomeCheck: check("trading_predictions_before_outcome_check", sql`${table.barCloseAt} < ${table.resolvesAt} AND ${table.decidedAt} < ${table.resolvesAt}`),
    resolutionPairCheck: check(
      "trading_predictions_resolution_pair_check",
      sql`(${table.resolvedAt} IS NULL) = (${table.outcome} IS NULL) AND (${table.resolvedAt} IS NULL) = (${table.resolverVersion} IS NULL)`,
    ),
  }),
);

/**
 * One verdict per (strategy, version, forecaster), insert-only. The database
 * refuses the insert before the planned sample size and the minimum test
 * period are reached; until a row exists the status is 'collecting'.
 */
export const tradingPredictionVerdicts = pgTable(
  "trading_prediction_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    specVersion: integer("spec_version").notNull(),
    forecasterKey: text("forecaster_key").notNull(),
    targetSamples: integer("target_samples").notNull(),
    minRunningDays: integer("min_running_days").notNull(),
    samplesCounted: integer("samples_counted").notNull(),
    runningMs: bigint("running_ms", { mode: "number" }).notNull(),
    calendarMs: bigint("calendar_ms", { mode: "number" }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    verdict: jsonb("verdict").$type<Record<string, unknown>>().notNull(),
  },
  (table) => ({
    onceIdx: uniqueIndex("trading_prediction_verdicts_once_uq").on(table.strategyId, table.specVersion, table.forecasterKey),
    companyIdx: index("trading_prediction_verdicts_company_idx").on(table.companyId),
    targetCheck: check("trading_prediction_verdicts_target_check", sql`${table.targetSamples} >= 1 AND ${table.minRunningDays} >= 0`),
    reachedCheck: check(
      "trading_prediction_verdicts_reached_check",
      sql`${table.samplesCounted} >= ${table.targetSamples} AND ${table.runningMs} >= ${table.minRunningDays}::bigint * 86400000 AND ${table.runningMs} <= ${table.calendarMs}`,
    ),
  }),
);

/**
 * The evaluator's single heartbeat row (instance-wide, no company data). A boot
 * reads it, writes a gap event for the time since, and starts again.
 */
export const tradingEvaluatorState = pgTable(
  "trading_evaluator_state",
  {
    id: text("id").primaryKey().default("evaluator"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
    bootAt: timestamp("boot_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonCheck: check("trading_evaluator_state_singleton_check", sql`${table.id} = 'evaluator'`),
  }),
);
