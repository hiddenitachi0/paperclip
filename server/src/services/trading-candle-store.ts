import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingCandleIngestEvents, tradingCandles } from "@paperclipai/db";
import {
  isTradingCandleSource,
  isTradingCandleTimeframe,
  tradingCandleAssetOfMarket,
  tradingCandleProblem,
  tradingCandleTimeframeMs,
  type TradingAsset,
  type TradingCandleCoverageRow,
  type TradingCandleGap,
  type TradingCandleOverlapRow,
  type TradingCandleSource,
  type TradingCandleStopNotice,
  type TradingCandleStorageReport,
  type TradingCandleTimeframe,
  type TradingStoredCandle,
} from "@paperclipai/shared";
import { candleLog as logger } from "./trading-candle-log.js";

/**
 * The candle store's database side (DUR-5007): batched immutable inserts,
 * resume bookkeeping and the reports. Writers are the candle scheduler chain
 * (bypass connection); company routes only read.
 */

export const INSERT_BATCH = 2000;
const MAX_LOGGED_CORRECTIONS_PER_BATCH = 20;
/** A re-fetched bar counts as different only beyond float noise. */
const SAME_VALUE_TOLERANCE = 1e-9;

export interface InsertCandlesResult {
  inserted: number;
  /** Bars already stored (identical or not). */
  alreadyStored: number;
  /** Stored bars that differ from what the source says now. Logged, never overwritten. */
  corrections: number;
  /** Bars dropped because their numbers were not sane. */
  invalid: number;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_VALUE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

function sameBar(a: TradingStoredCandle, b: TradingStoredCandle): boolean {
  return sameNumber(a.open, b.open) && sameNumber(a.high, b.high) && sameNumber(a.low, b.low) && sameNumber(a.close, b.close) && sameNumber(a.volume, b.volume);
}

export type TradingCandleEventKind = "archive_done" | "correction" | "invalid_bars" | "source_stopped" | "gap_note";

export async function recordCandleEvent(
  db: Db,
  event: { kind: TradingCandleEventKind; source: TradingCandleSource; market?: string | null; timeframe?: TradingCandleTimeframe | null; ref?: string | null; openTime?: Date | null; detail?: Record<string, unknown> },
): Promise<void> {
  await db.insert(tradingCandleIngestEvents).values({
    kind: event.kind,
    source: event.source,
    market: event.market ?? null,
    timeframe: event.timeframe ?? null,
    ref: event.ref ?? null,
    openTime: event.openTime ?? null,
    detail: event.detail ?? {},
  });
}

/**
 * Stores closed bars once. Existing bars are never touched: a bar that is
 * already there and differs from the source's current numbers is logged as a
 * correction event and left as it was.
 */
export async function insertCandles(
  db: Db,
  source: TradingCandleSource,
  market: string,
  timeframe: TradingCandleTimeframe,
  bars: readonly TradingStoredCandle[],
): Promise<InsertCandlesResult> {
  const result: InsertCandlesResult = { inserted: 0, alreadyStored: 0, corrections: 0, invalid: 0 };
  const sane: TradingStoredCandle[] = [];
  for (const bar of bars) {
    if (tradingCandleProblem(bar)) result.invalid += 1;
    else sane.push(bar);
  }
  for (let from = 0; from < sane.length; from += INSERT_BATCH) {
    const batch = sane.slice(from, from + INSERT_BATCH);
    const inserted = await db
      .insert(tradingCandles)
      .values(batch.map((bar) => ({ source, market, timeframe, openTime: bar.openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })))
      .onConflictDoNothing()
      .returning({ openTime: tradingCandles.openTime });
    result.inserted += inserted.length;
    if (inserted.length === batch.length) continue;
    result.alreadyStored += batch.length - inserted.length;
    const insertedTimes = new Set(inserted.map((row) => row.openTime.getTime()));
    const skipped = batch.filter((bar) => !insertedTimes.has(bar.openTime.getTime()));
    const stored = await db
      .select()
      .from(tradingCandles)
      .where(
        and(
          eq(tradingCandles.source, source),
          eq(tradingCandles.market, market),
          eq(tradingCandles.timeframe, timeframe),
          inArray(
            tradingCandles.openTime,
            skipped.map((bar) => bar.openTime),
          ),
        ),
      );
    const storedByTime = new Map(stored.map((row) => [row.openTime.getTime(), row]));
    let logged = 0;
    for (const bar of skipped) {
      const was = storedByTime.get(bar.openTime.getTime());
      if (!was || sameBar(bar, was)) continue;
      result.corrections += 1;
      if (logged++ >= MAX_LOGGED_CORRECTIONS_PER_BATCH) continue;
      await recordCandleEvent(db, {
        kind: "correction",
        source,
        market,
        timeframe,
        openTime: bar.openTime,
        detail: {
          stored: { open: was.open, high: was.high, low: was.low, close: was.close, volume: was.volume },
          seen: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
        },
      });
    }
  }
  if (result.corrections > 0) logger.warn({ source, market, timeframe, corrections: result.corrections }, "candle store: source disagrees with stored bars (logged, not overwritten)");
  if (result.invalid > 0) logger.warn({ source, market, timeframe, invalid: result.invalid }, "candle store: dropped bars with impossible numbers");
  return result;
}

export async function latestOpenTime(db: Db, source: TradingCandleSource, market: string, timeframe: TradingCandleTimeframe): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${tradingCandles.openTime})` })
    .from(tradingCandles)
    .where(and(eq(tradingCandles.source, source), eq(tradingCandles.market, market), eq(tradingCandles.timeframe, timeframe)));
  return row?.at ? new Date(row.at) : null;
}

export async function earliestOpenTime(db: Db, source: TradingCandleSource, market: string, timeframe: TradingCandleTimeframe): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`min(${tradingCandles.openTime})` })
    .from(tradingCandles)
    .where(and(eq(tradingCandles.source, source), eq(tradingCandles.market, market), eq(tradingCandles.timeframe, timeframe)));
  return row?.at ? new Date(row.at) : null;
}

/** Archive entries (or request ranges) already finished, so a restart skips them. */
export async function loadDoneRefs(db: Db, source: TradingCandleSource): Promise<Set<string>> {
  const rows = await db
    .select({ ref: tradingCandleIngestEvents.ref })
    .from(tradingCandleIngestEvents)
    .where(and(eq(tradingCandleIngestEvents.kind, "archive_done"), eq(tradingCandleIngestEvents.source, source)));
  return new Set(rows.flatMap((row) => (row.ref ? [row.ref] : [])));
}

/** Sources currently told to stand down (a 418/451 whose `until` is still ahead). */
export async function activeSourceStops(db: Db, now: Date): Promise<TradingCandleStopNotice[]> {
  const rows = await db
    .select()
    .from(tradingCandleIngestEvents)
    .where(and(eq(tradingCandleIngestEvents.kind, "source_stopped"), gte(tradingCandleIngestEvents.createdAt, new Date(now.getTime() - 7 * 24 * 3_600_000))))
    .orderBy(asc(tradingCandleIngestEvents.createdAt));
  const latest = new Map<string, TradingCandleStopNotice>();
  for (const row of rows) {
    if (!isTradingCandleSource(row.source)) continue;
    const until = typeof row.detail.until === "string" ? row.detail.until : null;
    latest.set(row.source, { source: row.source, reason: String(row.detail.reason ?? "stopped"), at: row.createdAt.toISOString(), until });
  }
  return [...latest.values()].filter((stop) => stop.until && new Date(stop.until).getTime() > now.getTime());
}

export interface ListCandlesInput {
  source: TradingCandleSource;
  market: string;
  timeframe: TradingCandleTimeframe;
  from?: Date;
  to?: Date;
  limit: number;
}

/** Bars oldest-first (open time ascending). Closed bars only by construction. */
export async function listCandles(db: Db, input: ListCandlesInput): Promise<Array<TradingStoredCandle>> {
  const rows = await db
    .select()
    .from(tradingCandles)
    .where(
      and(
        eq(tradingCandles.source, input.source),
        eq(tradingCandles.market, input.market),
        eq(tradingCandles.timeframe, input.timeframe),
        input.from ? gte(tradingCandles.openTime, input.from) : undefined,
        input.to ? lte(tradingCandles.openTime, input.to) : undefined,
      ),
    )
    .orderBy(asc(tradingCandles.openTime))
    .limit(input.limit);
  return rows.map((row) => ({ openTime: row.openTime, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }));
}

// ─── Reports ────────────────────────────────────────────────────────────────

const TIMEFRAME_MS_CASE = sql`CASE timeframe WHEN '5m' THEN 300000 WHEN '1h' THEN 3600000 WHEN '4h' THEN 14400000 ELSE 86400000 END`;

interface StreamFilter {
  source?: TradingCandleSource;
  market?: string;
  timeframe?: TradingCandleTimeframe;
}

function filterSql(filter: StreamFilter) {
  return sql`${filter.source ? sql`AND source = ${filter.source}` : sql``} ${filter.market ? sql`AND market = ${filter.market}` : sql``} ${filter.timeframe ? sql`AND timeframe = ${filter.timeframe}` : sql``}`;
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

export async function coverageReport(db: Db, filter: StreamFilter = {}): Promise<TradingCandleCoverageRow[]> {
  const rows = await db.execute(sql`
    SELECT source, market, timeframe, min(open_time) AS first_bar, max(open_time) AS last_bar, count(*)::bigint AS bars
    FROM trading_candles WHERE true ${filterSql(filter)}
    GROUP BY source, market, timeframe ORDER BY market, timeframe, source`);
  const out: TradingCandleCoverageRow[] = [];
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const timeframe = String(row.timeframe);
    const source = String(row.source);
    if (!isTradingCandleSource(source) || !isTradingCandleTimeframe(timeframe)) continue;
    const first = new Date(row.first_bar as string);
    const last = new Date(row.last_bar as string);
    out.push({
      source,
      market: String(row.market),
      timeframe,
      firstBar: first.toISOString(),
      lastBar: last.toISOString(),
      bars: Number(row.bars),
      expectedBars: Math.round((last.getTime() - first.getTime()) / tradingCandleTimeframeMs(timeframe)) + 1,
      // Filled in once the market-weather labels exist (DUR-5013).
      regimesCovered: null,
    });
  }
  return out;
}

/** A coin's first years on an exchange are thin; gaps there are no-trade stretches, not lost data. */
const THIN_MARKET_YEARS = 5;

/** Longest run of missing bars that is still just "nothing traded in that interval". */
const QUIET_INTERVAL_MAX_MISSING: Record<TradingCandleTimeframe, number> = { "5m": 12, "1h": 6, "4h": 3, "1d": 1 };

export async function gapReport(
  db: Db,
  filter: StreamFilter & { minMissingBars?: number; limit?: number } = {},
): Promise<{ streams: Array<{ source: TradingCandleSource; market: string; timeframe: TradingCandleTimeframe; gaps: number; missingBars: number; unexplained: number }>; gaps: TradingCandleGap[] }> {
  const minMissing = Math.max(1, filter.minMissingBars ?? 1);
  const limit = Math.min(Math.max(1, filter.limit ?? 200), 1000);
  const gapRows = (await db.execute(sql`
    WITH ordered AS (
      SELECT source, market, timeframe, open_time,
             lead(open_time) OVER (PARTITION BY source, market, timeframe ORDER BY open_time) AS next_open
      FROM trading_candles WHERE true ${filterSql(filter)}
    ), gaps AS (
      SELECT source, market, timeframe, open_time AS after_bar, next_open AS before_bar,
             (extract(epoch FROM (next_open - open_time)) * 1000 / (${TIMEFRAME_MS_CASE}))::bigint - 1 AS missing
      FROM ordered WHERE next_open IS NOT NULL
    )
    SELECT * FROM gaps WHERE missing >= ${minMissing}`)) as unknown as Array<Record<string, unknown>>;

  const notes = await db
    .select({ source: tradingCandleIngestEvents.source, market: tradingCandleIngestEvents.market, timeframe: tradingCandleIngestEvents.timeframe, openTime: tradingCandleIngestEvents.openTime, detail: tradingCandleIngestEvents.detail })
    .from(tradingCandleIngestEvents)
    .where(eq(tradingCandleIngestEvents.kind, "gap_note"));
  const noteFor = new Map(notes.flatMap((note) => (note.openTime ? [[`${note.source}|${note.market}|${note.timeframe}|${note.openTime.toISOString()}`, String(note.detail.reason ?? "noted")] as const] : [])));

  const firstBars = new Map<string, number>();
  const marketsOfStream = new Map<string, string[]>();
  for (const row of (await db.execute(sql`SELECT source, market, timeframe, min(open_time) AS first_bar FROM trading_candles GROUP BY 1, 2, 3`)) as unknown as Array<Record<string, unknown>>) {
    firstBars.set(`${row.source}|${row.market}|${row.timeframe}`, new Date(row.first_bar as string).getTime());
    const list = marketsOfStream.get(`${row.source}|${row.timeframe}`) ?? [];
    list.push(String(row.market));
    marketsOfStream.set(`${row.source}|${row.timeframe}`, list);
  }

  const streams = new Map<string, { source: TradingCandleSource; market: string; timeframe: TradingCandleTimeframe; gaps: number; missingBars: number; unexplained: number }>();
  const all: TradingCandleGap[] = [];
  for (const row of gapRows) {
    const source = String(row.source);
    const timeframe = String(row.timeframe);
    if (!isTradingCandleSource(source) || !isTradingCandleTimeframe(timeframe)) continue;
    const market = String(row.market);
    const missingBars = Number(row.missing);
    const afterBar = iso(row.after_bar);
    const beforeBar = iso(row.before_bar);
    let explanation =
      noteFor.get(`${source}|${market}|${timeframe}|${afterBar}`) ??
      (missingBars <= QUIET_INTERVAL_MAX_MISSING[timeframe] ? "The exchange publishes no bar for an interval in which nothing traded." : null);
    if (!explanation && new Date(afterBar).getTime() < (firstBars.get(`${source}|${market}|${timeframe}`) ?? 0) + THIN_MARKET_YEARS * 365 * 86_400_000) {
      explanation = `Early, thin market (first ${THIN_MARKET_YEARS} years of this coin on the exchange): no trades in the interval.`;
    }
    if (!explanation) {
      // Every other coin that already traded on this exchange was silent too: an outage or maintenance, not missing data.
      const others = (marketsOfStream.get(`${source}|${timeframe}`) ?? []).filter(
        (other) => other !== market && (firstBars.get(`${source}|${other}|${timeframe}`) ?? Infinity) < new Date(afterBar).getTime(),
      );
      if (others.length >= 2) {
        const [active] = (await db.execute(sql`
          SELECT count(*)::int AS n FROM trading_candles
          WHERE source = ${source} AND timeframe = ${timeframe} AND market IN (${sql.join(others.map((other) => sql`${other}`), sql`, `)})
            AND open_time > ${afterBar}::timestamptz AND open_time < ${beforeBar}::timestamptz`)) as unknown as Array<{ n: number }>;
        if (active?.n === 0) explanation = "No coin traded on this exchange in the interval (outage or maintenance).";
      }
    }
    all.push({ source, market, timeframe, afterBar, beforeBar, missingBars, explanation });
    const key = `${source}|${market}|${timeframe}`;
    const stream = streams.get(key) ?? { source, market, timeframe, gaps: 0, missingBars: 0, unexplained: 0 };
    stream.gaps += 1;
    stream.missingBars += missingBars;
    if (!explanation) stream.unexplained += 1;
    streams.set(key, stream);
  }
  // Unexplained gaps first, then the biggest.
  all.sort((a, b) => Number(a.explanation !== null) - Number(b.explanation !== null) || b.missingBars - a.missingBars);
  return { streams: [...streams.values()], gaps: all.slice(0, limit) };
}

/**
 * Kraken (US dollars) against Binance (Tether) on the bars both have. Prices
 * are compared directly; volumes only by their rank within each source's own
 * history, because the two venues count different trades and volumes are never
 * mixed.
 */
export async function overlapReport(db: Db, filter: { asset?: TradingAsset; timeframe?: TradingCandleTimeframe } = {}): Promise<TradingCandleOverlapRow[]> {
  const assetFilter = filter.asset ? sql`AND split_part(market, '/', 1) = ${filter.asset}` : sql``;
  const tfFilter = filter.timeframe ? sql`AND timeframe = ${filter.timeframe}` : sql``;
  const rows = (await db.execute(sql`
    WITH k AS (SELECT split_part(market, '/', 1) AS asset, timeframe, open_time, close, volume FROM trading_candles WHERE source = 'kraken' ${assetFilter} ${tfFilter}),
         b AS (SELECT split_part(market, '/', 1) AS asset, timeframe, open_time, close, volume FROM trading_candles WHERE source = 'binance' ${assetFilter} ${tfFilter}),
         j AS (SELECT k.asset, k.timeframe, k.open_time, k.close AS kc, b.close AS bc, k.volume AS kv, b.volume AS bv FROM k JOIN b USING (asset, timeframe, open_time)),
         r AS (
           SELECT asset, timeframe, kc, bc,
                  kc / NULLIF(lag(kc) OVER w, 0) - 1 AS kr, bc / NULLIF(lag(bc) OVER w, 0) - 1 AS br,
                  percent_rank() OVER (PARTITION BY asset, timeframe ORDER BY kv) AS kvr,
                  percent_rank() OVER (PARTITION BY asset, timeframe ORDER BY bv) AS bvr
           FROM j WINDOW w AS (PARTITION BY asset, timeframe ORDER BY open_time)
         )
    SELECT asset, timeframe, count(*)::bigint AS n,
           avg(abs(kc - bc) / bc * 100) AS diff_mean, percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(kc - bc) / bc * 100) AS diff_p95,
           corr(kr, br) AS return_corr, corr(kvr, bvr) AS volume_rank_corr
    FROM r GROUP BY asset, timeframe ORDER BY asset, timeframe`)) as unknown as Array<Record<string, unknown>>;
  const num = (value: unknown): number | null => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
  return rows.flatMap((row) => {
    const asset = tradingCandleAssetOfMarket(`${row.asset}/USD`);
    const timeframe = String(row.timeframe);
    if (!asset || !isTradingCandleTimeframe(timeframe)) return [];
    return [{ asset, timeframe, overlappingBars: Number(row.n), closeDiffMeanPct: num(row.diff_mean), closeDiffP95Pct: num(row.diff_p95), returnCorrelation: num(row.return_corr), volumeRankCorrelation: num(row.volume_rank_corr) }];
  });
}

export async function storageReport(db: Db): Promise<TradingCandleStorageReport> {
  const [sizes] = (await db.execute(sql`
    SELECT pg_total_relation_size('trading_candles')::bigint AS total, pg_table_size('trading_candles')::bigint AS tbl, pg_indexes_size('trading_candles')::bigint AS idx`)) as unknown as Array<Record<string, unknown>>;
  const counts = (await db.execute(sql`SELECT source, count(*)::bigint AS rows FROM trading_candles GROUP BY source ORDER BY source`)) as unknown as Array<Record<string, unknown>>;
  const bySource = counts.flatMap((row) => (isTradingCandleSource(String(row.source)) ? [{ source: String(row.source) as TradingCandleSource, rows: Number(row.rows) }] : []));
  return {
    totalBytes: Number(sizes?.total ?? 0),
    tableBytes: Number(sizes?.tbl ?? 0),
    indexBytes: Number(sizes?.idx ?? 0),
    rows: bySource.reduce((sum, row) => sum + row.rows, 0),
    bySource,
  };
}
