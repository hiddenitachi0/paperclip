import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * DUR-5014 (migration 0271): the strategy template library's stored facts.
 *
 *   * trading_eligibility_matrices: the weather eligibility matrix, one
 *     immutable row per version (plan section 7: "written in advance and
 *     versioned"). A change is a new version, never an edit.
 *   * trading_template_reports: the stored past-data report of one template
 *     version, built by the DUR-5008 runner at 1x and 2x fees. The report is the
 *     template's own gate run, so it reads the holdout; those reads (and the
 *     variants it tried, in trading_template_trials) count toward the lineage of
 *     every strategy created from the template.
 *   * trading_template_trials: the variants a template's report tried.
 *
 * Instance-wide, no company_id: this is the library, not company data (the API
 * is instance-admin-only until the legal check of decision 19). So the tables
 * are in the login-role list of 0164_rls_login_roles.sql and carry no RLS
 * policy. The scoped role may only SELECT; only the bypass login (boot seeding
 * and the report worker) writes.
 *
 * Also adds trading_strategies.template_key / template_version: the template a
 * strategy was created from, written once at creation.
 *
 * Rollback: see 0271_trading_template_library.sql.
 */
export const tradingEligibilityMatrices = pgTable(
  "trading_eligibility_matrices",
  {
    version: integer("version").primaryKey(),
    matrix: jsonb("matrix").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the canonical matrix; app-computed. */
    digest: text("digest").notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionCheck: check("trading_eligibility_matrices_version_check", sql`${table.version} >= 1`),
    digestCheck: check("trading_eligibility_matrices_digest_check", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const TRADING_TEMPLATE_REPORT_STATUSES_DB = ["queued", "running", "succeeded", "failed", "not_testable"] as const;

export const tradingTemplateReports = pgTable(
  "trading_template_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull(),
    /** Digest of the template's spec when the report was queued; the report belongs to exactly these rules. */
    specDigest: text("spec_digest").notNull(),
    matrixVersion: integer("matrix_version").notNull().references(() => tradingEligibilityMatrices.version),
    status: text("status").notNull().default("queued"),
    /** As-of time, source, costs, fee multiples, variants, seed: a rerun with the same params gives the same report. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    report: jsonb("report").$type<Record<string, unknown>>(),
    gate: jsonb("gate").$type<Record<string, unknown>>(),
    gatePassed: boolean("gate_passed"),
    resultDigest: text("result_digest"),
    variantsTried: integer("variants_tried").notNull().default(0),
    /** Why a template could not be tested (no stored candles, data it needs is missing) or why the run failed. */
    error: text("error"),
    /** The holdout stretch this report read; all three null when it read none. */
    holdoutStart: timestamp("holdout_start", { withTimezone: true }),
    holdoutEnd: timestamp("holdout_end", { withTimezone: true }),
    holdoutSeenCount: integer("holdout_seen_count"),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    templateIdx: index("trading_template_reports_template_idx").on(table.templateKey, table.templateVersion, table.createdAt),
    oneActiveUq: uniqueIndex("trading_template_reports_one_active_uq").on(table.templateKey, table.templateVersion).where(sql`${table.status} IN ('queued', 'running')`),
    holdoutIdx: index("trading_template_reports_holdout_idx").on(table.templateKey).where(sql`${table.holdoutStart} IS NOT NULL`),
    statusCheck: check("trading_template_reports_status_check", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'not_testable')`),
    requesterCheck: check("trading_template_reports_requester_check", sql`${table.requestedByType} IN ('user', 'agent', 'system')`),
    digestCheck: check("trading_template_reports_digest_check", sql`${table.specDigest} ~ '^[0-9a-f]{64}$'`),
    gatePassedCheck: check("trading_template_reports_gate_passed_check", sql`${table.gatePassed} IS NULL OR ${table.status} = 'succeeded'`),
    holdoutCheck: check(
      "trading_template_reports_holdout_check",
      sql`(${table.holdoutStart} IS NULL AND ${table.holdoutEnd} IS NULL AND ${table.holdoutSeenCount} IS NULL) OR (${table.holdoutStart} IS NOT NULL AND ${table.holdoutEnd} IS NOT NULL AND ${table.holdoutSeenCount} IS NOT NULL AND ${table.holdoutEnd} > ${table.holdoutStart} AND ${table.holdoutSeenCount} >= 0)`,
    ),
  }),
);

export const tradingTemplateTrials = pgTable(
  "trading_template_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateKey: text("template_key").notNull(),
    reportId: uuid("report_id").notNull().references(() => tradingTemplateReports.id, { onDelete: "cascade" }),
    variantDigest: text("variant_digest").notNull(),
    variantLabel: text("variant_label").notNull(),
    oosSharpe: doublePrecision("oos_sharpe"),
    oosObservations: integer("oos_observations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    variantUq: uniqueIndex("trading_template_trials_variant_uq").on(table.templateKey, table.variantDigest),
    reportIdx: index("trading_template_trials_report_idx").on(table.reportId),
    digestCheck: check("trading_template_trials_digest_check", sql`${table.variantDigest} ~ '^[0-9a-f]{64}$'`),
  }),
);
