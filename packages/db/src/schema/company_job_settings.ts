import { boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4182 (Positions/Jobs backend): the company-wide switch for the new
 * one-press "Jobs" behaviour (file-upload variables claimed onto the run's
 * issue, position-linked jobs, the Legal Advisor starter pack). Same lazy
 * row pattern as company_payment_settings -- a company that never turns
 * this on never gets a row, and absence reads as "off"
 * (see server/src/services/company-job-settings.ts). Existing Routine
 * CRUD/run behaviour is unaffected either way; only the genuinely new
 * surface area this ticket adds is gated.
 */
export const companyJobSettings = pgTable("company_job_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  jobsEnabled: boolean("jobs_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
