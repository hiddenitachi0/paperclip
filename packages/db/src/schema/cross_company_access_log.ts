import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const crossCompanyAccessLog = pgTable(
  "cross_company_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    route: text("route"),
    companyIdsTouched: jsonb("company_ids_touched").$type<string[]>(),
  },
  (table) => ({
    occurredAtIdx: index("cross_company_access_log_occurred_at_idx").on(table.occurredAt),
  }),
);
