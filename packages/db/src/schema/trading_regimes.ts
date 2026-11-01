import { sql } from "drizzle-orm";
import { boolean, check, date, doublePrecision, integer, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Market weather (DUR-5013, migration 0269): one label per coin per day,
 * computed from the closed 1d bars in the candle store (trading_candles).
 * The rules live in packages/shared/src/trading-regimes.ts.
 *
 * Instance-wide public market data derived from public market data: there is
 * no company_id, so the table is in the login-role list of
 * 0164_rls_login_roles.sql and not in the company-scoped one. The scheduler
 * (bypass connection) writes it; company routes read it with the scoped role,
 * which has SELECT only.
 *
 * `available_at` is the close of the label's day: a decision made before it
 * must not read the row (an intraday decision on day D reads D-1's label).
 *
 * Rows are derived, not hand-edited, and can be rebuilt from the candle store
 * at any time. The writer only inserts new days, and updates a past day only
 * when the candle store later gained older history that changes the number.
 * Every label is a function of bars up to its own day, so an update never
 * lets the future leak into the past. `rules_version` lets a later change of
 * the rules sit next to the old labels instead of overwriting them.
 *
 * Spell boundaries: `spell_no` / `spell_start_day` mark runs of days with the
 * same trend + volatility + squeeze, so "number of spells" is a count of
 * distinct `spell_no` and "since 12 Oct" is `spell_start_day`.
 *
 * Rollback: DROP TABLE "trading_regimes". Safe: nothing references it and it
 * can be rebuilt from the candle store.
 */
export const tradingRegimes = pgTable(
  "trading_regimes",
  {
    asset: text("asset").notNull(),
    rulesVersion: smallint("rules_version").notNull(),
    /** UTC date the daily bar opened. */
    day: date("day", { mode: "string" }).notNull(),
    /** The close of `day`. Nothing decided earlier may read this row. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    /** Which candle source's 1d bars the label was computed from. */
    source: text("source").notNull(),
    trend: text("trend").notNull(),
    volatility: text("volatility").notNull(),
    squeeze: boolean("squeeze").notNull(),
    close: doublePrecision("close").notNull(),
    sma200: doublePrecision("sma200").notNull(),
    adx: doublePrecision("adx").notNull(),
    atrPct: doublePrecision("atr_pct").notNull(),
    atrPctPercentile: doublePrecision("atr_pct_percentile").notNull(),
    bbWidthPercentile: doublePrecision("bb_width_percentile").notNull(),
    spellNo: integer("spell_no").notNull(),
    spellStartDay: date("spell_start_day", { mode: "string" }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.asset, table.rulesVersion, table.day], name: "trading_regimes_pk" }),
    sourceCheck: check("trading_regimes_source_check", sql`${table.source} IN ('kraken', 'binance', 'coinbase')`),
    trendCheck: check("trading_regimes_trend_check", sql`${table.trend} IN ('uptrend', 'downtrend', 'ranging')`),
    volatilityCheck: check("trading_regimes_volatility_check", sql`${table.volatility} IN ('low', 'normal', 'high')`),
    percentileCheck: check(
      "trading_regimes_percentile_check",
      sql`${table.atrPctPercentile} BETWEEN 0 AND 100 AND ${table.bbWidthPercentile} BETWEEN 0 AND 100`,
    ),
    spellCheck: check("trading_regimes_spell_check", sql`${table.spellNo} >= 1 AND ${table.spellStartDay} <= ${table.day}`),
  }),
);
