import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  TRADING_ASSETS,
  TRADING_CANDLE_DISPLAYABLE_SOURCES,
  TRADING_CANDLE_LICENCE_NOTE,
  TRADING_CANDLE_SOURCES,
  TRADING_CANDLE_TIMEFRAMES,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { activeSourceStops, coverageReport, gapReport, listCandles, overlapReport, storageReport } from "../services/trading-candle-store.js";
import { getCandleRunnerStatus } from "../services/trading-candle-runner.js";

/**
 * Read-only routes over the candle store (DUR-5007). The tables hold public
 * market data and no company data, so they are not company-scoped: they are one
 * instance-wide store. Until the data-licence terms review is done (see
 * TRADING_CANDLE_LICENCE_NOTE) they are limited to instance admins, and the
 * report scans are expensive enough that no other board user should be able to
 * trigger them. Nothing here writes: the only writer is the candle scheduler chain.
 *
 * Raw bars are only served for sources that may be shown as a live price (not
 * Binance, whose history is for internal past-data tests). The reports show
 * counts and statistics for every source.
 *
 * The reports scan millions of rows, so each one is cached for a few minutes.
 */

const REPORT_CACHE_MS = 5 * 60_000;
const REPORT_CACHE_MAX = 64;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.value as T;
  const value = await load();
  if (cache.size >= REPORT_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

const marketSchema = z.string().regex(/^[A-Z0-9]{2,10}\/(USD|USDT)$/);
const streamQuery = z.object({
  source: z.enum(TRADING_CANDLE_SOURCES).optional(),
  market: marketSchema.optional(),
  timeframe: z.enum(TRADING_CANDLE_TIMEFRAMES).optional(),
});
const gapQuery = streamQuery.extend({
  minMissingBars: z.coerce.number().int().min(1).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const overlapQuery = z.object({ asset: z.enum(TRADING_ASSETS).optional(), timeframe: z.enum(TRADING_CANDLE_TIMEFRAMES).optional() });
const candlesQuery = z.object({
  source: z.enum(TRADING_CANDLE_DISPLAYABLE_SOURCES as [string, ...string[]]),
  market: marketSchema,
  timeframe: z.enum(TRADING_CANDLE_TIMEFRAMES),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

function parse<T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw badRequest("Invalid candle query.", parsed.error.flatten());
  return parsed.data;
}

export function tradingCandleRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);

  function readScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertInstanceAdmin(req);
      assertCompanyAccess(req, companyId);
    });
  }

  /** Where the backfill is, how big the store is, and what it covers. */
  router.get("/companies/:companyId/trading/candle-store", readScope(), async (_req, res) => {
    const [storage, coverage, stops] = await Promise.all([
      cached("storage", () => storageReport(db)),
      cached("coverage", () => coverageReport(db)),
      activeSourceStops(db, new Date()),
    ]);
    res.json({ runner: getCandleRunnerStatus(), storage, coverage, stops, licenceNote: TRADING_CANDLE_LICENCE_NOTE });
  });

  router.get("/companies/:companyId/trading/candle-store/gaps", readScope(), async (req, res) => {
    const query = parse(gapQuery, req.query);
    res.json(await cached(`gaps:${JSON.stringify(query)}`, () => gapReport(db, query)));
  });

  /** Kraken against Binance on the bars both have: price, and volume by rank within each source. */
  router.get("/companies/:companyId/trading/candle-store/overlap", readScope(), async (req, res) => {
    const query = parse(overlapQuery, req.query);
    res.json({ rows: await cached(`overlap:${JSON.stringify(query)}`, () => overlapReport(db, query)) });
  });

  router.get("/companies/:companyId/trading/candle-store/candles", readScope(), async (req, res) => {
    const query = parse(candlesQuery, req.query);
    const bars = await listCandles(db, { ...query, source: query.source as "kraken" });
    res.json({ source: query.source, market: query.market, timeframe: query.timeframe, bars });
  });

  return router;
}
