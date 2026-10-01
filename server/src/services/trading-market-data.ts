import { kraken } from "ccxt";
import { TRADING_MAX_PRICE_AGE_MINUTES, ccxtSymbolFor, type TradingAsset } from "@paperclipai/shared";
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

export interface TradingCandles {
  /** Oldest-first closing prices, one per timeframe bar. */
  closes: number[];
  /** When the most recent candle closed. */
  lastCandleAt: Date;
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

export interface TradingMarketDataSource {
  /** oldest-first closes for the given timeframe/limit, used by the rule engine. */
  fetchCandles(asset: TradingAsset, timeframe: string, limit: number, now: Date): Promise<TradingCandles | TradingMarketDataError>;
  /** best bid/ask right now, used to price a paper fill honestly (buy at ask, sell at bid). */
  fetchQuote(asset: TradingAsset, now: Date): Promise<TradingQuote | TradingMarketDataError>;
}

function isStale(at: Date, now: Date): boolean {
  return now.getTime() - at.getTime() > TRADING_MAX_PRICE_AGE_MINUTES * 60_000;
}

/** The real implementation: one shared Kraken client, public endpoints only. */
export function ccxtTradingMarketData(): TradingMarketDataSource {
  const exchange = new kraken({ enableRateLimit: true });

  async function fetchCandles(asset: TradingAsset, timeframe: string, limit: number, now: Date): Promise<TradingCandles | TradingMarketDataError> {
    const symbol = ccxtSymbolFor(asset);
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      if (ohlcv.length === 0) return { kind: "no_data", message: `No candles came back for ${symbol}.` };
      const closes = ohlcv.map((bar) => bar[4] as number).filter((c): c is number => typeof c === "number");
      const lastTs = ohlcv[ohlcv.length - 1]?.[0];
      const lastCandleAt = typeof lastTs === "number" ? new Date(lastTs) : now;
      if (isStale(lastCandleAt, now)) return { kind: "stale", message: `The last ${symbol} candle is from ${lastCandleAt.toISOString()}, too old to trade on.` };
      return { closes, lastCandleAt };
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

  return { fetchCandles, fetchQuote };
}

/**
 * Deterministic in-memory fake for tests: candles/quotes are supplied up
 * front per asset, so a test controls exactly what the strategy engine
 * sees without any network access.
 */
export function fakeTradingMarketData(fixtures: {
  candles?: Partial<Record<TradingAsset, TradingCandles | TradingMarketDataError>>;
  quotes?: Partial<Record<TradingAsset, TradingQuote | TradingMarketDataError>>;
}): TradingMarketDataSource {
  return {
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
