import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BINANCE_TICKER_URL,
  COINGECKO_SIMPLE_PRICE_URL,
  EODHD_EOD_URL,
  FINNHUB_QUOTE_URL,
  WATCHER_EODHD_PER_DAY,
  cryptoSource,
  isWatcherQuoteError,
  osloStockSource,
  resetWatcherSourceState,
  scrubWatcherText,
  usStockSource,
  watcherProviderHoldMs,
  type WatcherQuote,
} from "../services/watcher-sources.js";

/**
 * Price sources, with every request answered by a fake (no real price API is
 * ever called from a test): the request each one makes, how the answer is
 * read, what a failure looks like, the rate-limit hold, and that a key never
 * appears in anything shown.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z");
const FINNHUB_KEY = "d0fakefinnhubkey1234567890abcd";
const EODHD_KEY = "68f0fakeeodhdtoken.12345678";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function quote(value: unknown): WatcherQuote {
  if (isWatcherQuoteError(value as never)) throw new Error(`expected a quote, got ${JSON.stringify(value)}`);
  return value as WatcherQuote;
}

beforeEach(() => resetWatcherSourceState());
afterEach(() => resetWatcherSourceState());

describe("crypto: CoinGecko first", () => {
  it("asks once for every coin, in dollars with the 24-hour change, and reads price, time and reference", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        bitcoin: { usd: 84000, usd_24h_change: 5, last_updated_at: 1790582820 },
        solana: { usd: 150, usd_24h_change: -2, last_updated_at: 1790582810 },
        ethereum: { usd: 2645.68, usd_24h_change: 0.5, last_updated_at: 1790582810 },
      }),
    );
    const results = await cryptoSource.fetchQuotes({ symbols: ["BTC", "SOL", "ETH"], now: NOW }, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(COINGECKO_SIMPLE_PRICE_URL);
    expect(url.searchParams.get("ids")).toBe("bitcoin,solana,ethereum");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    expect(url.searchParams.get("include_24hr_change")).toBe("true");
    const btc = quote(results.get("BTC"));
    expect(btc).toMatchObject({ price: 84000, provider: "coingecko" });
    expect(btc.observedAt.toISOString()).toBe(new Date(1790582820 * 1000).toISOString());
    expect(btc.reference?.windowHours).toBe(24);
    expect(btc.reference?.price).toBeCloseTo(80000, 6);
    expect(quote(results.get("SOL")).price).toBe(150);
    expect(quote(results.get("ETH")).price).toBe(2645.68);
  });

  it("reuses a fresh answer instead of asking CoinGecko again within the minute", async () => {
    const { impl, calls } = fakeFetch(() => json({ bitcoin: { usd: 84000, last_updated_at: 1790582820 } }));
    await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: NOW }, { fetchImpl: impl });
    await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: new Date(NOW.getTime() + 30_000) }, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: new Date(NOW.getTime() + 61_000) }, { fetchImpl: impl });
    expect(calls).toHaveLength(2);
  });

  it("falls back to Binance's public market-data host when CoinGecko fails", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.hostname === "api.coingecko.com") return new Response("oops", { status: 500 });
      return json({ symbol: "BTCUSDT", lastPrice: "83028.00", openPrice: "84834.22", priceChangePercent: "-2.129", closeTime: 1790582966010 });
    });
    const results = await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: NOW }, { fetchImpl: impl });
    expect(calls).toHaveLength(2);
    const binance = new URL(calls[1]!.url);
    expect(`${binance.origin}${binance.pathname}`).toBe(BINANCE_TICKER_URL);
    expect(binance.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(quote(results.get("BTC"))).toMatchObject({ price: 83028, provider: "binance" });
    expect(quote(results.get("BTC")).reference?.price).toBe(84834.22);
  });

  it("a 429 puts CoinGecko on hold for its Retry-After; nothing is sent to it while on hold", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.hostname === "api.coingecko.com") return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
      return new Response("down", { status: 503 });
    });
    const first = await cryptoSource.fetchQuotes({ symbols: ["ETH"], now: NOW }, { fetchImpl: impl });
    expect(first.get("ETH")).toMatchObject({ kind: "rate_limited" });
    expect(watcherProviderHoldMs("coingecko", NOW.getTime())).toBe(120_000);
    const coingeckoCalls = () => calls.filter((call) => call.url.includes("coingecko")).length;
    expect(coingeckoCalls()).toBe(1);
    await cryptoSource.fetchQuotes({ symbols: ["ETH"], now: new Date(NOW.getTime() + 60_000) }, { fetchImpl: impl });
    expect(coingeckoCalls()).toBe(1);
    await cryptoSource.fetchQuotes({ symbols: ["ETH"], now: new Date(NOW.getTime() + 121_000) }, { fetchImpl: impl });
    expect(coingeckoCalls()).toBe(2);
  });

  it("a 429 without Retry-After holds for a minute, then twice as long on a repeat", async () => {
    const { impl } = fakeFetch(() => new Response("", { status: 429 }));
    await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: NOW }, { fetchImpl: impl });
    expect(watcherProviderHoldMs("coingecko", NOW.getTime())).toBe(60_000);
    const later = new Date(NOW.getTime() + 61_000);
    await cryptoSource.fetchQuotes({ symbols: ["BTC"], now: later }, { fetchImpl: impl });
    expect(watcherProviderHoldMs("coingecko", later.getTime())).toBe(120_000);
  });

  it("network failure and an unknown coin come back as plain sentences, never upstream text", async () => {
    const { impl } = fakeFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.coingecko.com secret-ish detail");
    });
    const results = await cryptoSource.fetchQuotes({ symbols: ["BTC", "NOPE"], now: NOW }, { fetchImpl: impl });
    expect(results.get("BTC")).toEqual({
      kind: "network",
      message: "Could not reach CoinGecko. It is usually the network; the next check tries again.",
    });
    expect(results.get("NOPE")).toMatchObject({ kind: "unknown_symbol" });
  });
});

describe("US stocks: Finnhub", () => {
  it("sends the key in a header, never in the address, and reads the quote", async () => {
    const { impl, calls } = fakeFetch(() => json({ c: 227.5, d: 1.2, dp: 0.53, pc: 226.3, t: 1790582400 }));
    const results = await usStockSource.fetchQuotes({ symbols: ["AAPL"], key: FINNHUB_KEY, now: NOW }, { fetchImpl: impl });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(FINNHUB_QUOTE_URL);
    expect(url.searchParams.get("symbol")).toBe("AAPL");
    expect(calls[0]!.url).not.toContain(FINNHUB_KEY);
    expect((calls[0]!.init?.headers as Record<string, string>)["X-Finnhub-Token"]).toBe(FINNHUB_KEY);
    expect(quote(results.get("AAPL"))).toMatchObject({ price: 227.5, provider: "finnhub", reference: null });
  });

  it("no key: no request at all, and a sentence saying what to do", async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    const results = await usStockSource.fetchQuotes({ symbols: ["AAPL"], key: null, now: NOW }, { fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(results.get("AAPL")).toMatchObject({ kind: "key_missing" });
  });

  it("a refused key, an unknown ticker (zeros) and a 429 are told apart", async () => {
    const refused = fakeFetch(() => json({ error: `Invalid API key ${FINNHUB_KEY}` }, 401));
    const r1 = await usStockSource.fetchQuotes({ symbols: ["AAPL"], key: FINNHUB_KEY, now: NOW }, { fetchImpl: refused.impl });
    expect(r1.get("AAPL")).toMatchObject({ kind: "key_refused" });
    expect(JSON.stringify(r1.get("AAPL"))).not.toContain(FINNHUB_KEY);

    const unknown = fakeFetch(() => json({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
    const r2 = await usStockSource.fetchQuotes({ symbols: ["ZZZZ"], key: FINNHUB_KEY, now: NOW }, { fetchImpl: unknown.impl });
    expect(r2.get("ZZZZ")).toMatchObject({ kind: "unknown_symbol" });

    const limited = fakeFetch(() => new Response("", { status: 429 }));
    const r3 = await usStockSource.fetchQuotes({ symbols: ["AAPL", "MSFT"], key: FINNHUB_KEY, now: NOW }, { fetchImpl: limited.impl });
    expect(r3.get("AAPL")).toMatchObject({ kind: "rate_limited" });
    // On hold after the first 429: the second symbol is not even asked for.
    expect(limited.calls).toHaveLength(1);
    expect(r3.get("MSFT")).toMatchObject({ kind: "rate_limited" });
  });
});

describe("Oslo Børs: EODHD closing prices", () => {
  it("asks for the .OL ticker's recent closes and uses the last two", async () => {
    const { impl, calls } = fakeFetch(() =>
      json([
        { date: "2026-09-24", close: 250.1 },
        { date: "2026-09-25", close: 251.4 },
        { date: "2026-09-26", close: 264.0 },
      ]),
    );
    const results = await osloStockSource.fetchQuotes({ symbols: ["DNB"], key: EODHD_KEY, now: NOW }, { fetchImpl: impl });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${EODHD_EOD_URL}/DNB.OL`);
    expect(url.searchParams.get("fmt")).toBe("json");
    expect(url.searchParams.get("from")).toBe("2026-09-18");
    const dnb = quote(results.get("DNB"));
    expect(dnb).toMatchObject({ price: 264, provider: "eodhd" });
    expect(dnb.observedAt.toISOString()).toBe("2026-09-26T14:20:00.000Z");
    expect(dnb.reference).toMatchObject({ windowHours: 24, price: 251.4 });
    expect(dnb.reference!.at.toISOString()).toBe("2026-09-25T14:20:00.000Z");
  });

  it("stays inside the free daily allowance per key", async () => {
    const { impl, calls } = fakeFetch(() => json([{ date: "2026-09-26", close: 264 }]));
    for (let i = 0; i < WATCHER_EODHD_PER_DAY + 3; i += 1) {
      await osloStockSource.fetchQuotes({ symbols: ["DNB"], key: EODHD_KEY, now: new Date(NOW.getTime() + i * 1000) }, { fetchImpl: impl });
    }
    expect(calls).toHaveLength(WATCHER_EODHD_PER_DAY);
    const next = await osloStockSource.fetchQuotes({ symbols: ["DNB"], key: EODHD_KEY, now: new Date(NOW.getTime() + 60_000) }, { fetchImpl: impl });
    expect(next.get("DNB")).toMatchObject({ kind: "rate_limited" });
  });

  it("a forbidden answer (free plan, wrong key) is a refused key; nothing from the answer is kept", async () => {
    const { impl } = fakeFetch(() => new Response(`Forbidden for token ${EODHD_KEY}`, { status: 403 }));
    const results = await osloStockSource.fetchQuotes({ symbols: ["DNB"], key: EODHD_KEY, now: NOW }, { fetchImpl: impl });
    expect(results.get("DNB")).toMatchObject({ kind: "key_refused" });
    expect(JSON.stringify(results.get("DNB"))).not.toContain(EODHD_KEY);
  });
});

describe("scrubbing", () => {
  it("removes the key, and key-shaped query values, from any text", () => {
    const text = `GET https://eodhd.com/api/eod/DNB.OL?api_token=${EODHD_KEY}&fmt=json failed; key ${FINNHUB_KEY}; https://finnhub.io/api/v1/quote?symbol=AAPL&token=abc123def456`;
    const scrubbed = scrubWatcherText(text, [EODHD_KEY, FINNHUB_KEY, null]);
    expect(scrubbed).not.toContain(EODHD_KEY);
    expect(scrubbed).not.toContain(FINNHUB_KEY);
    expect(scrubbed).not.toContain("abc123def456");
  });
});
