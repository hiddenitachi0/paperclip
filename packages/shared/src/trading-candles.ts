import { TRADING_ASSETS, type TradingAsset } from "./trading.js";

/**
 * The candle store (DUR-5007): years of closed candles for past-data tests, kept
 * per exchange. Nothing here is company data; the table behind it holds public
 * market data only.
 *
 * Rules that the types below keep in one place:
 *   * A bar is stored once and never changed (a difference found later is
 *     logged, never written over).
 *   * Volume is only comparable within one source. Nothing in this module
 *     converts or mixes volumes across sources.
 *   * Only `kraken` rows may ever be shown as a live price. `binance` rows are
 *     internal past-data test material (decision 15); `coinbase` is the fallback
 *     when Kraken has no history for a market.
 */

export const TRADING_CANDLE_SOURCES = ["kraken", "binance", "coinbase"] as const;
export type TradingCandleSource = (typeof TRADING_CANDLE_SOURCES)[number];

/** 1h, 4h and 1d for the full history, and 5m for the last two years (stop checks). */
export const TRADING_CANDLE_TIMEFRAMES = ["5m", "1h", "4h", "1d"] as const;
export type TradingCandleTimeframe = (typeof TRADING_CANDLE_TIMEFRAMES)[number];

const CANDLE_TIMEFRAME_MS: Record<TradingCandleTimeframe, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function tradingCandleTimeframeMs(timeframe: TradingCandleTimeframe): number {
  return CANDLE_TIMEFRAME_MS[timeframe];
}

export function isTradingCandleTimeframe(value: string): value is TradingCandleTimeframe {
  return (TRADING_CANDLE_TIMEFRAMES as readonly string[]).includes(value);
}

export function isTradingCandleSource(value: string): value is TradingCandleSource {
  return (TRADING_CANDLE_SOURCES as readonly string[]).includes(value);
}

/** How far back the 5m bars go. Older 5m history is not stored. */
export const TRADING_CANDLE_5M_HISTORY_DAYS = 730;

/**
 * Which sources may be shown to an operator as a live price. Binance (public
 * history, internal tests only) is deliberately absent.
 */
export const TRADING_CANDLE_DISPLAYABLE_SOURCES: readonly TradingCandleSource[] = ["kraken"];

/** The quote currency each source prices a coin in. Kraken and Coinbase use US dollars, Binance uses Tether. */
export const TRADING_CANDLE_QUOTE: Readonly<Record<TradingCandleSource, "USD" | "USDT">> = {
  kraken: "USD",
  binance: "USDT",
  coinbase: "USD",
};

/** The market string stored in `trading_candles.market`: `BTC/USD` on Kraken, `BTC/USDT` on Binance. */
export function tradingCandleMarket(source: TradingCandleSource, asset: TradingAsset): string {
  return `${asset}/${TRADING_CANDLE_QUOTE[source]}`;
}

/** The coin in a stored market string, or null when it is not one we trade. */
export function tradingCandleAssetOfMarket(market: string): TradingAsset | null {
  const base = market.split("/")[0] ?? "";
  return (TRADING_ASSETS as readonly string[]).includes(base) ? (base as TradingAsset) : null;
}

/**
 * Kraken names its Bitcoin and Dogecoin pairs XBTUSD and XDGUSD in files and in
 * the REST API; everything else is `<COIN>USD` (checked against the 2026 Q3
 * archive: all twelve coins we trade have USD files).
 */
export function krakenPairForAsset(asset: TradingAsset): string {
  if (asset === "BTC") return "XBTUSD";
  if (asset === "DOGE") return "XDGUSD";
  return `${asset}USD`;
}

export function assetOfKrakenPair(pair: string): TradingAsset | null {
  for (const asset of TRADING_ASSETS) {
    if (krakenPairForAsset(asset) === pair) return asset;
  }
  return null;
}

export function binanceSymbolForAsset(asset: TradingAsset): string {
  return `${asset}USDT`;
}

export function coinbaseProductForAsset(asset: TradingAsset): string {
  return `${asset}-USD`;
}

/** One stored bar. `openTime` is the bar start; the bar closed at openTime + the timeframe. */
export interface TradingStoredCandle {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A bar the exchange (or a file) handed over is only stored when its numbers
 * are sane. Returns the reason it is not, or null when it is fine.
 */
export function tradingCandleProblem(candle: TradingStoredCandle): string | null {
  const { open, high, low, close, volume } = candle;
  if (Number.isNaN(candle.openTime.getTime())) return "open time is not a date";
  for (const value of [open, high, low, close, volume]) {
    if (!Number.isFinite(value)) return "a price or volume is not a number";
  }
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return "a price is zero or negative";
  if (volume < 0) return "volume is negative";
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return "high/low do not contain open and close";
  return null;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export interface TradingCandleCoverageRow {
  source: TradingCandleSource;
  market: string;
  timeframe: TradingCandleTimeframe;
  firstBar: string;
  lastBar: string;
  bars: number;
  /** Bars a gap-free run from first to last would have. */
  expectedBars: number;
  /** Filled in once the market-weather labels (DUR-5013) exist. */
  regimesCovered: string[] | null;
}

export interface TradingCandleGap {
  source: TradingCandleSource;
  market: string;
  timeframe: TradingCandleTimeframe;
  /** The last bar before the gap and the first bar after it. */
  afterBar: string;
  beforeBar: string;
  missingBars: number;
  /** A plain-language reason, or null when nobody has explained it yet. */
  explanation: string | null;
}

export interface TradingCandleOverlapRow {
  asset: TradingAsset;
  timeframe: TradingCandleTimeframe;
  overlappingBars: number;
  /** Mean and 95th-percentile absolute difference between the two closes, in percent. */
  closeDiffMeanPct: number | null;
  closeDiffP95Pct: number | null;
  /** Correlation of the two sources' bar-to-bar returns. */
  returnCorrelation: number | null;
  /**
   * Correlation of each source's volume rank (percentile within its own source).
   * Raw volumes are never compared: Kraken and Binance count different trades.
   */
  volumeRankCorrelation: number | null;
}

export interface TradingCandleStorageReport {
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  rows: number;
  bySource: Array<{ source: TradingCandleSource; rows: number }>;
}

export interface TradingCandleStopNotice {
  source: TradingCandleSource;
  reason: string;
  at: string;
  /** The source is left alone until this time. */
  until: string | null;
}

export const TRADING_CANDLE_LICENCE_NOTE =
  "Internal research use only. Kraken, Binance and Coinbase public market data may be used for our own past-data tests; showing it to client companies needs a terms review first. Binance history is never shown as a live price.";
