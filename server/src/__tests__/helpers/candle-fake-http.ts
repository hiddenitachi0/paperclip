import { CandleHttpError, type CandleHttp } from "../../services/trading-candle-http.js";

export type FakeRoute = (url: string) => unknown | Buffer | null | undefined | Promise<unknown | Buffer | null | undefined>;

/**
 * A scripted CandleHttp: `routes` answers by URL prefix (longest match wins).
 * JSON routes return a value, file routes return a Buffer, `null` = 404.
 * Every call is recorded in `calls`.
 */
export function fakeCandleHttp(routes: Record<string, FakeRoute | unknown | Buffer | null>, options: { failAfter?: number } = {}) {
  const calls: string[] = [];
  let count = 0;
  async function answer(url: string): Promise<unknown | Buffer | null> {
    calls.push(url);
    count += 1;
    if (options.failAfter !== undefined && count > options.failAfter) throw new CandleHttpError(500, "simulated outage");
    const key = Object.keys(routes)
      .filter((prefix) => url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return null; // an unscripted address is a 404, like the real thing
    const route = routes[key];
    const value = typeof route === "function" ? await (route as FakeRoute)(url) : route;
    return value === undefined ? null : value;
  }
  const http: CandleHttp = {
    async getJson(url) {
      const value = await answer(url);
      return Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : value;
    },
    async headSize(url) {
      const value = await answer(url);
      return Buffer.isBuffer(value) ? value.length : null;
    },
    async getBytes(url) {
      const value = await answer(url);
      return Buffer.isBuffer(value) ? value : null;
    },
    async getRange(url, start, length) {
      const value = await answer(url);
      if (!Buffer.isBuffer(value)) throw new CandleHttpError(404, "gone");
      return value.subarray(start, start + length);
    },
  };
  return { http, calls };
}
