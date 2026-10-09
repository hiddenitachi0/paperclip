import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4419 (child of DUR-4378): the last known health of one local model on
 * one address, and where it is in an outage. Keyed by (company, address,
 * model), not by directory entry or agent, because the outage is about the
 * PC: every entry and every agent pointing at the same address+model shares
 * it, and an agent that was never saved to the directory is covered too.
 *
 * Fire-once: `outage_notified_at` is set by a single conditional UPDATE the
 * first time a failed message in an outage asks to tell the person, and is
 * cleared on recovery -- so repeated messages in one outage stay quiet and a
 * fresh outage after a recovery tells them again.
 *
 * Rollback: DROP TABLE "local_model_health". It is derived state; the next
 * check rebuilds it.
 */
export const localModelHealth = pgTable(
  "local_model_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Normalised (trimmed, no trailing slash, lower-case).
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
    lastReachableAt: timestamp("last_reachable_at", { withTimezone: true }),
    outageStartedAt: timestamp("outage_started_at", { withTimezone: true }),
    outageNotifiedAt: timestamp("outage_notified_at", { withTimezone: true }),
    // The evening-before warning for a scheduled job, once per outage too.
    eveningWarnedAt: timestamp("evening_warned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetUq: uniqueIndex("local_model_health_target_uq").on(table.companyId, table.baseUrl, table.model),
    companyIdx: index("local_model_health_company_idx").on(table.companyId, table.status),
    statusCheck: check(
      "local_model_health_status_check",
      sql`${table.status} IN ('ready', 'unreachable', 'model_missing')`,
    ),
  }),
);
