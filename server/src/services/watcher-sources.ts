import { createHash } from "node:crypto";
import { findWatcherCoin, type WatcherSource } from "@paperclipai/shared";
import { scrubApiToolText } from "./api-tools.js";

/**
 * Where watchers get prices. One interface, one implementation per market:
 *
 *   crypto      CoinGecko's public API (no key; one request for every coin a
 *               tick needs), with Binance's public market-data host as the
 *               backup for any coin CoinGecko did not answer for.
 *   us_stock    Finnhub /quote (free key, 60 requests a minute), key sent in
 *               a header, never in the address.
 *   oslo_stock  EODHD end-of-day prices (free key, personal use, 20 requests
 *               a day). There is no free source for Oslo prices during the
 *               day; this is the closing price, once a day.
 *
 * Adding a market = one more WatcherPriceSource here and one entry in
 * WATCHER_SOURCE_INFO (packages/shared/src/watchers.ts).
 *
 * Rules every source keeps:
 *   * Never throws for an upstream problem; every failure is a
 *     WatcherQuoteError with a fixed plain sentence. No upstream text, URL or
 *     error message is passed through, and anything that is shown is first
 *     scrubbed of the key (scrubWatcherText).
 *   * Rate limits are respected before and after the fact: a 429 (or a local
 *     budget running out) puts that provider on hold until its Retry-After,
 *     doubling on repeats, and nothing is sent to it while on hold.
 *   * Every request has a timeout; the tick is never held up by a slow host.
 */

export type WatcherQuoteErrorKind =
  | "rate_limited"
  | "key_missing"
  | "key_refused"
  | "unknown_symbol"
  | "network"
  | "upstream"
  | "unavailable";

export interface WatcherQuoteError {
  kind: WatcherQuoteErrorKind;
  /** A plain sentence for the operator. Never carries a key or an upstream message. */
  message: string;
}

export interface WatcherQuote {
  symbol: string;
  price: number;
  /** When the source says the price is from. */
  observedAt: Date;
  /**
   * A price the source itself gives for an earlier moment, so a rule can
   * measure a window before the watcher's own history covers it (CoinGecko's
   * and Binance's 24-hour change; EODHD's previous close).
   */
  reference: { windowHours: number; price: number; at: Date } | null;
  /** Which provider answered, for the log and the page. */
  provider: "coingecko" | "binance" | "finnhub" | "eodhd";
}

export interface WatcherQuoteRequest {
  symbols: string[];
  /** The source key, when the source needs one. Never logged. */
  key?: string | null;
  now?: Date;
}

export type WatcherQuoteResults = Map<string, WatcherQuote | WatcherQuoteError>;

export interface WatcherSourceDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface WatcherPriceSource {
  source: WatcherSource;
  fetchQuotes(request: WatcherQuoteRequest, deps?: WatcherSourceDeps): Promise<WatcherQuoteResults>;
}

export function isWatcherQuoteError(value: WatcherQuote | WatcherQuoteError | undefined): value is WatcherQuoteError {
  return Boolean(value && "kind" in value);
}

export const WATCHER_SOURCE_TIMEOUT_MS = 10_000;
/** First hold after a 429 without Retry-After; doubles on every repeat, up to the ceiling. */
export const WATCHER_RATE_LIMIT_BASE_HOLD_MS = 60_000;
export const WATCHER_RATE_LIMIT_MAX_HOLD_MS = 60 * 60_000;
/** CoinGecko caches its answers for a minute; asking again sooner only spends the free limit. */
export const WATCHER_CRYPTO_CACHE_MS = 55_000;
/** Finnhub's free limit is 60 a minute; stay well under it per key. */
export const WATCHER_FINNHUB_PER_MINUTE = 50;
/** EODHD's free limit is 20 a day; keep two in hand for the operator's own use. */
export const WATCHER_EODHD_PER_DAY = 18;

const USER_AGENT = "Paperclip-Watchers/1.0";

// ─── Provider holds (rate-limit backoff), process-wide ───────────────────────

interface ProviderHold {
  until: number;
  holdMs: number;
}

const holds = new Map<string, ProviderHold>();
const callLog = new Map<string, number[]>();

/** Exported for tests. */
export function resetWatcherSourceState(): void {
  holds.clear();
  callLog.clear();
  cryptoCache.clear();
}

function providerOnHold(provider: string, now: number): boolean {
  const hold = holds.get(provider);
  return Boolean(hold && hold.until > now);
}

function holdProvider(provider: string, now: number, retryAfterMs: number | null): void {
  const previous = holds.get(provider);
  const doubled = previous ? Math.min(previous.holdMs * 2, WATCHER_RATE_LIMIT_MAX_HOLD_MS) : WATCHER_RATE_LIMIT_BASE_HOLD_MS;
  const holdMs = retryAfterMs !== null ? Math.min(Math.max(retryAfterMs, 1_000), WATCHER_RATE_LIMIT_MAX_HOLD_MS) : doubled;
  holds.set(provider, { until: now + holdMs, holdMs });
}

function releaseProvider(provider: string): void {
  holds.delete(provider);
}

/** How long a provider is still on hold, for tests and the log. */
export function watcherProviderHoldMs(provider: string, now = Date.now()): number {
  const hold = holds.get(provider);
  return hold ? Math.max(0, hold.until - now) : 0;
}

/** True (and the call counted) when one more call fits in `limit` per `windowMs`. */
function takeCallBudget(bucket: string, limit: number, windowMs: number, now: number): boolean {
  const recent = (callLog.get(bucket) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    callLog.set(bucket, recent);
    return false;
  }
  recent.push(now);
  callLog.set(bucket, recent);
  return true;
}

/** A key's bucket name: a short hash, so the key itself never becomes a map key or a log field. */
function keyBucket(provider: string, key: string): string {
  return `${provider}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Removes a key (every form of it) and key-shaped text from anything that is shown or logged. */
export function scrubWatcherText(text: string, keys: Array<string | null | undefined>): string {
  return scrubApiToolText(
    text,
    keys.filter((key): key is string => typeof key === "string" && key.length > 0),
    ["token", "api_token"],
  );
}

const ERR = {
  rateLimited: (who: string): WatcherQuoteError => ({
    kind: "rate_limited",
    message: `${who} asked us to slow down. The next check waits a little longer.`,
  }),
  network: (who: string): WatcherQuoteError => ({
    kind: "network",
    message: `Could not reach ${who}. It is usually the network; the next check tries again.`,
  }),
  upstream: (who: string): WatcherQuoteError => ({
    kind: "upstream",
    message: `${who} did not answer as expected. The next check tries again.`,
  }),
  unknown: (who: string, symbol: string): WatcherQuoteError => ({
    kind: "unknown_symbol",
    message: `${who} has no price for ${symbol}. Check the symbol.`,
  }),
  keyMissing: (label: string): WatcherQuoteError => ({
    kind: "key_missing",
    message: `No ${label} is set for this watcher. Pick the secret that holds it on the Watchers page.`,
  }),
  keyRefused: (who: string): WatcherQuoteError => ({
    kind: "key_refused",
    message: `${who} did not accept the key. Check the saved secret, or get a new key from ${who}.`,
  }),
};

async function getJson(
  url: string,
  deps: WatcherSourceDeps,
  headers: Record<string, string> = {},
): Promise<{ ok: true; response: Response; body: unknown } | { ok: false; response: Response | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(WATCHER_SOURCE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, response: null };
  }
  if (!response.ok) return { ok: false, response };
  try {
    return { ok: true, response, body: await response.json() };
  } catch {
    return { ok: false, response };
  }
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** The earlier price implied by a price and its percent change: p / (1 + c/100). */
function priceBefore(price: number, changePercent: unknown): number | null {
  const change = typeof changePercent === "string" ? Number(changePercent) : changePercent;
  if (typeof change !== "number" || !Number.isFinite(change) || change <= -100) return null;
  return price / (1 + change / 100);
}

// ─── Crypto: CoinGecko, then Binance ─────────────────────────────────────────

const cryptoCache = new Map<string, { quote: WatcherQuote; fetchedAt: number }>();

export const COINGECKO_SIMPLE_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
export const BINANCE_TICKER_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";

async function fetchCoinGecko(
  symbols: string[],
  deps: WatcherSourceDeps,
  now: number,
): Promise<WatcherQuoteResults> {
  const results: WatcherQuoteResults = new Map();
  if (providerOnHold("coingecko", now)) {
    for (const symbol of symbols) results.set(symbol, ERR.rateLimited("CoinGecko"));
    return results;
  }
  const ids = symbols.map((symbol) => findWatcherCoin(symbol)!.coingeckoId);
  const query = new URLSearchParams({
    ids: [...new Set(ids)].join(","),
    vs_currencies: "usd",
    include_24hr_change: "true",
    include_last_updated_at: "true",
  });
  const answer = await getJson(`${COINGECKO_SIMPLE_PRICE_URL}?${query.toString()}`, deps);
  if (!answer.ok) {
    const status = answer.response?.status ?? null;
    if (status === 429) {
      holdProvider("coingecko", now, answer.response ? retryAfterMs(answer.response) : null);
    }
    const error = status === 429 ? ERR.rateLimited("CoinGecko") : status === null ? ERR.network("CoinGecko") : ERR.upstream("CoinGecko");
    for (const symbol of symbols) results.set(symbol, error);
    return results;
  }
  releaseProvider("coingecko");
  const body = (answer.body ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const symbol of symbols) {
    const coin = findWatcherCoin(symbol)!;
    const entry = body[coin.coingeckoId];
    const price = positiveNumber(entry?.usd);
    if (!entry || price === null) {
      results.set(symbol, ERR.unknown("CoinGecko", symbol));
      continue;
    }
    const updated = positiveNumber(entry.last_updated_at);
    const observedAt = updated ? new Date(updated * 1000) : new Date(now);
    const before = priceBefore(price, entry.usd_24h_change);
    results.set(symbol, {
      symbol,
      price,
      observedAt,
      reference: before ? { windowHours: 24, price: before, at: new Date(observedAt.getTime() - 24 * 3_600_000) } : null,
      provider: "coingecko",
    });
  }
  return results;
}

async function fetchBinance(symbol: string, deps: WatcherSourceDeps, now: number): Promise<WatcherQuote | WatcherQuoteError> {
  if (providerOnHold("binance", now)) return ERR.rateLimited("Binance");
  const coin = findWatcherCoin(symbol)!;
  const answer = await getJson(`${BINANCE_TICKER_URL}?${new URLSearchParams({ symbol: coin.binancePair }).toString()}`, deps);
  if (!answer.ok) {
    const status = answer.response?.status ?? null;
    // 418 is Binance's "you ignored a 429"; both mean stop for a while.
    if (status === 429 || status === 418) {
      holdProvider("binance", now, answer.response ? retryAfterMs(answer.response) : null);
      return ERR.rateLimited("Binance");
    }
    if (status === 400) return ERR.unknown("Binance", symbol);
    return status === null ? ERR.network("Binance") : ERR.upstream("Binance");
  }
  releaseProvider("binance");
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const price = positiveNumber(body.lastPrice);
  if (price === null) return ERR.unknown("Binance", symbol);
  const closeTime = positiveNumber(body.closeTime);
  const observedAt = closeTime ? new Date(closeTime) : new Date(now);
  const open = positiveNumber(body.openPrice) ?? priceBefore(price, body.priceChangePercent);
  return {
    symbol,
    price,
    observedAt,
    reference: open ? { windowHours: 24, price: open, at: new Date(observedAt.getTime() - 24 * 3_600_000) } : null,
    provider: "binance",
  };
}

export const cryptoSource: WatcherPriceSource = {
  source: "crypto",
  async fetchQuotes(request, deps = {}) {
    const now = (request.now ?? deps.now?.() ?? new Date()).getTime();
    const results: WatcherQuoteResults = new Map();
    const wanted: string[] = [];
    for (const raw of new Set(request.symbols)) {
      const symbol = raw.toUpperCase();
      if (!findWatcherCoin(symbol)) {
        results.set(raw, ERR.unknown("CoinGecko", raw));
        continue;
      }
      const cached = cryptoCache.get(symbol);
      if (cached && now - cached.fetchedAt < WATCHER_CRYPTO_CACHE_MS) results.set(symbol, cached.quote);
      else wanted.push(symbol);
    }
    if (wanted.length === 0) return results;
    const primary = await fetchCoinGecko(wanted, deps, now);
    for (const symbol of wanted) {
      let outcome = primary.get(symbol)!;
      if (isWatcherQuoteError(outcome)) {
        const backup = await fetchBinance(symbol, deps, now);
        // The backup's answer wins when it has a price; otherwise the first
        // problem is the one worth telling (it is the main source).
        if (!isWatcherQuoteError(backup)) outcome = backup;
      }
      if (!isWatcherQuoteError(outcome)) cryptoCache.set(symbol, { quote: outcome, fetchedAt: now });
      results.set(symbol, outcome);
    }
    return results;
  },
};

// ─── US stocks: Finnhub ──────────────────────────────────────────────────────

export const FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote";

export const usStockSource: WatcherPriceSource = {
  source: "us_stock",
  async fetchQuotes(request, deps = {}) {
    const now = (request.now ?? deps.now?.() ?? new Date()).getTime();
    const results: WatcherQuoteResults = new Map();
    const key = request.key?.trim() ?? "";
    const symbols = [...new Set(request.symbols)];
    if (!key) {
      for (const symbol of symbols) results.set(symbol, ERR.keyMissing("Finnhub key"));
      return results;
    }
    const bucket = keyBucket("finnhub", key);
    for (const symbol of symbols) {
      if (providerOnHold(bucket, now)) {
        results.set(symbol, ERR.rateLimited("Finnhub"));
        continue;
      }
      if (!takeCallBudget(bucket, WATCHER_FINNHUB_PER_MINUTE, 60_000, now)) {
        results.set(symbol, ERR.rateLimited("Finnhub"));
        continue;
      }
      const answer = await getJson(`${FINNHUB_QUOTE_URL}?${new URLSearchParams({ symbol }).toString()}`, deps, {
        "X-Finnhub-Token": key,
      });
      if (!answer.ok) {
        const status = answer.response?.status ?? null;
        if (status === 429) {
          holdProvider(bucket, now, answer.response ? retryAfterMs(answer.response) : null);
          results.set(symbol, ERR.rateLimited("Finnhub"));
        } else if (status === 401 || status === 403) {
          results.set(symbol, ERR.keyRefused("Finnhub"));
        } else {
          results.set(symbol, status === null ? ERR.network("Finnhub") : ERR.upstream("Finnhub"));
        }
        continue;
      }
      releaseProvider(bucket);
      const body = (answer.body ?? {}) as Record<string, unknown>;
      const price = positiveNumber(body.c);
      // Finnhub answers an unknown ticker with zeros rather than an error.
      if (price === null) {
        results.set(symbol, ERR.unknown("Finnhub", symbol));
        continue;
      }
      const t = positiveNumber(body.t);
      results.set(symbol, {
        symbol,
        price,
        observedAt: t ? new Date(t * 1000) : new Date(now),
        // pc is the previous close, not a fixed window, so it is not offered
        // as a reference; the watcher's own history measures windows.
        reference: null,
        provider: "finnhub",
      });
    }
    return results;
  },
};

// ─── Oslo Børs: EODHD end-of-day ─────────────────────────────────────────────

export const EODHD_EOD_URL = "https://eodhd.com/api/eod";

/** Oslo Børs closes 16:20 Europe/Oslo; a close is stamped 14:20 UTC (summer time) so windows line up day to day. */
function osloCloseAt(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = new Date(`${date}T14:20:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export const osloStockSource: WatcherPriceSource = {
  source: "oslo_stock",
  async fetchQuotes(request, deps = {}) {
    const nowDate = request.now ?? deps.now?.() ?? new Date();
    const now = nowDate.getTime();
    const results: WatcherQuoteResults = new Map();
    const key = request.key?.trim() ?? "";
    const symbols = [...new Set(request.symbols)];
    if (!key) {
      for (const symbol of symbols) results.set(symbol, ERR.keyMissing("EODHD key"));
      return results;
    }
    const bucket = keyBucket("eodhd", key);
    const from = new Date(now - 10 * 24 * 3_600_000).toISOString().slice(0, 10);
    for (const symbol of symbols) {
      if (providerOnHold(bucket, now)) {
        results.set(symbol, ERR.rateLimited("EODHD"));
        continue;
      }
      if (!takeCallBudget(bucket, WATCHER_EODHD_PER_DAY, 24 * 3_600_000, now)) {
        results.set(symbol, {
          kind: "rate_limited",
          message: "Today's free EODHD requests are used up. Checks start again tomorrow.",
        });
        continue;
      }
      // EODHD only takes the key in the address; it is scrubbed from
      // anything shown, and no error text from this request is ever kept.
      const query = new URLSearchParams({ api_token: key, fmt: "json", from });
      const answer = await getJson(`${EODHD_EOD_URL}/${encodeURIComponent(`${symbol}.OL`)}?${query.toString()}`, deps);
      if (!answer.ok) {
        const status = answer.response?.status ?? null;
        if (status === 429 || status === 402) {
          holdProvider(bucket, now, answer.response ? retryAfterMs(answer.response) : null);
          results.set(symbol, ERR.rateLimited("EODHD"));
        } else if (status === 401 || status === 403) {
          results.set(symbol, ERR.keyRefused("EODHD"));
        } else if (status === 404) {
          results.set(symbol, ERR.unknown("EODHD", symbol));
        } else {
          results.set(symbol, status === null ? ERR.network("EODHD") : ERR.upstream("EODHD"));
        }
        continue;
      }
      releaseProvider(bucket);
      const rows = Array.isArray(answer.body) ? (answer.body as Array<Record<string, unknown>>) : [];
      const closes = rows
        .map((row) => ({ at: osloCloseAt(String(row.date ?? "")), price: positiveNumber(row.close) }))
        .filter((row): row is { at: Date; price: number } => row.at !== null && row.price !== null)
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      const last = closes.at(-1);
      if (!last) {
        results.set(symbol, ERR.unknown("EODHD", symbol));
        continue;
      }
      const previous = closes.at(-2) ?? null;
      results.set(symbol, {
        symbol,
        price: last.price,
        observedAt: last.at,
        // The previous trading day's close stands in for "24 hours ago", and
        // is stamped as such: on a Monday that is Friday's close (72 hours
        // earlier by the clock), which is what people mean by "today's move".
        reference: previous
          ? { windowHours: 24, price: previous.price, at: new Date(last.at.getTime() - 24 * 3_600_000) }
          : null,
        provider: "eodhd",
      });
    }
    return results;
  },
};

// ─── Web page: not fetched through this numeric price-quote abstraction ─────

/**
 * DUR-4168: a web-page watcher is not a price quote -- its four rule kinds
 * (price/stock/new_products/text_change) are fetched and evaluated by
 * watcher-web-page.ts and watcher-web-page-rules.ts, via their own path in
 * the scheduler tick (checkWebPageWatchers in watchers.ts), not by anything
 * here. This entry exists only so WATCHER_PRICE_SOURCES stays a total map
 * over every WatcherSource; checkWatchers (watchers.ts) splits due watchers
 * by source before calling fetchPrices, so this is never actually reached
 * for a real watcher. Kept as a safe fallback (never throws) in case that
 * split is ever bypassed.
 */
const webPageSource: WatcherPriceSource = {
  source: "web_page",
  async fetchQuotes(request) {
    const results: WatcherQuoteResults = new Map();
    for (const symbol of request.symbols) {
      results.set(symbol, { kind: "unavailable", message: "Web page watchers are not checked by this scheduler yet." });
    }
    return results;
  },
};

export const WATCHER_PRICE_SOURCES: Record<WatcherSource, WatcherPriceSource> = {
  crypto: cryptoSource,
  us_stock: usStockSource,
  oslo_stock: osloStockSource,
  web_page: webPageSource,
};
