import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, tradingCandleIngestEvents, tradingCandles } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activeSourceStops,
  coverageReport,
  gapReport,
  insertCandles,
  latestOpenTime,
  listCandles,
  loadDoneRefs,
  overlapReport,
  recordCandleEvent,
  storageReport,
} from "../services/trading-candle-store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
function bar(hoursFromT0: number, close = 100 + hoursFromT0, volume = 10) {
  return { openTime: new Date(T0 + hoursFromT0 * HOUR), open: close - 1, high: close + 1, low: close - 2, close, volume };
}

describeDb("trading candle store (DUR-5007)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-candle-store-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
  });

  it("stores each closed bar once; a second insert of the same bars changes nothing", async () => {
    const bars = [bar(0), bar(1), bar(2)];
    const first = await insertCandles(db, "kraken", "BTC/USD", "1h", bars);
    expect(first).toMatchObject({ inserted: 3, alreadyStored: 0, corrections: 0 });
    const again = await insertCandles(db, "kraken", "BTC/USD", "1h", bars);
    expect(again).toMatchObject({ inserted: 0, alreadyStored: 3, corrections: 0 });
    expect(await latestOpenTime(db, "kraken", "BTC/USD", "1h")).toEqual(bars[2]!.openTime);
    expect(await db.select().from(tradingCandleIngestEvents)).toHaveLength(0);
  });

  it("logs a correction and keeps the stored bar when a source later says something different", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0, 100)]);
    const outcome = await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0, 250)]);
    expect(outcome).toMatchObject({ inserted: 0, corrections: 1 });
    const [stored] = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "1h", limit: 10 });
    expect(stored!.close).toBe(100);
    const events = await db.select().from(tradingCandleIngestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "correction", source: "kraken", market: "BTC/USD", timeframe: "1h" });
    expect(events[0]!.detail).toMatchObject({ stored: { close: 100 }, seen: { close: 250 } });
  });

  it("drops bars with impossible numbers and counts them", async () => {
    const broken = { ...bar(1), high: 1, low: 5 };
    const negative = { ...bar(2), volume: -1 };
    const outcome = await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), broken, negative, { ...bar(3), close: Number.NaN }]);
    expect(outcome).toMatchObject({ inserted: 1, invalid: 3 });
  });

  it("refuses any UPDATE of a stored bar, at the database", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0)]);
    const failure = await db.update(tradingCandles).set({ close: 1 }).then(() => null, (error: Error & { cause?: Error }) => error);
    expect(failure).not.toBeNull();
    expect(String(failure!.cause?.message ?? failure!.message)).toMatch(/immutable/);
    const [stored] = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "1h", limit: 1 });
    expect(stored!.close).toBe(100);
  });

  it("rejects an unknown source or timeframe at the database", async () => {
    await expect(insertCandles(db, "kraken", "BTC/USD", "15m" as never, [bar(0)])).rejects.toThrow();
    await expect(insertCandles(db, "ftx" as never, "BTC/USD", "1h", [bar(0)])).rejects.toThrow();
  });

  it("reports coverage per source, market and bar size", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(1), bar(5)]);
    const rows = await coverageReport(db);
    expect(rows).toEqual([
      {
        source: "kraken",
        market: "BTC/USD",
        timeframe: "1h",
        firstBar: new Date(T0).toISOString(),
        lastBar: new Date(T0 + 5 * HOUR).toISOString(),
        bars: 3,
        expectedBars: 6,
        regimesCovered: null,
      },
    ]);
  });

  it("finds gaps, explains short quiet ones, noted ones and early thin ones, and leaves the rest unexplained", async () => {
    const EARLY = -60_000; // about 6.8 years before T0, so everything after it is outside the "early, thin market" window
    // anchor | huge gap | 0,1 | gap of 2 (quiet) | 4,5 | gap of 20 (noted) | 26 | gap of 30 (unexplained) | 57
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(EARLY, 100), bar(0), bar(1), bar(4), bar(5), bar(26), bar(57)]);
    await recordCandleEvent(db, { kind: "gap_note", source: "kraken", market: "BTC/USD", timeframe: "1h", openTime: new Date(T0 + 5 * HOUR), detail: { reason: "awaiting next archive" } });
    const report = await gapReport(db);
    // The first bar is the coin's start, so the early window is its first five years: the stretch after it is outside it,
    // and the 59,999-bar hole right after the anchor is far too long for "no trades" to explain.
    expect(report.streams).toEqual([{ source: "kraken", market: "BTC/USD", timeframe: "1h", gaps: 4, missingBars: 59_999 + 2 + 20 + 30, unexplained: 2 }]);
    expect(report.gaps.map((g) => [g.missingBars, g.explanation])).toEqual([
      [59_999, null],
      [30, null],
      [20, "awaiting next archive"],
      [2, "The exchange publishes no bar for an interval in which nothing traded."],
    ]);
    expect(report.gaps[1]).toMatchObject({ afterBar: new Date(T0 + 26 * HOUR).toISOString(), beforeBar: new Date(T0 + 57 * HOUR).toISOString() });
  });

  it("explains a long gap in a coin's first years as an early, thin market", async () => {
    await insertCandles(db, "kraken", "LTC/USD", "1h", [bar(0), bar(20)]);
    const report = await gapReport(db);
    expect(report.gaps[0]!.explanation).toMatch(/Early, thin market/);
    expect(report.streams[0]!.unexplained).toBe(0);
  });

  it("does not let the early-thin-market rule explain a day or more of missing bars, even in a coin's first years", async () => {
    await insertCandles(db, "kraken", "LTC/USD", "1h", [bar(0), bar(26)]); // 25 missing hours
    const report = await gapReport(db);
    expect(report.gaps[0]!.explanation).toBeNull();
    expect(report.streams[0]!.unexplained).toBe(1);
  });

  it("anchors the early-thin-market window to the coin's first bar on the source, not to the 5m stream's own first bar", async () => {
    const DAY = 24 * HOUR;
    const MIN5 = 300_000;
    const dayBar = (i: number) => ({ ...bar(0), openTime: new Date(T0 + i * DAY) });
    const fiveBar = (i: number) => ({ ...bar(0), openTime: new Date(T0 + i * MIN5) });
    // The coin has traded here for years (1d history starts ~6.8 years before the 5m stream's capped history).
    await insertCandles(db, "kraken", "BTC/USD", "1d", [{ ...dayBar(0), openTime: new Date(T0 - 2500 * DAY) }, dayBar(0)]);
    // The 5m stream lost three days (864 bars) in the middle.
    await insertCandles(db, "kraken", "BTC/USD", "5m", [fiveBar(0), fiveBar(1), fiveBar(1 + 865), fiveBar(1 + 866)]);
    const report = await gapReport(db, { source: "kraken", timeframe: "5m" });
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ missingBars: 864, explanation: null });
    expect(report.streams[0]).toMatchObject({ unexplained: 1 });

    // Even a short-enough hole is not "early" when the coin's first bar on the source is more than five years back.
    await db.execute(sql`TRUNCATE trading_candles`);
    await insertCandles(db, "kraken", "BTC/USD", "1d", [{ ...dayBar(0), openTime: new Date(T0 - 2500 * DAY) }, dayBar(0)]);
    await insertCandles(db, "kraken", "BTC/USD", "5m", [fiveBar(0), fiveBar(1 + 200)]); // 199 bars, under a day
    expect((await gapReport(db, { source: "kraken", timeframe: "5m" })).gaps[0]!.explanation).toBeNull();
  });

  it("explains a long gap as an outage when every other coin on the exchange was silent too, but not when one traded", async () => {
    const EARLY = -60_000;
    const inGap = (market: string, afterHour: number, gaps: Awaited<ReturnType<typeof gapReport>>["gaps"]) =>
      gaps.find((g) => g.market === market && g.afterBar === new Date(T0 + afterHour * HOUR).toISOString())!;

    // Nobody traded between hour 0 and hour 100.
    for (const market of ["BTC/USD", "ETH/USD", "SOL/USD"]) await insertCandles(db, "kraken", market, "1h", [bar(EARLY, 100), bar(0), bar(100)]);
    let report = await gapReport(db, { minMissingBars: 20 });
    expect(inGap("ETH/USD", 0, report.gaps).explanation).toMatch(/No coin traded/);

    // BTC traded at hour 10: that stretch is no longer an outage for ETH, but is still one for BTC's own two halves.
    await db.execute(sql`TRUNCATE trading_candles`);
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(EARLY, 100), bar(0), bar(10), bar(100)]);
    for (const market of ["ETH/USD", "SOL/USD"]) await insertCandles(db, "kraken", market, "1h", [bar(EARLY, 100), bar(0), bar(100)]);
    report = await gapReport(db, { minMissingBars: 20 });
    expect(inGap("ETH/USD", 0, report.gaps).explanation).toBeNull();
    expect(inGap("BTC/USD", 10, report.gaps).explanation).toMatch(/No coin traded/);
  });

  it("reports no gaps for a clean run", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(1), bar(2)]);
    expect(await gapReport(db)).toEqual({ streams: [], gaps: [] });
  });

  it("compares Kraken and Binance on price, and on volume only by rank", async () => {
    const kraken = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i, 10 + i));
    // Binance prices 0.1% higher, and volumes 1000x larger but in the same order.
    const binance = kraken.map((b) => ({ ...b, open: b.open * 1.001, high: b.high * 1.001, low: b.low * 1.001, close: b.close * 1.001, volume: b.volume * 1000 }));
    await insertCandles(db, "kraken", "BTC/USD", "1h", kraken);
    await insertCandles(db, "binance", "BTC/USDT", "1h", binance);
    const [row] = await overlapReport(db);
    expect(row).toMatchObject({ asset: "BTC", timeframe: "1h", overlappingBars: 30 });
    expect(row!.closeDiffMeanPct).toBeCloseTo(0.1, 1);
    expect(row!.volumeRankCorrelation).toBeCloseTo(1, 5);
    expect(row!.returnCorrelation).toBeCloseTo(1, 3);
  });

  it("reports storage size and rows per source", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(1)]);
    await insertCandles(db, "binance", "BTC/USDT", "1h", [bar(0)]);
    const report = await storageReport(db);
    expect(report.rows).toBe(3);
    expect(report.bySource).toEqual([
      { source: "binance", rows: 1 },
      { source: "kraken", rows: 2 },
    ]);
    expect(report.totalBytes).toBeGreaterThan(0);
  });

  it("remembers finished archives and active source stops", async () => {
    const now = new Date("2026-10-29T12:00:00Z");
    await recordCandleEvent(db, { kind: "archive_done", source: "kraken", ref: "A#x.csv" });
    expect([...(await loadDoneRefs(db, "kraken"))]).toEqual(["A#x.csv"]);
    expect([...(await loadDoneRefs(db, "binance"))]).toEqual([]);
    await recordCandleEvent(db, { kind: "source_stopped", source: "binance", detail: { reason: "418", until: "2099-01-01T00:00:00.000Z" } });
    await recordCandleEvent(db, { kind: "source_stopped", source: "coinbase", detail: { reason: "old", until: "2000-01-01T00:00:00.000Z" } });
    const stops = await activeSourceStops(db, now);
    expect(stops.map((s) => s.source)).toEqual(["binance"]);
  });

  it("migration 0262 can be run again without error and without touching stored bars (idempotent)", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0)]);
    const file = new URL("../../../packages/db/src/migrations/0262_trading_candle_store.sql", import.meta.url);
    const statements = readFileSync(file, "utf8").split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await latestOpenTime(db, "kraken", "BTC/USD", "1h")).toEqual(bar(0).openTime);
  });

  it("migration 0262 rolls back with the documented statements", async () => {
    await db.execute(sql`DROP TABLE trading_candle_ingest_events, trading_candles`);
    await db.execute(sql`DROP FUNCTION trading_candles_refuse_update()`);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('trading_candles', 'trading_candle_ingest_events')`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
    // Put it back for any test that follows.
    const file = new URL("../../../packages/db/src/migrations/0262_trading_candle_store.sql", import.meta.url);
    for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) await db.execute(sql.raw(statement));
  });
});
