import type { Db } from "@paperclipai/db";
import {
  TRADING_ASSETS,
  TRADING_CANDLE_5M_HISTORY_DAYS,
  TRADING_CANDLE_TIMEFRAMES,
  binanceSymbolForAsset,
  coinbaseProductForAsset,
  krakenPairForAsset,
  tradingCandleMarket,
  tradingCandleTimeframeMs,
  type TradingAsset,
  type TradingCandleSource,
  type TradingCandleStopNotice,
  type TradingCandleTimeframe,
  type TradingStoredCandle,
} from "@paperclipai/shared";
import { candleLog as logger } from "./trading-candle-log.js";
import { CandleHttpError, CandleSourceStop, type CandleHttp } from "./trading-candle-http.js";
import {
  INSERT_BATCH,
  activeSourceStops,
  earliestOpenTime,
  insertCandles,
  latestOpenTime,
  loadDoneRefs,
  recordCandleEvent,
} from "./trading-candle-store.js";
import { bufferSource, listZipEntries, readLines, readZipEntry, type RandomAccess, type ZipEntry } from "./trading-candle-zip.js";

/**
 * The candle store's backfill and top-up (DUR-5007). One call to
 * runCandleCycle() does as much as its time budget allows and can be stopped at
 * any point: finished archive entries are logged, everything else is skipped
 * quickly on the next call, so an interruption only repeats the entry it was in.
 *
 * Order matters: Kraken's archives first (the same exchange as live), then
 * Kraken's live feed from the newest stored bar, then Binance (cross-check and
 * longer history, internal tests only), then Coinbase for any coin Kraken has
 * no history for. A source that answers 418/451 is left alone and logged.
 */

export interface CandleCycleOptions {
  db: Db;
  http: CandleHttp;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget; the cycle stops cleanly between batches once it is spent. */
  budgetMs?: number;
  /** Pause after every database batch, so the backfill never hogs the database. */
  pauseMs?: number;
  assets?: readonly TradingAsset[];
  /** Check Kraken's archive index and import new archive entries. The live top-up runs every cycle. */
  runArchives?: boolean;
  onProgress?: (message: string) => void;
}

export interface CandleCycleResult {
  inserted: number;
  corrections: number;
  invalid: number;
  entriesDone: number;
  stops: TradingCandleStopNotice[];
  errors: string[];
  timedOut: boolean;
  /** True when every stage ran to the end: nothing more to backfill right now. */
  complete: boolean;
}

class CycleTimeout extends Error {}

const KRAKEN_ASSETS_BASE = "https://assets.kraken.com/marketing/institutions/";
const KRAKEN_REST = "https://api.kraken.com/0/public/OHLC";
const BINANCE_ARCHIVE = "https://data.binance.vision/data/spot/monthly/klines";
const BINANCE_REST = "https://data-api.binance.vision/api/v3/klines";
const COINBASE_REST = "https://api.exchange.coinbase.com/products";
/** The Full archive runs through 30 June 2026; only later quarters are fetched on top of it. */
const KRAKEN_FULL_THROUGH = { year: 2026, quarter: 2 };
const KRAKEN_MAX_PARTS = 20;
/** The biggest candle file (BTC 5m since 2013) is well under 100 MB; anything past this is not a candle file. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const KRAKEN_INTERVAL_MINUTES: Record<TradingCandleTimeframe, number> = { "5m": 5, "1h": 60, "4h": 240, "1d": 1440 };
const KRAKEN_REST_WINDOW = 720;
const BINANCE_TIMEFRAMES: readonly TradingCandleTimeframe[] = ["1h", "4h", "1d"];
const BINANCE_WEIGHT_LIMIT = 4800;
const COINBASE_GRANULARITY: Partial<Record<TradingCandleTimeframe, number>> = { "1h": 3600, "1d": 86400 };
const COINBASE_PAGE = 300;
const REST_GRACE_MS = 20_000;
/** A month file missing this long after the month ended is treated as never published. */
const BINANCE_MISSING_FILE_GRACE_MS = 5 * 24 * 3_600_000;

type Ctx = Required<Pick<CandleCycleOptions, "db" | "http" | "pauseMs">> & {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  deadline: number;
  assets: readonly TradingAsset[];
  result: CandleCycleResult;
  progress: (message: string) => void;
};

function timeLeft(ctx: Ctx): void {
  if (Date.now() >= ctx.deadline) throw new CycleTimeout();
}

function isClosed(openTime: Date, timeframe: TradingCandleTimeframe, now: Date): boolean {
  return openTime.getTime() + tradingCandleTimeframeMs(timeframe) <= now.getTime();
}

function oldest5mAllowed(now: Date): Date {
  const step = tradingCandleTimeframeMs("5m");
  const cutoff = now.getTime() - TRADING_CANDLE_5M_HISTORY_DAYS * 24 * 3_600_000;
  return new Date(Math.floor(cutoff / step) * step);
}

async function store(ctx: Ctx, source: TradingCandleSource, market: string, timeframe: TradingCandleTimeframe, bars: TradingStoredCandle[]): Promise<void> {
  if (bars.length === 0) return;
  const outcome = await insertCandles(ctx.db, source, market, timeframe, bars);
  ctx.result.inserted += outcome.inserted;
  ctx.result.corrections += outcome.corrections;
  ctx.result.invalid += outcome.invalid;
  await ctx.sleep(ctx.pauseMs);
  timeLeft(ctx);
}

function numbers(cols: string[], from: number, count: number): number[] | null {
  const out: number[] = [];
  for (let i = from; i < from + count; i++) {
    const value = Number(cols[i]);
    if (cols[i] === undefined || cols[i] === "" || !Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

// ─── Kraken archives ────────────────────────────────────────────────────────

interface KrakenArchive {
  id: string;
  source: RandomAccess;
}

function partsSource(http: CandleHttp, parts: Array<{ url: string; size: number }>): RandomAccess {
  const size = parts.reduce((sum, part) => sum + part.size, 0);
  return {
    size,
    async read(start, length) {
      const buffers: Buffer[] = [];
      let offset = 0;
      let remaining = length;
      let cursor = start;
      for (const part of parts) {
        if (remaining <= 0) break;
        const partEnd = offset + part.size;
        if (cursor < partEnd) {
          const take = Math.min(remaining, partEnd - cursor);
          buffers.push(await http.getRange(part.url, cursor - offset, take));
          cursor += take;
          remaining -= take;
        }
        offset = partEnd;
      }
      return Buffer.concat(buffers);
    },
  };
}

async function discoverKrakenArchives(ctx: Ctx): Promise<KrakenArchive[]> {
  const archives: KrakenArchive[] = [];
  const parts: Array<{ url: string; size: number }> = [];
  for (let i = 0; i < KRAKEN_MAX_PARTS; i++) {
    const url = `${KRAKEN_ASSETS_BASE}Kraken_OHLCVT_Full.zip.part${String(i).padStart(2, "0")}`;
    const size = await ctx.http.headSize(url);
    if (size === null) break;
    parts.push({ url, size });
  }
  if (parts.length > 0) {
    archives.push({ id: `Kraken_OHLCVT_Full.zip@${parts.reduce((sum, p) => sum + p.size, 0)}`, source: partsSource(ctx.http, parts) });
  }
  const now = ctx.now();
  for (let year = KRAKEN_FULL_THROUGH.year; year <= now.getUTCFullYear(); year++) {
    for (let quarter = 1; quarter <= 4; quarter++) {
      if (year === KRAKEN_FULL_THROUGH.year && quarter <= KRAKEN_FULL_THROUGH.quarter) continue;
      // Kraken publishes a quarter after it ends.
      if (Date.UTC(year, quarter * 3, 1) > now.getTime()) continue;
      const name = `Kraken_OHLCVT_${year}Q${quarter}.zip`;
      const url = `${KRAKEN_ASSETS_BASE}${name}`;
      const size = await ctx.http.headSize(url);
      if (size === null) continue;
      archives.push({ id: `${name}@${size}`, source: partsSource(ctx.http, [{ url, size }]) });
    }
  }
  return archives;
}

const KRAKEN_FILE = /^(?:.*\/)?([A-Z0-9]+)_(5|60|240|1440)\.csv$/;
const KRAKEN_FILE_TIMEFRAME: Record<string, TradingCandleTimeframe> = { "5": "5m", "60": "1h", "240": "4h", "1440": "1d" };

async function importKrakenEntry(ctx: Ctx, archive: KrakenArchive, entry: ZipEntry, asset: TradingAsset, timeframe: TradingCandleTimeframe, ref: string): Promise<void> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new CandleHttpError(null, `Kraken archive entry ${entry.name} is larger than any candle file should be.`);
  const market = tradingCandleMarket("kraken", asset);
  const now = ctx.now();
  const oldest = timeframe === "5m" ? oldest5mAllowed(now) : null;
  let batch: TradingStoredCandle[] = [];
  let before = { inserted: ctx.result.inserted, corrections: ctx.result.corrections, invalid: ctx.result.invalid };
  let unreadable = 0;
  for await (const line of readLines(readZipEntry(archive.source, entry))) {
    const cols = line.split(",");
    const values = numbers(cols, 0, 6);
    if (!values) {
      if (line.trim() !== "") unreadable += 1;
      continue;
    }
    const [seconds, open, high, low, close, volume] = values as [number, number, number, number, number, number];
    const openTime = new Date(seconds * 1000);
    if (Number.isNaN(openTime.getTime()) || (oldest && openTime < oldest) || !isClosed(openTime, timeframe, now)) continue;
    batch.push({ openTime, open, high, low, close, volume });
    if (batch.length >= INSERT_BATCH) {
      await store(ctx, "kraken", market, timeframe, batch);
      batch = [];
    }
  }
  await store(ctx, "kraken", market, timeframe, batch);
  const detail = {
    inserted: ctx.result.inserted - before.inserted,
    corrections: ctx.result.corrections - before.corrections,
    invalid: ctx.result.invalid - before.invalid + unreadable,
  };
  if (detail.invalid > 0) await recordCandleEvent(ctx.db, { kind: "invalid_bars", source: "kraken", market, timeframe, ref, detail });
  await recordCandleEvent(ctx.db, { kind: "archive_done", source: "kraken", market, timeframe, ref, detail });
  ctx.result.entriesDone += 1;
  ctx.progress(`kraken ${market} ${timeframe}: ${detail.inserted} new bars from ${ref}`);
}

async function krakenArchiveStage(ctx: Ctx): Promise<void> {
  const done = await loadDoneRefs(ctx.db, "kraken");
  const archives = await discoverKrakenArchives(ctx);
  for (const archive of archives) {
    const completeRef = `${archive.id}#all`;
    if (done.has(completeRef)) continue;
    const entries = await listZipEntries(archive.source);
    const wanted = new Map<string, { entry: ZipEntry; asset: TradingAsset; timeframe: TradingCandleTimeframe }>();
    for (const entry of entries) {
      const match = KRAKEN_FILE.exec(entry.name);
      if (!match) continue;
      const asset = ctx.assets.find((candidate) => krakenPairForAsset(candidate) === match[1]);
      if (asset) wanted.set(entry.name, { entry, asset, timeframe: KRAKEN_FILE_TIMEFRAME[match[2]!]! });
    }
    // Order by coin, then bar size, so a partly finished run is easy to read.
    const todo = [...wanted.values()].sort((a, b) => a.asset.localeCompare(b.asset) || a.timeframe.localeCompare(b.timeframe));
    for (const item of todo) {
      const ref = `${archive.id}#${item.entry.name}`;
      if (done.has(ref)) continue;
      timeLeft(ctx);
      await importKrakenEntry(ctx, archive, item.entry, item.asset, item.timeframe, ref);
      done.add(ref);
    }
    await recordCandleEvent(ctx.db, { kind: "archive_done", source: "kraken", ref: completeRef, detail: { entries: todo.length } });
  }
}

// ─── Kraken live feed ───────────────────────────────────────────────────────

async function krakenTopUp(ctx: Ctx): Promise<void> {
  for (const asset of ctx.assets) {
    const pair = krakenPairForAsset(asset);
    const market = tradingCandleMarket("kraken", asset);
    for (const timeframe of TRADING_CANDLE_TIMEFRAMES) {
      timeLeft(ctx);
      const step = tradingCandleTimeframeMs(timeframe);
      const last = await latestOpenTime(ctx.db, "kraken", market, timeframe);
      // The next bar closes at last + 2 steps.
      if (last && ctx.now().getTime() < last.getTime() + 2 * step + REST_GRACE_MS) continue;
      const url = `${KRAKEN_REST}?pair=${pair}&interval=${KRAKEN_INTERVAL_MINUTES[timeframe]}${last ? `&since=${Math.floor(last.getTime() / 1000)}` : ""}`;
      let body = (await ctx.http.getJson(url)) as { error?: string[]; result?: Record<string, unknown> } | null;
      if (body?.error?.some((e) => /rate limit|too many/i.test(e))) {
        await ctx.sleep(30_000);
        body = (await ctx.http.getJson(url)) as typeof body;
      }
      if (!body || (body.error && body.error.length > 0) || !body.result) {
        throw new CandleHttpError(null, `Kraken live feed refused ${pair} ${timeframe}: ${body?.error?.join(", ") ?? "no answer"}`);
      }
      const key = Object.keys(body.result).find((k) => k !== "last");
      const rows = key && Array.isArray(body.result[key]) ? (body.result[key] as unknown[]) : [];
      const now = ctx.now();
      const bars: TradingStoredCandle[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const values = numbers(row.map(String), 0, 7);
        if (!values) continue;
        const openTime = new Date(values[0]! * 1000);
        // Kraken's REST column order is time, open, high, low, close, vwap, volume.
        if (isClosed(openTime, timeframe, now)) bars.push({ openTime, open: values[1]!, high: values[2]!, low: values[3]!, close: values[4]!, volume: values[6]! });
      }
      if (last && bars.length >= KRAKEN_REST_WINDOW - 1 && bars[0]!.openTime.getTime() > last.getTime() + step) {
        // The live feed only reaches back 720 bars, so the bars between the newest archive bar and its first bar cannot be fetched until Kraken publishes the next archive.
        await recordCandleEvent(ctx.db, {
          kind: "gap_note",
          source: "kraken",
          market,
          timeframe,
          openTime: last,
          detail: { reason: "Kraken's live feed only reaches back 720 bars; the next quarterly archive fills this.", filledFrom: bars[0]!.openTime.toISOString() },
        });
      }
      await store(ctx, "kraken", market, timeframe, bars);
      await ctx.sleep(1100);
    }
  }
}

// ─── Binance ────────────────────────────────────────────────────────────────

let binanceWeight = 0;
let binanceWeightAt = 0;

async function binancePace(ctx: Ctx): Promise<void> {
  if (Date.now() - binanceWeightAt > 60_000) binanceWeight = 0;
  if (binanceWeight > BINANCE_WEIGHT_LIMIT) {
    await ctx.sleep(Math.max(1000, 61_000 - (Date.now() - binanceWeightAt)));
    binanceWeight = 0;
  }
}

export function noteBinanceWeight(used: number): void {
  binanceWeight = used;
  binanceWeightAt = Date.now();
}

function binanceBar(row: unknown): TradingStoredCandle | null {
  if (!Array.isArray(row)) return null;
  const values = numbers(row.map(String), 0, 6);
  if (!values) return null;
  // Spot archives switched to microseconds in 2025; the REST API stays in milliseconds.
  const ms = values[0]! > 1e14 ? Math.floor(values[0]! / 1000) : values[0]!;
  return { openTime: new Date(ms), open: values[1]!, high: values[2]!, low: values[3]!, close: values[4]!, volume: values[5]! };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

async function binanceFirstBar(ctx: Ctx, symbol: string): Promise<Date | null> {
  await binancePace(ctx);
  let rows: unknown[] | null;
  try {
    rows = (await ctx.http.getJson(`${BINANCE_REST}?symbol=${symbol}&interval=1d&startTime=0&limit=1`)) as unknown[] | null;
  } catch (err) {
    // 400 = Binance has no such symbol; that coin simply has no Binance history.
    if (err instanceof CandleHttpError && err.status === 400) return null;
    throw err;
  }
  const bar = rows && rows.length > 0 ? binanceBar(rows[0]) : null;
  return bar?.openTime ?? null;
}

async function binanceArchiveStage(ctx: Ctx): Promise<void> {
  const done = await loadDoneRefs(ctx.db, "binance");
  const now = ctx.now();
  for (const asset of ctx.assets) {
    const symbol = binanceSymbolForAsset(asset);
    const market = tradingCandleMarket("binance", asset);
    let first: Date | null | undefined;
    for (const timeframe of BINANCE_TIMEFRAMES) {
      first ??= await binanceFirstBar(ctx, symbol);
      if (!first) break;
      for (let index = first.getUTCFullYear() * 12 + first.getUTCMonth(); ; index++) {
        const year = Math.floor(index / 12);
        const month = index % 12;
        // Only months that have ended have a complete archive.
        if (Date.UTC(year, month + 1, 1) > now.getTime()) break;
        const key = monthKey(year, month);
        const ref = `binance:${symbol}:${timeframe}:${key}`;
        if (done.has(ref)) continue;
        timeLeft(ctx);
        const url = `${BINANCE_ARCHIVE}/${symbol}/${timeframe}/${symbol}-${timeframe}-${key}.zip`;
        const bytes = await ctx.http.getBytes(url);
        if (!bytes) {
          // Not published (yet). A recent month is retried next cycle; an old one is written off.
          if (now.getTime() - Date.UTC(year, month + 1, 1) > BINANCE_MISSING_FILE_GRACE_MS) {
            await recordCandleEvent(ctx.db, { kind: "archive_done", source: "binance", market, timeframe, ref, detail: { missing: true } });
            done.add(ref);
          }
          continue;
        }
        const archive = bufferSource(bytes);
        const entry = (await listZipEntries(archive)).find((e) => /\.csv$/.test(e.name));
        if (!entry) throw new CandleHttpError(null, `Binance archive ${ref} has no data file.`);
        const bars: TradingStoredCandle[] = [];
        let unreadable = 0;
        for await (const line of readLines(readZipEntry(archive, entry))) {
          const bar = binanceBar(line.split(","));
          if (bar && isClosed(bar.openTime, timeframe, now)) bars.push(bar);
          else if (line.trim() !== "" && !bar && !/^[a-z_]/i.test(line)) unreadable += 1;
        }
        const before = ctx.result.inserted;
        await store(ctx, "binance", market, timeframe, bars);
        await recordCandleEvent(ctx.db, { kind: "archive_done", source: "binance", market, timeframe, ref, detail: { inserted: ctx.result.inserted - before, unreadable } });
        done.add(ref);
        ctx.result.entriesDone += 1;
        await ctx.sleep(200);
      }
    }
  }
}

async function binanceTopUp(ctx: Ctx): Promise<void> {
  for (const asset of ctx.assets) {
    const symbol = binanceSymbolForAsset(asset);
    const market = tradingCandleMarket("binance", asset);
    for (const timeframe of BINANCE_TIMEFRAMES) {
      const step = tradingCandleTimeframeMs(timeframe);
      for (;;) {
        timeLeft(ctx);
        const last = await latestOpenTime(ctx.db, "binance", market, timeframe);
        if (last && ctx.now().getTime() < last.getTime() + 2 * step + REST_GRACE_MS) break;
        await binancePace(ctx);
        const start = last ? last.getTime() + step : 0;
        const rows = (await ctx.http.getJson(`${BINANCE_REST}?symbol=${symbol}&interval=${timeframe}&startTime=${start}&limit=1000`)) as unknown[] | null;
        if (!rows || rows.length === 0) break;
        const now = ctx.now();
        const bars = rows.flatMap((row) => {
          const bar = binanceBar(row);
          return bar && isClosed(bar.openTime, timeframe, now) ? [bar] : [];
        });
        await store(ctx, "binance", market, timeframe, bars);
        if (rows.length < 1000 || bars.length === 0) break;
        await ctx.sleep(250);
      }
    }
  }
}

// ─── Coinbase fallback ──────────────────────────────────────────────────────

/** Only for a coin Kraken has no bars for in that bar size, paging back from now until Coinbase has nothing older. */
async function coinbaseFallbackStage(ctx: Ctx): Promise<void> {
  const done = await loadDoneRefs(ctx.db, "coinbase");
  const now = ctx.now();
  for (const asset of ctx.assets) {
    for (const timeframe of TRADING_CANDLE_TIMEFRAMES) {
      const granularity = COINBASE_GRANULARITY[timeframe];
      if (!granularity) continue;
      const krakenMarket = tradingCandleMarket("kraken", asset);
      if (await earliestOpenTime(ctx.db, "kraken", krakenMarket, timeframe)) continue;
      const product = coinbaseProductForAsset(asset);
      const market = tradingCandleMarket("coinbase", asset);
      const ref = `coinbase:${product}:${timeframe}`;
      if (done.has(ref)) continue;
      const step = tradingCandleTimeframeMs(timeframe);
      for (;;) {
        timeLeft(ctx);
        const oldest = await earliestOpenTime(ctx.db, "coinbase", market, timeframe);
        const end = oldest ?? new Date(Math.floor(now.getTime() / step) * step);
        const start = new Date(end.getTime() - COINBASE_PAGE * step);
        const rows = (await ctx.http.getJson(`${COINBASE_REST}/${product}/candles?granularity=${granularity}&start=${start.toISOString()}&end=${new Date(end.getTime() - (oldest ? step : 0)).toISOString()}`)) as unknown[] | null;
        const bars: TradingStoredCandle[] = [];
        for (const row of rows ?? []) {
          if (!Array.isArray(row)) continue;
          const values = numbers(row.map(String), 0, 6);
          if (!values) continue;
          // Coinbase's column order is time, low, high, open, close, volume.
          const openTime = new Date(values[0]! * 1000);
          if (isClosed(openTime, timeframe, now)) bars.push({ openTime, low: values[1]!, high: values[2]!, open: values[3]!, close: values[4]!, volume: values[5]! });
        }
        if (bars.length === 0) {
          // Nothing older: this coin/size is as far back as Coinbase goes.
          await recordCandleEvent(ctx.db, { kind: "archive_done", source: "coinbase", market, timeframe, ref, detail: { reachedStart: true } });
          done.add(ref);
          break;
        }
        bars.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
        await store(ctx, "coinbase", market, timeframe, bars);
        await ctx.sleep(250);
      }
    }
  }
}

// ─── The cycle ──────────────────────────────────────────────────────────────

export async function runCandleCycle(options: CandleCycleOptions): Promise<CandleCycleResult> {
  const result: CandleCycleResult = { inserted: 0, corrections: 0, invalid: 0, entriesDone: 0, stops: [], errors: [], timedOut: false, complete: false };
  const ctx: Ctx = {
    db: options.db,
    http: options.http,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    deadline: Date.now() + (options.budgetMs ?? 10 * 60_000),
    pauseMs: options.pauseMs ?? 25,
    assets: options.assets ?? TRADING_ASSETS,
    result,
    progress: options.onProgress ?? (() => {}),
  };
  const stopped = new Map((await activeSourceStops(ctx.db, ctx.now())).map((stop) => [stop.source, stop]));
  result.stops.push(...stopped.values());

  const stages: Array<{ source: TradingCandleSource; name: string; run: (c: Ctx) => Promise<void>; enabled: boolean }> = [
    { source: "kraken", name: "kraken archives", run: krakenArchiveStage, enabled: options.runArchives !== false },
    { source: "kraken", name: "kraken live feed", run: krakenTopUp, enabled: true },
    { source: "binance", name: "binance archives", run: binanceArchiveStage, enabled: options.runArchives !== false },
    { source: "binance", name: "binance live feed", run: binanceTopUp, enabled: true },
    { source: "coinbase", name: "coinbase fallback", run: coinbaseFallbackStage, enabled: options.runArchives !== false },
  ];
  // A stage that fails leaves later stages of the same source alone this cycle (they build on it).
  const failedSources = new Set<TradingCandleSource>();
  let allRan = true;
  for (const stage of stages) {
    if (!stage.enabled) continue;
    if (stopped.has(stage.source) || failedSources.has(stage.source)) {
      allRan = false;
      continue;
    }
    try {
      await stage.run(ctx);
    } catch (err) {
      allRan = false;
      failedSources.add(stage.source);
      if (err instanceof CycleTimeout) {
        result.timedOut = true;
        break;
      }
      if (err instanceof CandleSourceStop) {
        const notice: TradingCandleStopNotice = { source: err.source, reason: err.message, at: ctx.now().toISOString(), until: err.until.toISOString() };
        result.stops.push(notice);
        stopped.set(err.source, notice);
        // The alert: loud in the log (the operator's error alerts watch it) and recorded so a restart does not try again.
        logger.error({ alert: true, source: err.source, status: err.status, until: notice.until }, `candle store: ${err.source} told us to stop (${err.status}); leaving it alone until ${notice.until}`);
        await recordCandleEvent(ctx.db, { kind: "source_stopped", source: err.source, detail: { reason: err.message, status: err.status, until: notice.until } }).catch(() => {});
        continue;
      }
      const message = err instanceof Error ? err.message : "unknown error";
      result.errors.push(`${stage.name}: ${message}`);
      logger.warn({ err, stage: stage.name }, "candle store: stage failed; the next cycle tries again");
    }
  }
  result.complete = allRan && !result.timedOut && result.errors.length === 0 && result.stops.length === 0;
  return result;
}
