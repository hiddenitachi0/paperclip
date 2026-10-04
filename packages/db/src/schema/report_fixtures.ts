import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, numeric, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { reportScriptVersions } from "./report_script_versions.js";

/**
 * DUR-4072 PR1: a saved input/expected-output pair a script version must
 * reproduce. `tolerance` of '0' means every number in the output must match
 * the fixture exactly (the ticket's "reproduce Q1 2026 to the krone" case);
 * a positive tolerance allows a small absolute difference per number for
 * scripts whose output is inherently approximate.
 *
 * A version cannot move to 'approved' without passing every fixture that
 * names it (enforced in the service layer): the approval card the ticket
 * requires shows exactly these results.
 */
export const reportFixtures = pgTable(
  "report_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scriptVersionId: uuid("script_version_id").notNull().references(() => reportScriptVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    expectedOutput: jsonb("expected_output").$type<unknown>().notNull(),
    tolerance: numeric("tolerance", { precision: 20, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scriptVersionNameUq: uniqueIndex("report_fixtures_script_version_name_uq").on(table.scriptVersionId, table.name),
    companyIdx: index("report_fixtures_company_idx").on(table.companyId),
    toleranceCheck: check("report_fixtures_tolerance_check", sql`${table.tolerance} >= 0`),
  }),
);
