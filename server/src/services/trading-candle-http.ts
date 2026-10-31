import type { TradingCandleSource } from "@paperclipai/shared";

/**
 * The only door the candle store uses to reach the internet (DUR-5007).
 *
 * Outbound calls are limited to the public market-data hosts below: https only,
 * redirects are followed by hand and only to another allowed host, every call
 * has a timeout and a size cap, a 429 is retried with a back-off, and a 418
 * (Binance's "you are banned") or 451 (blocked location) stops that source
 * instead of retrying. No credentials are ever sent.
 */

export const CANDLE_HOSTS: Readonly<Record<string, TradingCandleSource>> = {
  "assets.kraken.com": "kraken",
  "api.kraken.com": "kraken",
  "data.binance.vision": "binance",
  "data-api.binance.vision": "binance",
  "api.exchange.coinbase.com": "coinbase",
};

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const RATE_LIMIT_RETRIES = 4;
const DEFAULT_BAN_MS = 6 * 60 * 60_000;

/** The source asked us to stop (418/451). The caller records it and leaves the source alone until `until`. */
export class CandleSourceStop extends Error {
  constructor(
    readonly source: TradingCandleSource,
    readonly status: number,
    readonly until: Date,
    message: string,
  ) {
    super(message);
    this.name = "CandleSourceStop";
  }
}

export class CandleHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CandleHttpError";
  }
}

export interface CandleHttpOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Called with a Binance weight header value so the caller can pace itself. */
  onWeight?: (usedWeight: number) => void;
}

export interface CandleHttp {
  /** `null` on a 404, the parsed JSON otherwise. */
  getJson(url: string): Promise<unknown | null>;
  /** The file size, or null on a 404. */
  headSize(url: string): Promise<number | null>;
  /** The whole body (capped), or null on a 404. */
  getBytes(url: string): Promise<Buffer | null>;
  /** `length` bytes from `start`; throws when the server does not honour the range. */
  getRange(url: string, start: number, length: number): Promise<Buffer>;
}

function sourceOfUrl(rawUrl: string): { url: URL; source: TradingCandleSource } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CandleHttpError(null, "Candle request refused: not a valid address.");
  }
  const source = CANDLE_HOSTS[url.hostname];
  if (url.protocol !== "https:" || !source || url.username || url.password || (url.port && url.port !== "443")) {
    throw new CandleHttpError(null, `Candle request refused: ${url.hostname} is not an allowed market-data host.`);
  }
  return { url, source };
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function createCandleHttp(options: CandleHttpOptions = {}): CandleHttp {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowOf = options.now ?? (() => new Date());

  async function request(rawUrl: string, init: { method: "GET" | "HEAD"; headers?: Record<string, string> }): Promise<Response | null> {
    let target = rawUrl;
    for (let attempt = 0; ; attempt++) {
      let redirects = 0;
      let response: Response;
      for (;;) {
        const { url, source } = sourceOfUrl(target);
        try {
          response = await fetchImpl(url, {
            method: init.method,
            headers: { accept: "*/*", "user-agent": "paperclip-candle-store", ...init.headers },
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          throw new CandleHttpError(null, `Candle request to ${url.hostname} failed: ${err instanceof Error ? err.message : "network error"}`);
        }
        const weight = Number(response.headers.get("x-mbx-used-weight-1m"));
        if (Number.isFinite(weight) && weight > 0) options.onWeight?.(weight);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || ++redirects > MAX_REDIRECTS) throw new CandleHttpError(response.status, "Candle request refused: too many redirects.");
          target = new URL(location, url).toString();
          continue;
        }
        if (response.status === 418 || response.status === 451) {
          const wait = retryAfterMs(response) ?? DEFAULT_BAN_MS;
          throw new CandleSourceStop(source, response.status, new Date(nowOf().getTime() + wait), `${url.hostname} answered ${response.status}; leaving this source alone.`);
        }
        break;
      }
      if (response.status === 404) return null;
      if (response.status === 429) {
        if (attempt >= RATE_LIMIT_RETRIES) throw new CandleHttpError(429, "Candle request kept hitting the rate limit.");
        await sleep(Math.min(retryAfterMs(response) ?? 2 ** attempt * 2000, 120_000));
        target = rawUrl;
        continue;
      }
      return response;
    }
  }

  async function readBody(response: Response, cap: number): Promise<Buffer> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new CandleHttpError(response.status, "Candle response is larger than allowed.");
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new CandleHttpError(response.status, "Candle response is larger than allowed.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  function failIfNotOk(response: Response) {
    if (!response.ok) throw new CandleHttpError(response.status, `Candle request answered ${response.status}.`);
  }

  return {
    async getJson(url) {
      const response = await request(url, { method: "GET", headers: { accept: "application/json" } });
      if (!response) return null;
      failIfNotOk(response);
      const body = await readBody(response, MAX_JSON_BYTES);
      try {
        return JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        throw new CandleHttpError(response.status, "Candle response was not valid JSON.");
      }
    },
    async headSize(url) {
      const response = await request(url, { method: "HEAD" });
      if (!response) return null;
      failIfNotOk(response);
      const size = Number(response.headers.get("content-length"));
      if (!Number.isFinite(size) || size < 0) throw new CandleHttpError(response.status, "Candle file has no size.");
      return size;
    },
    async getBytes(url) {
      const response = await request(url, { method: "GET" });
      if (!response) return null;
      failIfNotOk(response);
      return readBody(response, MAX_BODY_BYTES);
    },
    async getRange(url, start, length) {
      if (length <= 0) return Buffer.alloc(0);
      const response = await request(url, { method: "GET", headers: { range: `bytes=${start}-${start + length - 1}` } });
      if (!response) throw new CandleHttpError(404, "Candle file is gone.");
      if (response.status !== 206) throw new CandleHttpError(response.status, "Candle file server does not support partial downloads.");
      const body = await readBody(response, length + 1);
      if (body.length !== length) throw new CandleHttpError(206, "Candle file returned the wrong amount of data.");
      return body;
    },
  };
}
