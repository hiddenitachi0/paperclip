import { doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4462: one row per (company, provider, day) the daily Fal/Sogni billing
 * reconciliation completed. It is both the "already done today" marker (so the
 * hourly tick calls each provider at most once per day) and the record the
 * owner-notice threshold reads (mismatch_cents, absolute).
 * Fal rows describe the UTC day that was checked (the day before the run);
 * Sogni rows the UTC day of the run. status: confirmed | adjusted (Fal),
 * confirmed | mismatch | baseline (Sogni). No key or response body is stored.
 *
 * Rollback: DROP TABLE "cost_reconciliation_runs", "sogni_balance_snapshots".
 * Nothing references them; the next daily run simply starts over (Sogni loses
 * its baseline and takes a new one).
 *
 * DUR-4458: mismatch_micro_usd/tracked_micro_usd (added in 0220) let the Costs
 * page show Sogni's "tracked vs. provider says" check the same way Fal's is
 * shown, without re-deriving it from cost_events. Rollback: drop the two
 * columns; the owner-notice threshold (mismatch_cents) is unaffected.
 */
export const costReconciliationRuns = pgTable(
  "cost_reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    provider: text("provider").notNull(),
    day: text("day").notNull(),
    status: text("status").notNull(),
    mismatchCents: integer("mismatch_cents").notNull().default(0),
    /** Signed mismatch (provider minus tracked) in micro-USD. Null when the run had nothing to compare (e.g. Sogni baseline). */
    mismatchMicroUsd: doublePrecision("mismatch_micro_usd"),
    /** What Paperclip had tracked for the period this run checked, in micro-USD. Null alongside mismatchMicroUsd. */
    trackedMicroUsd: doublePrecision("tracked_micro_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderDayUq: uniqueIndex("cost_reconciliation_runs_company_provider_day_uq").on(table.companyId, table.provider, table.day),
    companyCreatedIdx: index("cost_reconciliation_runs_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

/** DUR-4462: last observed Sogni Spark balance per company, the "previous balance" the next daily check compares against. */
export const sogniBalanceSnapshots = pgTable(
  "sogni_balance_snapshots",
  {
    companyId: uuid("company_id").primaryKey().references(() => companies.id),
    spark: doublePrecision("spark").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
);

