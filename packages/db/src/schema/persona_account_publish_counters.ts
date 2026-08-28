import { pgTable, uuid, date, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { personaAccounts } from "./persona_accounts.js";

// DUR-134: enforces persona_accounts.dailyPostCap in code, at the moment of
// publish. Same shape as persona_generation_counters (DUR-177) -- one row
// per (persona_account, UTC calendar day), incremented atomically and
// conditionally via `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE count <
// cap` so concurrent publish attempts for the same account can never push
// the day's count past the cap. UTC day for the same reason DUR-177 used it:
// no per-company timezone concept exists elsewhere for daily-reset logic.
export const personaAccountPublishCounters = pgTable(
  "persona_account_publish_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    personaAccountId: uuid("persona_account_id").notNull().references(() => personaAccounts.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountDayUq: uniqueIndex("persona_account_publish_counters_account_day_uq").on(
      table.personaAccountId,
      table.day,
    ),
  }),
);
