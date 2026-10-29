# Trading candle store

Years of closed candles, kept per exchange, so past-data tests run on the same
exchange the live signals use (DUR-5007, part of the trading rebuild plan,
DUR-4889). Everything here is public market data. No company data, no keys.

## What is stored

- `trading_candles`: `source` (`kraken`, `binance`, `coinbase`), `market`
  (`BTC/USD` on Kraken and Coinbase, `BTC/USDT` on Binance), `timeframe`
  (`5m`, `1h`, `4h`, `1d`), `open_time`, open/high/low/close/volume,
  `ingested_at`. Primary key: source + market + timeframe + open time.
- `trading_candle_ingest_events`: append-only log of what the backfill did
  (finished archive entries, corrections, dropped bars, a source telling us to
  stop, notes explaining a known gap). The backfill resumes from it.
- Closed bars only. A bar is stored once and never changed: a database trigger
  refuses every UPDATE, inserts use `ON CONFLICT DO NOTHING`, and a difference
  found later is logged as a `correction` event and left as it was.
- Volume is only comparable inside one source. Thresholds on volume must be
  relative (a percentile or z-score within that source). The overlap report
  compares volumes by rank for exactly this reason.
- 5m bars are kept for the last 730 days only (stop checks). 1h, 4h and 1d go
  back to each market's first bar.

## Where the data comes from

| Source | What | How |
|---|---|---|
| Kraken (primary, the live exchange) | History | Kraken's downloadable OHLCVT archive (`Kraken_OHLCVT_Full.zip.part00..`, through 30 June 2026) plus the quarterly files after it. Read with byte ranges, so nothing large is written to disk; only the files for our 12 coins at 5m/1h/4h/1d are read. |
| Kraken | Live closed bars | REST `OHLC`, from the newest stored bar, every 5 minutes (a bar is fetched only once it has closed). Kraken's feed only reaches back 720 bars, so a seam between the newest archive and that window is possible; it is logged as a `gap_note` and shows as explained in the gap report until the next quarterly archive fills it. |
| Binance (cross-check, longer history) | 1h, 4h, 1d | `data.binance.vision` monthly files for finished months, REST klines for the current month. Timestamps in the 2025+ files are microseconds; they are converted. Weight is tracked from the response headers and the cycle pauses before the limit; a 429 is retried with a back-off. A 418 or 451 stops the source (see below). |
| Coinbase (fallback) | 1h, 1d | Only for a coin Kraken has no bars for in that size. |

Hosts are an allow-list in `trading-candle-http.ts` (https only, no credentials,
redirects only to another allowed host, timeouts and size caps).

## How it runs

`candleStore` is its own scheduler chain. Its tick only decides whether a cycle
is due and starts one in a **worker thread** with its own small database
connection (the bypass login) and a capped heap, so downloading, inflating and
parsing never run on the API's event loop or its pool, and never inside the
trading tick chain. First cycle is two minutes after boot; after a clean cycle
the live feeds are topped up every 5 minutes and the archive index re-checked
every 6 hours; a cycle that runs out of its 10-minute budget carries straight
on; failures back off up to an hour. Off switch: `PAPERCLIP_TRADING_CANDLE_STORE_ENABLED=false`.

Resume: finished archive entries are logged, so after a crash or restart only
the entry that was in progress is read again (inserts are idempotent). A
republished archive (different size) is read again and any difference is logged
as a correction.

A 418 or 451 stops that source: it is logged as an error with `alert: true`,
recorded as a `source_stopped` event with the time to wait, and left alone
until then, also across restarts. The other sources carry on.

## Reports (board-only, company-scoped, read-only)

- `GET /api/companies/:id/trading/candle-store`: runner status, storage size, per-coin coverage (first bar, last bar, bars, expected bars; market-weather regimes covered stays `null` until DUR-5013), stops, licence note.
- `.../candle-store/gaps`: gap detection per stream. Short runs are explained as "no trade in that interval" (Kraken omits empty bars); noted seams carry their reason; anything else is listed as unexplained.
- `.../candle-store/overlap`: Kraken (USD) against Binance (USDT) on the same bars: mean and 95th-percentile close difference, return correlation, volume-rank correlation.
- `.../candle-store/candles`: raw bars, **Kraken only** (Binance history is never served as a price).

Storage was about 3.5M rows expected at roughly 0.5-1 GB; the summary reports
the real size. Add it to the offsite-backup plan.

## Licence notes

Internal research use only. Kraken, Binance and Coinbase public market data may
be used for our own past-data tests. Sharing the data, or anything derived from
it that reproduces it, with client companies needs a terms review first. Binance
history is for internal past-data tests only and is never shown as a live price.
(Same wording as `TRADING_CANDLE_LICENCE_NOTE` in `packages/shared/src/trading-candles.ts`,
which the summary route returns.)

## Rollback

`DROP TABLE trading_candle_ingest_events, trading_candles; DROP FUNCTION trading_candles_refuse_update();`
Nothing else references them, and the data can be rebuilt from the exchanges.
