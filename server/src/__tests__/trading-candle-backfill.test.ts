import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, tradingCandleIngestEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildZip } from "./helpers/zip-fixture.js";
import { fakeCandleHttp } from "./helpers/candle-fake-http.js";
import { runCandleCycle } from "../services/trading-candle-backfill.js";
import { CandleSourceStop } from "../services/trading-candle-http.js";
import { coverageReport, gapReport, listCandles } from "../services/trading-candle-store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const NOW = new Date("2026-10-29T12:01:00Z");
const HOUR = 3_600_000;
const KRAKEN = "https://assets.kraken.com/marketing/institutions/";
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function krakenCsv(startIso: string, count: number, stepMs: number, close = (i: number) => 100 + i): string {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => `${Math.floor((start + i * stepMs) / 1000)},${close(i) - 1},${close(i) + 1},${close(i) - 2},${close(i)},5,3`).join("\n") + "\n";
}

/** The Full archive: BTC at every size (the 1h file ends with a still-forming 12:00 bar), plus noise Kraken ships that we skip. */
function fullArchive(close = (i: number) => 100 + i) {
  return buildZip([
    { name: "XBTUSD_60.csv", data: krakenCsv("2026-10-27T00:00:00Z", 59, HOUR, close) }, // 00:00 on the 27th to 10:00 on the 29th
    { name: "XBTUSD_240.csv", data: krakenCsv("2026-10-20T00:00:00Z", 10, 4 * HOUR, close) },
    { name: "XBTUSD_1440.csv", data: krakenCsv("2026-10-20T00:00:00Z", 9, 24 * HOUR, close) },
    {
      name: "XBTUSD_5.csv",
      data: "1577836800,1,2,0.5,1.5,1,1\n" + krakenCsv("2026-10-29T09:00:00Z", 36, 5 * 60_000, close), // one bar from 2020 (too old), then 09:00..11:55 (the 12:00 bar would still be forming)
    },
    { name: "XBTUSD_1.csv", data: krakenCsv("2026-10-29T09:00:00Z", 10, 60_000) },
    { name: "SOMETHINGELSE_60.csv", data: krakenCsv("2026-10-29T09:00:00Z", 10, HOUR) },
  ]);
}

function split(zip: Buffer): [Buffer, Buffer] {
  const mid = Math.floor(zip.length / 2);
  return [zip.subarray(0, mid), zip.subarray(mid)];
}

function krakenRest(extra: Record<string, number[][]> = {}) {
  return (url: string) => {
    const pair = /pair=([A-Z]+)/.exec(url)![1]!;
    const interval = /interval=(\d+)/.exec(url)![1]!;
    const rows = extra[`${pair}:${interval}`] ?? [];
    return { error: [], result: { [`X${pair}Z`]: rows, last: 0 } };
  };
}

describeDb("trading candle backfill (DUR-5007)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-candle-backfill-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
  });

  function routes(overrides: Record<string, unknown> = {}) {
    const [part0, part1] = split(fullArchive());
    return {
      [`${KRAKEN}Kraken_OHLCVT_Full.zip.part00`]: part0,
      [`${KRAKEN}Kraken_OHLCVT_Full.zip.part01`]: part1,
      [`${KRAKEN}Kraken_OHLCVT_2026Q3.zip`]: buildZip([{ name: "XBTUSD_240.csv", data: krakenCsv("2026-10-19T16:00:00Z", 2, 4 * HOUR) }]),
      "https://api.kraken.com/0/public/OHLC": krakenRest({
        // 11:00 is closed and new; 12:00 is the bar forming right now.
        "XBTUSD:60": [[secs("2026-10-29T11:00:00Z"), 1, 2, 0.5, 1.5, 1.2, 7, 3], [secs("2026-10-29T12:00:00Z"), 1, 2, 0.5, 1.5, 1.2, 7, 3]],
      }),
      "https://data-api.binance.vision/api/v3/klines": [],
      "https://api.exchange.coinbase.com/products/": [],
      ...overrides,
    };
  }

  function cycle(http: ReturnType<typeof fakeCandleHttp>["http"], extra: Partial<Parameters<typeof runCandleCycle>[0]> = {}) {
    return runCandleCycle({ db, http, now: () => NOW, sleep: async () => {}, pauseMs: 0, assets: ["BTC", "DOT"], ...extra });
  }

  it("backfills Kraken from the archive, drops the forming bar and 5m bars older than two years, then tops up from the live feed", async () => {
    const { http } = fakeCandleHttp(routes());
    const result = await cycle(http);
    expect(result.errors).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.corrections).toBe(0);

    const hourly = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "1h", limit: 1000 });
    // 59 archive bars (27th 00:00 .. 29th 10:00) + the closed 11:00 bar from the live feed; no 12:00.
    expect(hourly).toHaveLength(60);
    expect(hourly[0]!.openTime.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(hourly.at(-1)!.openTime.toISOString()).toBe("2026-10-29T11:00:00.000Z");
    expect(hourly.at(-1)!.volume).toBe(7);

    const fiveMinute = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "5m", limit: 1000 });
    expect(fiveMinute).toHaveLength(36);
    expect(fiveMinute[0]!.openTime.toISOString()).toBe("2026-10-29T09:00:00.000Z");

    // The later quarterly archive adds its 4h bars on top of the Full one.
    const fourHour = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "4h", limit: 1000 });
    expect(fourHour.map((b) => b.openTime.toISOString())).toContain("2026-10-19T20:00:00.000Z");

    const coverage = await coverageReport(db, { source: "kraken", timeframe: "1d" });
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.market).toBe("BTC/USD");
  });

  it("does the work only once: a second cycle re-reads no archive entry and adds nothing", async () => {
    const first = fakeCandleHttp(routes());
    await cycle(first.http);
    const second = fakeCandleHttp(routes());
    const again = await cycle(second.http);
    expect(again).toMatchObject({ inserted: 0, entriesDone: 0, corrections: 0 });
    expect(again.complete).toBe(true);
    // Only the archive index is looked at (HEAD), no file bytes are fetched twice.
    const events = await db.select().from(tradingCandleIngestEvents);
    expect(events.filter((e) => e.kind === "archive_done" && e.ref?.includes("#XBTUSD_60.csv"))).toHaveLength(1);
  });

  it("resumes after an interruption without duplicating or skipping anything", async () => {
    // The connection dies partway through.
    const flaky = fakeCandleHttp(routes(), { failAfter: 14 });
    const interrupted = await cycle(flaky.http);
    expect(interrupted.errors.length).toBeGreaterThan(0);
    expect(interrupted.complete).toBe(false);
    const doneBefore = (await db.select().from(tradingCandleIngestEvents)).filter((e) => e.kind === "archive_done").length;

    const healthy = fakeCandleHttp(routes());
    const resumed = await cycle(healthy.http);
    expect(resumed.errors).toEqual([]);
    expect(resumed.complete).toBe(true);
    expect((await db.select().from(tradingCandleIngestEvents)).filter((e) => e.kind === "archive_done").length).toBeGreaterThan(doneBefore);

    const clean = fakeCandleHttp(routes());
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
    await cycle(clean.http);
    const reference = await db.execute(sql`SELECT source, market, timeframe, count(*)::int AS n FROM trading_candles GROUP BY 1,2,3 ORDER BY 1,2,3`);
    const gaps = await gapReport(db);
    expect(gaps.gaps.filter((g) => g.explanation === null)).toEqual([]);
    // The interrupted-then-resumed store must hold exactly what a clean run holds.
    const referenceRows = JSON.stringify(reference);
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
    await cycle(fakeCandleHttp(routes(), { failAfter: 14 }).http);
    await cycle(fakeCandleHttp(routes()).http);
    expect(JSON.stringify(await db.execute(sql`SELECT source, market, timeframe, count(*)::int AS n FROM trading_candles GROUP BY 1,2,3 ORDER BY 1,2,3`))).toBe(referenceRows);
  });

  it("logs a correction and keeps the stored bar when a republished archive disagrees", async () => {
    await cycle(fakeCandleHttp(routes()).http);
    const [part0, part1] = split(fullArchive((i) => 500 + i));
    const republished = routes({ [`${KRAKEN}Kraken_OHLCVT_Full.zip.part00`]: part0, [`${KRAKEN}Kraken_OHLCVT_Full.zip.part01`]: part1 });
    const result = await cycle(fakeCandleHttp(republished).http);
    expect(result.corrections).toBeGreaterThan(0);
    const [first] = await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "1h", limit: 1 });
    expect(first!.close).toBe(100);
    expect((await db.select().from(tradingCandleIngestEvents)).some((e) => e.kind === "correction")).toBe(true);
  });

  it("notes the seam when the live feed cannot reach back to the newest archive bar", async () => {
    const rows = Array.from({ length: 720 }, (_, i) => [secs("2026-10-27T00:00:00Z") + i * 300, 1, 2, 0.5, 1.5, 1.2, 7, 3]);
    const { http } = fakeCandleHttp(routes({ "https://api.kraken.com/0/public/OHLC": krakenRest({ "XBTUSD:5": rows }) }));
    await cycle(http);
    const notes = (await db.select().from(tradingCandleIngestEvents)).filter((e) => e.kind === "gap_note");
    expect(notes.some((n) => n.timeframe === "5m" && n.market === "BTC/USD")).toBe(false); // archive already reaches 11:55, nothing missing

    // Now an archive that only reached the 20th, and a feed that starts on the 27th.
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
    const old = buildZip([{ name: "XBTUSD_5.csv", data: krakenCsv("2026-10-20T00:00:00Z", 12, 300_000) }]);
    const seam = fakeCandleHttp(
      routes({
        [`${KRAKEN}Kraken_OHLCVT_Full.zip.part00`]: old,
        [`${KRAKEN}Kraken_OHLCVT_Full.zip.part01`]: null,
        [`${KRAKEN}Kraken_OHLCVT_2026Q3.zip`]: null,
        "https://api.kraken.com/0/public/OHLC": krakenRest({ "XBTUSD:5": rows }),
      }),
    );
    await cycle(seam.http);
    const seamNotes = (await db.select().from(tradingCandleIngestEvents)).filter((e) => e.kind === "gap_note");
    expect(seamNotes).toHaveLength(1);
    expect(seamNotes[0]).toMatchObject({ source: "kraken", market: "BTC/USD", timeframe: "5m" });
    const report = await gapReport(db, { source: "kraken", timeframe: "5m" });
    const big = report.gaps.find((g) => g.missingBars > 1000)!;
    expect(big.explanation).toMatch(/720 bars/);
  });

  it("imports Binance monthly archives (microsecond timestamps from 2025 on), tops up from the REST API and never stores a forming bar", async () => {
    const augCsv = (start: string, days: number) =>
      Array.from({ length: days }, (_, i) => {
        const open = Date.parse(start) + i * 24 * HOUR;
        return `${open * 1000},10,12,9,11,100,${(open + 24 * HOUR - 1) * 1000},1,1,1,1,0`;
      }).join("\n") + "\n";
    const firstBar = Date.parse("2026-08-30T00:00:00Z");
    const { http, calls } = fakeCandleHttp(
      routes({
        "https://data-api.binance.vision/api/v3/klines": (url: string) => {
          if (url.includes("symbol=DOTUSDT")) return [];
          if (url.includes("startTime=0")) return [[firstBar, "10", "12", "9", "11", "100", firstBar + 1]];
          // Live REST: the 28th is closed, the 29th is still forming.
          const day = (iso: string) => [Date.parse(iso), "10", "12", "9", "11", "100", 0];
          return url.includes("interval=1d") ? [day("2026-10-28T00:00:00Z"), day("2026-10-29T00:00:00Z")] : [];
        },
        "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2026-08.zip": buildZip([{ name: "BTCUSDT-1d-2026-08.csv", data: augCsv("2026-08-30T00:00:00Z", 2) }]),
        "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2026-09.zip": buildZip([{ name: "BTCUSDT-1d-2026-09.csv", data: "open_time,open,high,low,close,volume\n" + augCsv("2026-09-01T00:00:00Z", 30) }]),
        "https://data.binance.vision/data/spot/monthly/klines/": null,
      }),
    );
    const result = await cycle(http);
    expect(result.errors).toEqual([]);
    const daily = await listCandles(db, { source: "binance", market: "BTC/USDT", timeframe: "1d", limit: 1000 });
    expect(daily[0]!.openTime.toISOString()).toBe("2026-08-30T00:00:00.000Z");
    expect(daily.at(-1)!.openTime.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(daily.some((b) => b.openTime.toISOString() === "2026-10-29T00:00:00.000Z")).toBe(false);
    // Months whose file does not exist yet are written off once they are old enough, not asked for forever.
    const missing = (await db.select().from(tradingCandleIngestEvents)).filter((e) => e.detail.missing === true);
    expect(missing.length).toBeGreaterThan(0);
    expect(calls.some((url) => url.includes("2026-10.zip"))).toBe(false); // October has not ended
  });

  it("stops a source that answers 418, records it, carries on with the others and leaves it alone next time", async () => {
    const ban = () => {
      throw new CandleSourceStop("binance", 418, new Date("2026-10-29T18:00:00Z"), "data-api.binance.vision answered 418; leaving this source alone.");
    };
    const banned = fakeCandleHttp(routes({ "https://data-api.binance.vision/api/v3/klines": ban }));
    const result = await cycle(banned.http);
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]).toMatchObject({ source: "binance", until: "2026-10-29T18:00:00.000Z" });
    expect(result.complete).toBe(false);
    expect((await listCandles(db, { source: "kraken", market: "BTC/USD", timeframe: "1h", limit: 5 })).length).toBe(5); // Kraken was not held up

    const next = fakeCandleHttp(routes({ "https://data-api.binance.vision/api/v3/klines": ban }));
    const again = await cycle(next.http);
    expect(again.stops).toHaveLength(1);
    expect(next.calls.filter((url) => url.includes("binance"))).toEqual([]);

    // Once the ban has passed, Binance is asked again.
    const later = await runCandleCycle({ db, http: fakeCandleHttp(routes()).http, now: () => new Date("2026-10-29T19:00:00Z"), sleep: async () => {}, pauseMs: 0, assets: ["BTC"] });
    expect(later.stops).toEqual([]);
  });

  it("falls back to Coinbase only for a coin Kraken has no bars for", async () => {
    let page = 0;
    const { http, calls } = fakeCandleHttp(
      routes({
        "https://api.exchange.coinbase.com/products/DOT-USD/candles?granularity=3600": () => {
          page += 1;
          // Coinbase's columns: time, low, high, open, close, volume.
          return page === 1 ? [[secs("2026-10-29T10:00:00Z"), 4, 6, 5, 5.5, 20], [secs("2026-10-29T09:00:00Z"), 4, 6, 5, 5.2, 21], [secs("2026-10-29T12:00:00Z"), 4, 6, 5, 5.2, 21]] : [];
        },
        "https://api.exchange.coinbase.com/products/DOT-USD/candles?granularity=86400": [],
      }),
    );
    await cycle(http);
    const bars = await listCandles(db, { source: "coinbase", market: "DOT/USD", timeframe: "1h", limit: 10 });
    expect(bars.map((b) => [b.openTime.toISOString(), b.open, b.high, b.low, b.close])).toEqual([
      ["2026-10-29T09:00:00.000Z", 5, 6, 4, 5.2],
      ["2026-10-29T10:00:00.000Z", 5, 6, 4, 5.5],
    ]);
    expect(calls.some((url) => url.includes("BTC-USD"))).toBe(false);
  });

  it("stops cleanly when its time budget is spent", async () => {
    const { http } = fakeCandleHttp(routes());
    const result = await cycle(http, { budgetMs: -1 });
    expect(result.timedOut).toBe(true);
    expect(result.complete).toBe(false);
  });
});
