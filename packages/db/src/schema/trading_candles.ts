import { sql } from "drizzle-orm";
import { bigserial, check, doublePrecision, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The candle store (DUR-5007, migration 0262): years of closed candles for
 * past-data tests, one row per exchange, market, bar size and bar start.
 *
 * Instance-wide public market data only. There is no company_id: nothing in
 * these tables belongs to a company, so they are in the login-role list of
 * 0164_rls_login_roles.sql and not in the company-scoped one. The candle
 * scheduler chain writes them through the bypass connection; company routes
 * only read.
 *
 *   * trading_candles: closed bars only, immutable. A trigger refuses any
 *     UPDATE, and inserts use ON CONFLICT DO NOTHING; a later difference is
 *     logged to trading_candle_ingest_events, never written over the bar.
 *   * trading_candle_ingest_events: append-only log of what the backfill did
 *     (an archive finished, a correction found, a source told us to stop). The
 *     backfill resumes from it after an interruption.
 *
 * Rollback: DROP TABLE "trading_candle_ingest_events", "trading_candles"
 * (and the function trading_candles_refuse_update). Safe: nothing else
 * references either table; the data can be rebuilt from the exchanges.
 */
export const tradingCandles = pgTable(
  "trading_candles",
  {
    source: text("source").notNull(),
    market: text("market").notNull(),
    timeframe: text("timeframe").notNull(),
    openTime: timestamp("open_time", { withTimezone: true }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.market, table.timeframe, table.openTime], name: "trading_candles_pk" }),
    sourceCheck: check("trading_candles_source_check", sql`${table.source} IN ('kraken', 'binance', 'coinbase')`),
    timeframeCheck: check("trading_candles_timeframe_check", sql`${table.timeframe} IN ('5m', '1h', '4h', '1d')`),
    sanityCheck: check(
      "trading_candles_sanity_check",
      sql`${table.open} > 0 AND ${table.high} > 0 AND ${table.low} > 0 AND ${table.close} > 0 AND ${table.volume} >= 0 AND ${table.high} >= ${table.low}`,
    ),
  }),
);

export const tradingCandleIngestEvents = pgTable(
  "trading_candle_ingest_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    market: text("market"),
    timeframe: text("timeframe"),
    /** Which archive entry or request the event is about, e.g. `Kraken_OHLCVT_Full.zip#XBTUSD_60.csv`. */
    ref: text("ref"),
    openTime: timestamp("open_time", { withTimezone: true }),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCheck: check("trading_candle_ingest_events_kind_check", sql`${table.kind} IN ('archive_done', 'correction', 'invalid_bars', 'source_stopped', 'gap_note')`),
    kindRefIdx: index("trading_candle_ingest_events_kind_ref_idx").on(table.kind, table.source, table.ref),
    createdIdx: index("trading_candle_ingest_events_created_idx").on(table.createdAt),
  }),
);
