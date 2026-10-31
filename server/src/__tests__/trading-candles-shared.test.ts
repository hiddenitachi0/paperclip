import { describe, expect, it } from "vitest";
import { TRADING_ASSETS } from "@paperclipai/shared";
import {
  TRADING_CANDLE_DISPLAYABLE_SOURCES,
  assetOfKrakenPair,
  binanceSymbolForAsset,
  coinbaseProductForAsset,
  krakenPairForAsset,
  tradingCandleAssetOfMarket,
  tradingCandleMarket,
  tradingCandleProblem,
} from "@paperclipai/shared";

describe("candle store shared helpers (DUR-5007)", () => {
  it("maps every coin to its Kraken, Binance and Coinbase names and back", () => {
    expect(krakenPairForAsset("BTC")).toBe("XBTUSD");
    expect(krakenPairForAsset("DOGE")).toBe("XDGUSD");
    expect(krakenPairForAsset("ETH")).toBe("ETHUSD");
    expect(binanceSymbolForAsset("SOL")).toBe("SOLUSDT");
    expect(coinbaseProductForAsset("LINK")).toBe("LINK-USD");
    expect(tradingCandleMarket("kraken", "BTC")).toBe("BTC/USD");
    expect(tradingCandleMarket("binance", "BTC")).toBe("BTC/USDT");
    for (const asset of TRADING_ASSETS) {
      expect(assetOfKrakenPair(krakenPairForAsset(asset))).toBe(asset);
      expect(tradingCandleAssetOfMarket(tradingCandleMarket("binance", asset))).toBe(asset);
    }
    expect(tradingCandleAssetOfMarket("FOO/USD")).toBeNull();
  });

  it("only Kraken may be shown as a live price", () => {
    expect(TRADING_CANDLE_DISPLAYABLE_SOURCES).toEqual(["kraken"]);
  });

  it("rejects bars whose numbers cannot be real", () => {
    const ok = { openTime: new Date(0), open: 2, high: 3, low: 1, close: 2.5, volume: 0 };
    expect(tradingCandleProblem(ok)).toBeNull();
    expect(tradingCandleProblem({ ...ok, high: 1.5 })).toMatch(/high\/low/);
    expect(tradingCandleProblem({ ...ok, low: 2.2 })).toMatch(/high\/low/);
    expect(tradingCandleProblem({ ...ok, open: 0 })).toMatch(/zero or negative/);
    expect(tradingCandleProblem({ ...ok, volume: -1 })).toMatch(/negative/);
    expect(tradingCandleProblem({ ...ok, close: Number.POSITIVE_INFINITY })).toMatch(/not a number/);
    expect(tradingCandleProblem({ ...ok, openTime: new Date("nope") })).toMatch(/not a date/);
  });
});
