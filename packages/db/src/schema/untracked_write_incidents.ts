import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const untrackedWriteIncidents = pgTable(
  "untracked_write_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableName: text("table_name").notNull(),
    operation: text("operation").notNull(),
    rowId: text("row_id"),
    companyId: uuid("company_id"),
    applicationName: text("application_name"),
    sessionUserName: text("session_user_name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (table) => ({
    unalertedIdx: index("untracked_write_incidents_unalerted_idx").on(table.occurredAt),
    companyIdx: index("untracked_write_incidents_company_idx").on(table.companyId),
  }),
);
