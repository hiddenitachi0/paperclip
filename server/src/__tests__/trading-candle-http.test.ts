import { describe, expect, it, vi } from "vitest";
import { CandleHttpError, CandleSourceStop, createCandleHttp } from "../services/trading-candle-http.js";

function reply(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

describe("trading candle http (DUR-5007)", () => {
  it("refuses hosts that are not market-data hosts, plain http and credentials in the address", async () => {
    const fetchImpl = vi.fn();
    const http = createCandleHttp({ fetchImpl });
    await expect(http.getJson("https://evil.example.com/x")).rejects.toBeInstanceOf(CandleHttpError);
    await expect(http.getJson("http://api.kraken.com/0/public/OHLC")).rejects.toBeInstanceOf(CandleHttpError);
    await expect(http.getJson("https://user:pw@api.kraken.com/0/public/OHLC")).rejects.toBeInstanceOf(CandleHttpError);
    await expect(http.getJson("https://api.kraken.com:8443/x")).rejects.toBeInstanceOf(CandleHttpError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows a redirect only to another allowed host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(302, "", { location: "https://data-api.binance.vision/ok" }))
      .mockResolvedValueOnce(reply(200, '{"ok":true}'))
      .mockResolvedValueOnce(reply(302, "", { location: "https://evil.example.com/steal" }));
    const http = createCandleHttp({ fetchImpl });
    expect(await http.getJson("https://api.kraken.com/a")).toEqual({ ok: true });
    await expect(http.getJson("https://api.kraken.com/b")).rejects.toBeInstanceOf(CandleHttpError);
  });

  it("backs off on 429 (honouring Retry-After) and then succeeds", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(429, "", { "retry-after": "3" })).mockResolvedValueOnce(reply(200, "[1]"));
    const http = createCandleHttp({ fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(await http.getJson("https://data-api.binance.vision/x")).toEqual([1]);
    expect(sleeps).toEqual([3000]);
  });

  it("gives up after repeated 429s", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => reply(429));
    const http = createCandleHttp({ fetchImpl, sleep: async () => {} });
    await expect(http.getJson("https://data-api.binance.vision/x")).rejects.toThrow(/rate limit/);
    expect(fetchImpl.mock.calls.length).toBe(5);
  });

  it("stops the source on 418 and on 451, with the ban end from Retry-After", async () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(418, "", { "retry-after": "600" })).mockResolvedValueOnce(reply(451));
    const http = createCandleHttp({ fetchImpl, now: () => now });
    const first = await http.getJson("https://data-api.binance.vision/x").catch((e) => e);
    expect(first).toBeInstanceOf(CandleSourceStop);
    expect(first.source).toBe("binance");
    expect(first.until.toISOString()).toBe("2026-10-29T12:10:00.000Z");
    const second = await http.getJson("https://api.exchange.coinbase.com/x").catch((e) => e);
    expect(second).toBeInstanceOf(CandleSourceStop);
    expect(second.until.getTime()).toBeGreaterThan(now.getTime() + 3_600_000);
  });

  it("returns null on 404 and refuses a ranged read the server does not honour", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(200, "whole file"));
    const http = createCandleHttp({ fetchImpl });
    expect(await http.getBytes("https://data.binance.vision/x.zip")).toBeNull();
    await expect(http.getRange("https://assets.kraken.com/x.zip", 0, 10)).rejects.toThrow(/partial downloads/);
  });

  it("rejects a response larger than the cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(200, "x", { "content-length": String(500 * 1024 * 1024) }));
    const http = createCandleHttp({ fetchImpl });
    await expect(http.getBytes("https://data.binance.vision/x.zip")).rejects.toThrow(/larger than allowed/);
  });
});
