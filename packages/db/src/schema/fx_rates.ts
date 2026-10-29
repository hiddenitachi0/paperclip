import { check, date, doublePrecision, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * DUR-5001 (migration 0262): the daily USD/NOK rate Norges Bank publishes,
 * one row per published date. Instance-wide market data -- the same rate
 * applies to every company -- so there is no company_id and no row-level
 * policy; only the app login roles get table privileges (the name is in the
 * first, grant-only array of 0164_rls_login_roles.sql, like
 * instance_server_anthropic_key).
 *
 * `rate_date` is the date Norges Bank published the rate for (a Norwegian
 * business day). Weekends and holidays have no row of their own: a fill on
 * such a day uses the newest earlier row and stores that row's date.
 * `published_at` is when this instance first saw and stored the rate.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rateDate: date("rate_date", { mode: "string" }).notNull().unique(),
    /** NOK per 1 USD. */
    rate: doublePrecision("rate").notNull(),
    source: text("source").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rateCheck: check("fx_rates_rate_check", sql`${table.rate} > 0`),
  }),
);
