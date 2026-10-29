import { describe, expect, it } from "vitest";
import { TRADING_TIMEFRAMES, tradingTimeframeMs, type TradingCandle, type TradingTimeframe } from "@paperclipai/shared";
import { isTradingMarketDataError, prepareClosedCandles } from "../services/trading-market-data.ts";

/**
 * DUR-4999: the pure closed-candle gate between raw exchange bars and the
 * rule engine -- the forming bar is dropped, and price age is measured from
 * the newest closed bar's CLOSE time against one timeframe plus 10 minutes.
 */

const MIN = 60_000;
const NOW = new Date("2026-03-10T12:00:00Z");

/** One bar per timeframe step, ending with a bar that CLOSED `closedAgoMs` before NOW. */
function barsClosedAgo(timeframe: TradingTimeframe, closedAgoMs: number, count = 3): TradingCandle[] {
  const step = tradingTimeframeMs(timeframe);
  const lastOpen = NOW.getTime() - closedAgoMs - step;
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i;
    return { openTime: new Date(lastOpen - (count - 1 - i) * step), open: close, high: close, low: close, close, volume: 1 };
  });
}

describe("prepareClosedCandles", () => {
  it("drops the still-forming bar and keeps open/high/low/close/volume on the rest", () => {
    const step = tradingTimeframeMs("1h");
    const closed: TradingCandle = { openTime: new Date(NOW.getTime() - 2 * step), open: 1, high: 3, low: 0.5, close: 2, volume: 9 };
    const justClosed: TradingCandle = { openTime: new Date(NOW.getTime() - step), open: 2, high: 2, low: 2, close: 2.5, volume: 4 }; // closes exactly NOW -> closed
    const forming: TradingCandle = { openTime: new Date(NOW.getTime() - 5 * MIN), open: 2.5, high: 9, low: 2.5, close: 9, volume: 1 };
    const out = prepareClosedCandles({ candles: [closed, justClosed, forming] }, "1h", NOW, "BTC/USD");
    if (isTradingMarketDataError(out)) throw new Error(out.message);
    expect(out.candles).toEqual([closed, justClosed]);
    expect(out.closes).toEqual([2, 2.5]);
    expect(out.lastCloseAt.toISOString()).toBe(NOW.toISOString());
  });

  it("reports no_data when only the forming bar exists", () => {
    const forming: TradingCandle = { openTime: new Date(NOW.getTime() - MIN), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    expect(prepareClosedCandles({ candles: [forming] }, "15m", NOW, "BTC/USD")).toMatchObject({ kind: "no_data" });
  });

  for (const timeframe of TRADING_TIMEFRAMES) {
    const step = tradingTimeframeMs(timeframe);
    describe(`staleness at ${timeframe}`, () => {
      it("passes a normal-age closed bar (closed just now, and closed almost a full timeframe ago)", () => {
        expect(isTradingMarketDataError(prepareClosedCandles({ candles: barsClosedAgo(timeframe, 0) }, timeframe, NOW, "BTC/USD"))).toBe(false);
        expect(isTradingMarketDataError(prepareClosedCandles({ candles: barsClosedAgo(timeframe, step - MIN) }, timeframe, NOW, "BTC/USD"))).toBe(false);
      });

      it("tolerates the 10 minute grace after one timeframe, but not more", () => {
        expect(isTradingMarketDataError(prepareClosedCandles({ candles: barsClosedAgo(timeframe, step + 10 * MIN) }, timeframe, NOW, "BTC/USD"))).toBe(false);
        expect(prepareClosedCandles({ candles: barsClosedAgo(timeframe, step + 10 * MIN + 1) }, timeframe, NOW, "BTC/USD")).toMatchObject({ kind: "stale" });
      });

      it("fails a truly old bar", () => {
        expect(prepareClosedCandles({ candles: barsClosedAgo(timeframe, 3 * step) }, timeframe, NOW, "BTC/USD")).toMatchObject({ kind: "stale" });
      });
    });
  }
});
