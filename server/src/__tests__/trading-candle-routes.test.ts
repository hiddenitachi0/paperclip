import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { insertCandles } from "../services/trading-candle-store.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let tradingCandleRoutes: typeof import("../routes/trading-candles.js").tradingCandleRoutes;

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, close = 100 + i) => ({ openTime: new Date(T0 + i * HOUR), open: close - 1, high: close + 1, low: close - 2, close, volume: 5 });

describeDb("candle store routes (DUR-5007)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-candle-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/trading-candles.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/trading-candles.js")>("../routes/trading-candles.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    tradingCandleRoutes = routes.tradingCandleRoutes;
    errorHandler = middleware.errorHandler;
    await db.execute(sql`TRUNCATE trading_candles, trading_candle_ingest_events`);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, actor: Record<string, unknown> | "board" = "board") {
    const server = express();
    server.use((req, _res, next) => {
      (req as any).actor =
        actor === "board"
          ? { type: "board", source: "session", userId: randomUUID(), isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "viewer", status: "active" }] }
          : actor;
      next();
    });
    server.use("/api", tradingCandleRoutes(db));
    server.use(errorHandler);
    return server;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Candle Co ${companyId.slice(0, 8)}`, issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return companyId;
  }

  it("lets an active company member read the summary, with storage size, coverage and the licence note", async () => {
    const companyId = await seedCompany();
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(1), bar(2)]);
    const res = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store`);
    expect(res.status).toBe(200);
    expect(res.body.storage.rows).toBe(3);
    expect(res.body.storage.totalBytes).toBeGreaterThan(0);
    expect(res.body.coverage).toHaveLength(1);
    expect(res.body.coverage[0]).toMatchObject({ source: "kraken", market: "BTC/USD", timeframe: "1h", bars: 3 });
    expect(res.body.licenceNote).toMatch(/Internal research use only/);
  });

  it("serves gap and overlap reports", async () => {
    const companyId = await seedCompany();
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(40)]);
    const gaps = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/gaps?source=kraken&timeframe=1h`);
    expect(gaps.status).toBe(200);
    expect(gaps.body.gaps[0]).toMatchObject({ missingBars: 39 });
    expect(gaps.body.gaps[0].explanation).toMatch(/Early, thin market/);
    const overlap = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/overlap?asset=BTC`);
    expect(overlap.status).toBe(200);
    expect(overlap.body.rows).toEqual([]);
  });

  it("serves Kraken bars but never Binance bars", async () => {
    const companyId = await seedCompany();
    await insertCandles(db, "kraken", "BTC/USD", "1h", [bar(0), bar(1)]);
    await insertCandles(db, "binance", "BTC/USDT", "1h", [bar(0), bar(1)]);
    const kraken = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/candles?source=kraken&market=BTC/USD&timeframe=1h`);
    expect(kraken.status).toBe(200);
    expect(kraken.body.bars).toHaveLength(2);
    const binance = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/candles?source=binance&market=BTC/USDT&timeframe=1h`);
    expect(binance.status).toBe(400);
  });

  it("rejects malformed queries instead of passing them to the database", async () => {
    const companyId = await seedCompany();
    const res = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/candles?source=kraken&market=BTC/USD';DROP&timeframe=1h`);
    expect(res.status).toBe(400);
    const limit = await request(app(companyId)).get(`/api/companies/${companyId}/trading/candle-store/gaps?limit=999999`);
    expect(limit.status).toBe(400);
  });

  it("is board-only: an agent gets 403, and a board user from another company gets 403", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agent = await request(app(companyId, { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" })).get(`/api/companies/${companyId}/trading/candle-store`);
    expect(agent.status).toBe(403);
    const outsider = await request(app(otherCompanyId)).get(`/api/companies/${companyId}/trading/candle-store`);
    expect(outsider.status).toBe(403);
  });

  it("has no route that writes", async () => {
    const companyId = await seedCompany();
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app(companyId))[method](`/api/companies/${companyId}/trading/candle-store/candles`).send({});
      expect(res.status).toBe(404);
    }
  });
});
