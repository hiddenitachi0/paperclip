import { kraken } from "ccxt";
import {
  TRADING_ASSETS,
  TRADING_MAX_PRICE_AGE_MINUTES,
  ccxtSymbolFor,
  dropFormingCandles,
  tradingCandleCloseTime,
  tradingMaxCandleAgeMs,
  type TradingAsset,
  type TradingCandle,
  type TradingTimeframe,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * Public market data for the trading agent -- CCXT (MIT), public endpoints
 * only, no exchange credentials anywhere in this file (paper mode never
 * needs one; see the module doc comment on trading.ts). Kraken is used as
 * the default public-data source only; it is not a recommendation for where
 * real funds would ever be held (a phase 4 decision, out of scope here, and
 * explicitly Filip + accountant's call per the design report's phase 0).
 *
 * Mirrors watcher-sources.ts's shape: a small interface plus a real
 * implementation, so services/trading.ts's tick loop can be tested end to
 * end against a fake (fakeTradingMarketData below / a test's own stub)
 * without ever making a network call.
 */

/**
 * Whatever the exchange returned for a candle request, oldest-first. It may
 * still end with the bar that is forming right now: a source never filters,
 * prepareClosedCandles() below does (so a fake and the real client are held to
 * the same rule).
 */
export interface TradingCandles {
  candles: TradingCandle[];
}

/** Closed bars only, oldest-first, already checked for staleness. */
export interface ClosedTradingCandles {
  candles: TradingCandle[];
  /** Oldest-first closing prices, one per closed bar. */
  closes: number[];
  /** When the newest closed bar closed (its open time + the timeframe). */
  lastCloseAt: Date;
}

export interface TradingQuote {
  bidUsd: number;
  askUsd: number;
  at: Date;
}

export type TradingMarketDataErrorKind = "upstream" | "stale" | "no_data";

export interface TradingMarketDataError {
  kind: TradingMarketDataErrorKind;
  message: string;
}

export function isTradingMarketDataError(value: unknown): value is TradingMarketDataError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

export type TradingMarketAvailability = "available" | "missing" | "unknown";

export interface TradingMarketCheck {
  available: TradingAsset[];
  missing: TradingAsset[];
}

export interface TradingMarketDataSource {
  /** oldest-first bars for the given timeframe/limit (the forming bar may be last; see prepareClosedCandles). */
  fetchCandles(asset: TradingAsset, timeframe: TradingTimeframe, limit: number, now: Date): Promise<TradingCandles | TradingMarketDataError>;
  /** best bid/ask right now, used to price a paper fill honestly (buy at ask, sell at bid). */
  fetchQuote(asset: TradingAsset, now: Date): Promise<TradingQuote | TradingMarketDataError>;
  /** Is this asset's mapped symbol on the exchange's market list? "unknown" = the list could not be loaded (callers fail closed). */
  marketAvailability(asset: TradingAsset): Promise<TradingMarketAvailability>;
  /** Boot check: every mapped symbol against the exchange's market list. */
  verifyMarkets(): Promise<TradingMarketCheck | TradingMarketDataError>;
}

function isStale(at: Date, now: Date): boolean {
  return now.getTime() - at.getTime() > TRADING_MAX_PRICE_AGE_MINUTES * 60_000;
}

/**
 * The only door between raw exchange bars and the rule engine: drops the
 * still-forming bar (openTime + timeframe > now), then measures the newest
 * closed bar's age from its CLOSE time against one timeframe plus 10 minutes
 * of grace. (Measuring from the open time made every 1h/4h/1d strategy look
 * stale on every check.) Idempotent, so running it on already-closed bars is
 * harmless.
 */
export function prepareClosedCandles(raw: TradingCandles, timeframe: TradingTimeframe, now: Date, label: string): ClosedTradingCandles | TradingMarketDataError {
  const candles = dropFormingCandles(raw.candles, timeframe, now);
  const last = candles[candles.length - 1];
  if (!last) return { kind: "no_data", message: `No closed ${timeframe} candle is available for ${label} yet.` };
  const lastCloseAt = tradingCandleCloseTime(last, timeframe);
  if (now.getTime() - lastCloseAt.getTime() > tradingMaxCandleAgeMs(timeframe)) {
    return { kind: "stale", message: `The last closed ${label} ${timeframe} candle closed at ${lastCloseAt.toISOString()}, too old to trade on.` };
  }
  return { candles, closes: candles.map((c) => c.close), lastCloseAt };
}

/** The real implementation: one shared Kraken client, public endpoints only. */
export function ccxtTradingMarketData(): TradingMarketDataSource {
  const exchange = new kraken({ enableRateLimit: true });
  let marketCheck: TradingMarketCheck | null = null;

  async function verifyMarkets(): Promise<TradingMarketCheck | TradingMarketDataError> {
    try {
      const markets = await exchange.loadMarkets();
      // A listed-but-inactive market (delisted, suspended) counts as missing.
      const listed = (asset: TradingAsset) => {
        const market = markets[ccxtSymbolFor(asset)];
        return market !== undefined && market.active !== false;
      };
      const available = TRADING_ASSETS.filter(listed);
      const missing = TRADING_ASSETS.filter((asset) => !listed(asset));
      marketCheck = { available, missing };
      return marketCheck;
    } catch (err) {
      logger.warn({ err }, "trading: loading the Kraken market list failed");
      return { kind: "upstream", message: "Could not load Kraken's market list. Try again in a moment." };
    }
  }

  async function marketAvailability(asset: TradingAsset): Promise<TradingMarketAvailability> {
    const check = marketCheck ?? (await verifyMarkets());
    if (isTradingMarketDataError(check)) return "unknown";
    return check.available.includes(asset) ? "available" : "missing";
  }

  async function fetchCandles(asset: TradingAsset, timeframe: TradingTimeframe, limit: number, now: Date): Promise<TradingCandles | TradingMarketDataError> {
    const symbol = ccxtSymbolFor(asset);
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      const candles: TradingCandle[] = [];
      for (const bar of ohlcv) {
        const [ts, open, high, low, close, volume] = bar;
        if (typeof ts !== "number" || typeof open !== "number" || typeof high !== "number" || typeof low !== "number" || typeof close !== "number") continue;
        candles.push({ openTime: new Date(ts), open, high, low, close, volume: typeof volume === "number" ? volume : 0 });
      }
      if (candles.length === 0) return { kind: "no_data", message: `No candles came back for ${symbol}.` };
      return { candles };
    } catch (err) {
      logger.warn({ err, asset, symbol }, "trading: fetchCandles failed");
      return { kind: "upstream", message: `Kraken candle request for ${symbol} failed. The next check tries again.` };
    }
  }

  async function fetchQuote(asset: TradingAsset, now: Date): Promise<TradingQuote | TradingMarketDataError> {
    const symbol = ccxtSymbolFor(asset);
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const bid = ticker.bid ?? ticker.last;
      const ask = ticker.ask ?? ticker.last;
      if (bid == null || ask == null) return { kind: "no_data", message: `No bid/ask came back for ${symbol}.` };
      const at = typeof ticker.timestamp === "number" ? new Date(ticker.timestamp) : now;
      if (isStale(at, now)) return { kind: "stale", message: `The last ${symbol} quote is from ${at.toISOString()}, too old to trade on.` };
      return { bidUsd: bid, askUsd: ask, at };
    } catch (err) {
      logger.warn({ err, asset, symbol }, "trading: fetchQuote failed");
      return { kind: "upstream", message: `Kraken quote request for ${symbol} failed. The next check tries again.` };
    }
  }

  return { fetchCandles, fetchQuote, marketAvailability, verifyMarkets };
}

/**
 * Deterministic in-memory fake for tests: candles/quotes are supplied up
 * front per asset, so a test controls exactly what the strategy engine
 * sees without any network access.
 */
export function fakeTradingMarketData(fixtures: {
  candles?: Partial<Record<TradingAsset, TradingCandles | TradingMarketDataError>>;
  quotes?: Partial<Record<TradingAsset, TradingQuote | TradingMarketDataError>>;
  /** Assets whose market is not on the (fake) exchange; everything else is available. */
  missingMarkets?: TradingAsset[];
}): TradingMarketDataSource {
  const missing = new Set<TradingAsset>(fixtures.missingMarkets ?? []);
  return {
    async marketAvailability(asset) {
      return missing.has(asset) ? "missing" : "available";
    },
    async verifyMarkets() {
      return { available: TRADING_ASSETS.filter((a) => !missing.has(a)), missing: TRADING_ASSETS.filter((a) => missing.has(a)) };
    },
    async fetchCandles(asset) {
      const found = fixtures.candles?.[asset];
      return found ?? { kind: "no_data", message: `No fixture candles for ${asset}.` };
    },
    async fetchQuote(asset) {
      const found = fixtures.quotes?.[asset];
      return found ?? { kind: "no_data", message: `No fixture quote for ${asset}.` };
    },
  };
}
