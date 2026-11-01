import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approvals, companies, createDb, tradingStrategies } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let tradingRoutes: typeof import("../routes/trading.js").tradingRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) console.warn(`Skipping trading template route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);

/**
 * DUR-5014 (decision 19): the template library is not shown to client
 * companies before the legal check. Every template route needs an instance
 * admin, whatever role the caller holds in the company named in the path, and
 * creating a strategy from a template is held to the same bar.
 */
describeEmbeddedPostgres("tradingRoutes templates (DUR-5014)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-template-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/trading.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/trading.js")>("../routes/trading.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    tradingRoutes = routes.tradingRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(tradingStrategies);
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, opts: { instanceAdmin: boolean; role?: "owner" | "admin" | "viewer" }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: randomUUID(),
        isInstanceAdmin: opts.instanceAdmin,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: opts.role ?? "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", tradingRoutes(db, { marketData: fakeTradingMarketData({ candles: { BTC: { candles: [] } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: new Date() } } }) }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Client Co", issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return id;
  }

  it("keeps the library from a company owner who is not an instance admin, on every route", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId, { instanceAdmin: false, role: "owner" });
    expect((await request(app).get(`/api/companies/${companyId}/trading/templates`)).status).toBe(403);
    expect((await request(app).get(`/api/companies/${companyId}/trading/templates/pullback`)).status).toBe(403);
    expect((await request(app).get(`/api/companies/${companyId}/trading/templates/pullback/reports/${randomUUID()}`)).status).toBe(403);
    const created = await request(app).post(`/api/companies/${companyId}/trading/strategies/from-template`).send({ templateKey: "pullback", asset: "BTC" });
    expect(created.status).toBe(403);
    expect(await db.select().from(tradingStrategies)).toHaveLength(0);
  });

  it("shows the library to an instance admin: templates, controls, the excluded style with its reason and the matrix", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId, { instanceAdmin: true });
    const res = await request(app).get(`/api/companies/${companyId}/trading/templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(["trend_continuation", "pullback", "breakout", "support_resistance_bounce", "momentum", "vwap_reclaim", "high_volume_spike", "opening_range", "reversal", "buy_and_hold", "stay_in_cash", "random_entry"]));
    expect(res.body.excluded[0]).toMatchObject({ key: "gap_and_go" });
    expect(res.body.matrix.rows.trend.cells.down).toBe("cash_only");
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/\bready\b|\bpromising\b/);
    expect((await request(app).get(`/api/companies/${companyId}/trading/templates/nope`)).status).toBe(404);
    expect((await request(app).get(`/api/companies/${companyId}/trading/templates/pullback`)).status).toBe(200);
  });

  it("creates a paused strategy from a template for an instance admin, and refuses unknown or malformed requests", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId, { instanceAdmin: true });
    const created = await request(app).post(`/api/companies/${companyId}/trading/strategies/from-template`).send({ templateKey: "breakout", asset: "BTC" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ templateKey: "breakout", templateVersion: 1, status: "paused", timeframe: "4h" });
    expect((await request(app).post(`/api/companies/${companyId}/trading/strategies/from-template`).send({ templateKey: "gap_and_go", asset: "BTC" })).status).toBe(404);
    expect((await request(app).post(`/api/companies/${companyId}/trading/strategies/from-template`).send({ templateKey: "breakout", asset: "BTC", spec: {} })).status).toBe(400);
    expect((await request(app).post(`/api/companies/${companyId}/trading/strategies/from-template`).send({ templateKey: "breakout" })).status).toBe(400);
  });
});
