import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4471 (cache-aware agent runs, parent DUR-4465): per-company switches and
 * thresholds. Same lazy-row pattern as company_job_settings -- a company that
 * never touches these never gets a row, and absence reads as "off" with the
 * defaults in server/src/services/company-cache-settings.ts.
 */
export const companyCacheSettings = pgTable("company_cache_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  schedulingEnabled: boolean("scheduling_enabled").notNull().default(true),
  handoffEnabled: boolean("handoff_enabled").notNull().default(true),
  handoffTokenThreshold: integer("handoff_token_threshold").notNull().default(150000),
  cacheLifetimeMinutes: integer("cache_lifetime_minutes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
