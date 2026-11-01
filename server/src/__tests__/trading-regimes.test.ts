import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, tradingRegimes } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { insertCandles } from "../services/trading-candle-store.js";
import { currentMarketWeather, marketWeatherHistory, refreshAssetRegimes, refreshRegimes, regimeAsOf, regimeWindow } from "../services/trading-regimes.js";
import { tradingRegimeRunner } from "../services/trading-regime-runner.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const DAY = 86_400_000;
const START = Date.UTC(2023, 0, 1);

function walk(days: number, seed = 5) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
  let price = 100;
  return Array.from({ length: days }, (_, i) => {
    const open = price;
    price = Math.max(1, open * (1 + (i < 400 ? 0.004 : -0.003) + rand() * (i % 300 < 150 ? 0.03 : 0.07)));
    return { openTime: new Date(START + i * DAY), open, high: Math.max(open, price) * 1.01, low: Math.min(open, price) * 0.99, close: price, volume: 10 };
  });
}

describeDb("market weather labels in the database (DUR-5013)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: ReturnType<typeof createDb>;
  const bars = walk(900);
  const NOW = new Date(START + 900 * DAY + 3_600_000); // 01:00 on the day after the last bar closed

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-regimes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE trading_regimes, trading_candles, trading_candle_ingest_events`);
  });

  it("writes labels from the candle store, once, and a second pass changes nothing", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars);
    const first = await refreshAssetRegimes(db, "BTC", NOW);
    expect(first.source).toBe("kraken");
    expect(first.inserted).toBeGreaterThan(400);
    expect(first.revised).toBe(0);
    const again = await refreshAssetRegimes(db, "BTC", NOW);
    expect(again).toMatchObject({ inserted: 0, revised: 0 });
    const rows = await db.select().from(tradingRegimes);
    expect(rows).toHaveLength(first.inserted);
    for (const row of rows) expect(row.availableAt.getTime()).toBe(Date.parse(`${row.day}T00:00:00Z`) + DAY);
  });

  it("skips coins without enough daily history and prefers Kraken over Binance", async () => {
    await insertCandles(db, "kraken", "ETH/USD", "1d", bars.slice(0, 100));
    await insertCandles(db, "binance", "SOL/USDT", "1d", bars);
    await insertCandles(db, "kraken", "SOL/USD", "1d", bars.slice(0, 100));
    const results = await refreshRegimes(db, NOW);
    expect(results.find((r) => r.asset === "ETH")).toMatchObject({ source: null, inserted: 0 });
    expect(results.find((r) => r.asset === "SOL")?.source).toBe("binance");
    expect(results.find((r) => r.asset === "BTC")?.source).toBeNull();
  });

  it("an intraday decision reads the day before; the same day's label only appears at its close", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars);
    await refreshAssetRegimes(db, "BTC", NOW);
    const day = 700;
    const dayStart = new Date(START + day * DAY);
    const dayLabel = (await db.select().from(tradingRegimes)).find((r) => r.day === dayStart.toISOString().slice(0, 10))!;
    expect(dayLabel).toBeDefined();
    for (const offset of [0, 3_600_000, 12 * 3_600_000, DAY - 1]) {
      const read = await regimeAsOf(db, "BTC", new Date(dayStart.getTime() + offset));
      expect(read!.day).toBe(new Date(START + (day - 1) * DAY).toISOString().slice(0, 10));
    }
    expect((await regimeAsOf(db, "BTC", new Date(dayStart.getTime() + DAY)))!.day).toBe(dayLabel.day);
    expect(await regimeAsOf(db, "BTC", new Date(START + 10 * DAY))).toBeNull();
  });

  it("only publishes closed days: a bar for the day still in progress gets no label", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars);
    // 'now' is mid-way through the last stored bar's day: that bar is not closed yet.
    const midDay = new Date(START + 899 * DAY + 12 * 3_600_000);
    await refreshAssetRegimes(db, "BTC", midDay);
    const days = (await db.select().from(tradingRegimes)).map((r) => r.day).sort();
    expect(days.at(-1)).toBe(new Date(START + 898 * DAY).toISOString().slice(0, 10));
  });

  it("rewrites a past label (and says so) only when older candles arrive later", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars.slice(60));
    const first = await refreshAssetRegimes(db, "BTC", NOW);
    // The 60 older days were backfilled afterwards. Labels depend on history, so some past days change.
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars.slice(0, 60));
    const second = await refreshAssetRegimes(db, "BTC", NOW);
    expect(second.inserted + second.revised).toBeGreaterThan(0);
    const third = await refreshAssetRegimes(db, "BTC", NOW);
    expect(third).toMatchObject({ inserted: 0, revised: 0 });
    expect(first.inserted).toBeGreaterThan(0);
  });

  it("window summary covers the label in force at the start plus labels that became readable before the end", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars);
    await refreshAssetRegimes(db, "BTC", NOW);
    const from = new Date(START + 600 * DAY + 6 * 3_600_000);
    const to = new Date(START + 700 * DAY);
    const summary = await regimeWindow(db, "BTC", from, to);
    expect(summary.atStart!.day).toBe(new Date(START + 599 * DAY).toISOString().slice(0, 10));
    expect(summary.spells.length).toBeGreaterThan(0);
    // The label for day 699 closes exactly at `to`; a decision before `to` cannot read it.
    const lastDay = summary.spells.at(-1)!.endDay;
    expect(lastDay).toBe(new Date(START + 698 * DAY).toISOString().slice(0, 10));
  });

  it("serves the current text and the spell history for the Trading page", async () => {
    await insertCandles(db, "kraken", "BTC/USD", "1d", bars);
    await refreshAssetRegimes(db, "BTC", NOW);
    const items = await currentMarketWeather(db, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toMatch(/^Bitcoin: (uptrend|downtrend|sideways), (calm|normal|big) swings.*, since \d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
    const history = await marketWeatherHistory(db, "BTC", NOW, { spellLimit: 5 });
    expect(history.current!.text).toBe(items[0]!.text);
    expect(history.spells.length).toBeLessThanOrEqual(5);
    expect(history.flips.spells).toBeGreaterThan(history.spells.length - 1);
    expect(history.spells[0]!.spellNo).toBeGreaterThan(history.spells.at(-1)!.spellNo - 1);
  });

  it("the runner works about once an hour, backs off after a failure and reports its status", async () => {
    let calls = 0;
    let fail = true;
    let clock = new Date("2026-11-01T00:00:00Z");
    const runner = tradingRegimeRunner({
      db,
      logger: { info() {}, warn() {}, error() {} },
      startDelayMs: 0,
      now: () => clock,
      refresh: async () => {
        calls += 1;
        if (fail) throw new Error("boom");
        return [{ asset: "BTC", source: "kraken", bars: 10, inserted: 2, revised: 0 }];
      },
    });
    expect((await runner.tick()).started).toBe(true);
    expect(runner.status().consecutiveFailures).toBe(1);
    expect((await runner.tick()).started).toBe(false); // backing off
    fail = false;
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect(await runner.tick()).toMatchObject({ started: true, inserted: 2 });
    clock = new Date(clock.getTime() + 30 * 60_000);
    expect((await runner.tick()).started).toBe(false);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect((await runner.tick()).started).toBe(true);
    expect(calls).toBe(3);
  });
});
