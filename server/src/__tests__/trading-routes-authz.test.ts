import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, tradingStrategies } from "@paperclipai/db";
import { DEFAULT_TRADING_RISK_CONFIG, DEFAULT_TRADING_RULE_CONFIG } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let tradingRoutes: typeof import("../routes/trading.js").tradingRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres trading route authz tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type MembershipRole = "owner" | "admin" | "operator" | "viewer";

/**
 * DUR-4171: trading.ts's own doc comment claims reading is open to any
 * active company member while changing a strategy (create/update/kill
 * switch) is owner/admin-only -- the same bar as company connections. This
 * is the first HTTP-level test proving that boundary actually holds over a
 * real request through companyScopeFromParam + assertCompanyOwnerAdminOrInstanceAdmin,
 * rather than only trusting the doc comment and the underlying authz
 * helper's own (separately tested) unit behavior.
 */
describeEmbeddedPostgres("tradingRoutes authz (DUR-4171)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-routes-authz-");
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
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, membershipRole: MembershipRole) {
    if (!tradingRoutes || !errorHandler) {
      throw new Error("trading route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // source !== "local_implicit" and isInstanceAdmin: false so the
      // membershipRole below is what actually decides the outcome, instead
      // of one of assertCompanyOwnerAdminOrInstanceAdmin's other bypasses.
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: randomUUID(),
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
      };
      next();
    });
    // No network access -- see trading-market-data.ts's module doc comment (fakeTradingMarketData exists so exactly this kind of test never hits real Kraken).
    app.use("/api", tradingRoutes(db, { marketData: fakeTradingMarketData({}) }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Trading Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  const strategyBody = {
    name: "Test strategy",
    asset: "BTC",
    checkEveryMinutes: 15,
    startingCashNok: 3_000,
    ruleConfig: DEFAULT_TRADING_RULE_CONFIG,
    riskConfig: DEFAULT_TRADING_RISK_CONFIG,
  };

  it.each(["owner", "admin"] as const)("lets an active %s create a strategy", async (membershipRole) => {
    const companyId = await seedCompany();
    const app = createApp(companyId, membershipRole);

    const res = await request(app).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId, name: "Test strategy", status: "paused" });
  });

  it.each(["operator", "viewer"] as const)("refuses a %s creating a strategy with 403", async (membershipRole) => {
    const companyId = await seedCompany();
    const app = createApp(companyId, membershipRole);

    const res = await request(app).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);

    expect(res.status).toBe(403);
    const rows = await db.select().from(tradingStrategies);
    expect(rows).toHaveLength(0); // refused before any write, not just a misleading response code
  });

  it("refuses a non-owner/admin pulling the kill switch (status route) with 403", async () => {
    const companyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const viewerApp = createApp(companyId, "viewer");
    const res = await request(viewerApp)
      .post(`/api/companies/${companyId}/trading/strategies/${created.body.id}/status`)
      .send({ status: "running" });

    expect(res.status).toBe(403);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, created.body.id));
    expect(row?.status).toBe("paused"); // untouched by the refused request
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)("lets any active %s read the strategy list and dashboard", async (membershipRole) => {
    const companyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const readerApp = createApp(companyId, membershipRole);
    const list = await request(readerApp).get(`/api/companies/${companyId}/trading/strategies`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const dashboard = await request(readerApp).get(`/api/companies/${companyId}/trading/strategies/${created.body.id}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({ strategyId: created.body.id, status: "paused" });
  });

  it("refuses a board actor from a different company's companyIds with 403, not a data leak", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const ownerApp = createApp(companyId, "owner");
    const created = await request(ownerApp).post(`/api/companies/${companyId}/trading/strategies`).send(strategyBody);
    expect(created.status).toBe(201);

    const outsiderApp = createApp(otherCompanyId, "owner"); // owner of otherCompanyId, not companyId
    const res = await request(outsiderApp).get(`/api/companies/${companyId}/trading/strategies`);
    expect(res.status).toBe(403);
  });
});
