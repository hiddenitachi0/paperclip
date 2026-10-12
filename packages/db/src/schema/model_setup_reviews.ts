import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * DUR-4558 (child of DUR-4392): one row per model setup reviewer run on one
 * directory entry -- the plain-English report, the capability scores, and the
 * changes the reviewer applied or proposed, each with the before/after state
 * needed for one-click undo.
 *
 * `report`: { summary, scores, findings, probes } (no key, no prompt text).
 * `changes`: [{ id, code, title, why, status: applied|proposed|declined|undone,
 *   before: { settings, ops }, after: { settings, ops }, probesAfter, decidedAt }].
 * `settings` only ever holds defaultThinking / defaultTemperature /
 * defaultMaxOutputTokens, and `ops` is a converter list validated against the
 * fixed allow-list; nothing here can carry a key, address, host restriction or
 * cost limit.
 *
 * Rollback: DROP TABLE "model_setup_reviews". Safe -- nothing references it.
 * It only loses the report/undo history; entries and converters stay as they
 * are.
 */
export const modelSetupReviews = pgTable(
  "model_setup_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").notNull().references(() => modelDirectoryEntries.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull().default("manual"),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryIdx: index("model_setup_reviews_entry_idx").on(table.entryId, table.createdAt),
    companyIdx: index("model_setup_reviews_company_idx").on(table.companyId, table.createdAt),
  }),
);
