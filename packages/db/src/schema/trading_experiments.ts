import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tradingStrategies, tradingStrategyVersions } from "./trading.js";

/**
 * DUR-5018 (migration 0272): the experiment runner.
 *
 * One row per experiment: a small, capped parameter grid on one strategy
 * version, run walk-forward on past data (never reading the holdout). The
 * worker writes the result once; a trigger makes a finished row final. The
 * result is a recommended variant or "no change" and is never applied: the
 * Trader's proposal route is its only reader, and it refuses a proposal that
 * does not cite a finished experiment that recommended exactly those rules.
 *
 * `trials` (digest, label, per-bar out-of-sample Sharpe of each variant) feeds
 * the lineage trial registry, so the Deflated Sharpe ratio of every later test
 * counts the variants an experiment tried. Company-scoped (RLS in both lists
 * of 0164). Rollback: see 0272_trading_experiments.sql.
 */
export const tradingExperiments = pgTable(
  "trading_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    strategyId: uuid("strategy_id").notNull().references(() => tradingStrategies.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => tradingStrategyVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    specDigest: text("spec_digest").notNull(),
    /** The template the strategy came from, if any; the lineage the trial registry counts across. */
    templateKey: text("template_key"),
    /** Everything that decides the result: as-of time, source, costs, canonical grid, seed. A rerun with the same params gives the same result digest. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    report: jsonb("report").$type<Record<string, unknown>>(),
    /** [{ digest, label, oosSharpe, observations }] for every variant of this experiment. */
    trials: jsonb("trials").$type<Array<Record<string, unknown>>>(),
    /** Variants this experiment tried ("your rules as written" included). */
    trialCount: integer("trial_count").notNull().default(0),
    /** Distinct variants ever tried in the lineage when it finished, this experiment's included. */
    registryTrialCount: integer("registry_trial_count"),
    /** Deflated Sharpe probability of the recommended variant (or of the best variant when there is no change). */
    deflatedSharpe: doublePrecision("deflated_sharpe"),
    plateau: jsonb("plateau").$type<Record<string, unknown>>(),
    /** Holdout reads already made in the lineage when it ran. An experiment makes none itself. */
    holdoutReadsLineage: integer("holdout_reads_lineage"),
    recommendation: jsonb("recommendation").$type<Record<string, unknown>>(),
    recommendedVariantDigest: text("recommended_variant_digest"),
    recommendedSpec: jsonb("recommended_spec").$type<Record<string, unknown>>(),
    /** SHA-256 of the canonical report: two runs with the same params must have the same digest. */
    resultDigest: text("result_digest"),
    error: text("error"),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("trading_experiments_company_idx").on(table.companyId),
    strategyIdx: index("trading_experiments_strategy_idx").on(table.strategyId, table.createdAt),
    queueIdx: index("trading_experiments_queue_idx").on(table.status, table.createdAt).where(sql`${table.status} IN ('queued', 'running')`),
    oneActivePerVersionUq: uniqueIndex("trading_experiments_one_active_per_version_uq").on(table.versionId).where(sql`${table.status} IN ('queued', 'running')`),
    statusCheck: check("trading_experiments_status_check", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
    requesterCheck: check("trading_experiments_requester_check", sql`${table.requestedByType} IN ('user', 'agent', 'system')`),
    digestCheck: check("trading_experiments_digest_check", sql`${table.specDigest} ~ '^[0-9a-f]{64}$'`),
    recommendedDigestCheck: check("trading_experiments_recommended_digest_check", sql`${table.recommendedVariantDigest} IS NULL OR ${table.recommendedVariantDigest} ~ '^[0-9a-f]{64}$'`),
    // A recommendation exists only on a succeeded experiment, and its spec travels with its digest.
    recommendedOnlyWhenSucceededCheck: check(
      "trading_experiments_recommended_check",
      sql`(${table.recommendedVariantDigest} IS NULL AND ${table.recommendedSpec} IS NULL) OR (${table.status} = 'succeeded' AND ${table.recommendedVariantDigest} IS NOT NULL AND ${table.recommendedSpec} IS NOT NULL)`,
    ),
  }),
);
