import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Which vigilance alerts a company gets on Telegram (DUR-5017, migration 0270).
 * One row per company, created on first write; a company without a row has
 * every event switched on (decision 16), so reading never needs a write.
 *
 * Each `*_on` column is the switch for one event; switching it off stops that
 * event at the moment it would be queued. `big_move_atr_k` and
 * `paused_after_restart_hours` are the two numbers the events use.
 *
 * Company-scoped (RLS like trading_alerts). Rollback: DROP TABLE
 * "trading_alert_settings" -- every company then falls back to the defaults.
 */
export const tradingAlertSettings = pgTable(
  "trading_alert_settings",
  {
    companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
    weatherFlipsOn: boolean("weather_flips_on").notNull().default(true),
    bigMovesOn: boolean("big_moves_on").notNull().default(true),
    breakerTripsOn: boolean("breaker_trips_on").notNull().default(true),
    pausedAfterRestartOn: boolean("paused_after_restart_on").notNull().default(true),
    dailySummaryOn: boolean("daily_summary_on").notNull().default(true),
    bigMoveAtrK: doublePrecision("big_move_atr_k").notNull().default(3),
    pausedAfterRestartHours: integer("paused_after_restart_hours").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bigMoveCheck: check("trading_alert_settings_big_move_check", sql`${table.bigMoveAtrK} >= 1 AND ${table.bigMoveAtrK} <= 10`),
    pausedHoursCheck: check("trading_alert_settings_paused_hours_check", sql`${table.pausedAfterRestartHours} >= 1 AND ${table.pausedAfterRestartHours} <= 72`),
  }),
);
