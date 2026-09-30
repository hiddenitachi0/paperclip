import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4094: Filip's emergency-access ("break-glass") audit trail. One row is
 * written every time an owner or admin reads private content belonging to
 * someone else -- today that means an Employee (light)'s PA conversation or
 * memory notes, read through the emergency-access route rather than through
 * her own account.
 *
 * `reason` is never optional, even when `notify` is false: the written
 * reason is what later proves why the access happened, for a suspected-
 * misuse or internal-investigation review. `notify` records whether the
 * subject was told at the time; turning it off does not touch `reason`, only
 * whether the row is included in the subject's own "My access log" read
 * (see server/src/services/private-access.ts).
 *
 * This is the same shape as secret_access_events (an append-only ledger, no
 * update/delete route) and, like it, is additive and reversible: dropping the
 * table loses only the audit history, never anything a person did or wrote.
 */
export const privateAccessEvents = pgTable(
  "private_access_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // The company_memberships.principal_id (a user id) whose private content
    // was read. Not a foreign key to any single owned-content table, because
    // targetKind names which one to read it from.
    targetUserId: text("target_user_id").notNull(),
    accessedByUserId: text("accessed_by_user_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id"),
    reason: text("reason").notNull(),
    notify: boolean("notify").notNull().default(true),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("private_access_events_company_created_idx").on(table.companyId, table.createdAt),
    targetUserIdx: index("private_access_events_target_user_idx").on(table.companyId, table.targetUserId, table.createdAt),
  }),
);
