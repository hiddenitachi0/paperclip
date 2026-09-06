import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, costEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let costRoutes: typeof import("../routes/costs.js").costRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres costs company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 wave, PR #205 wired costRoutes through
// companyScope/companyScopeFromParam): proves costRoutes is genuinely scoped
// end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's cost data into another's response across
// pooled-connection reuse. `costs-service.test.ts` already has embedded
// Postgres coverage for the *service*'s aggregation math (int32 overflow,
// recursive issue-tree sums); this file is deliberately separate and
// route-focused, matching the secrets-routes-company-scope.test.ts template
// exactly, so it doesn't get lost among that file's much larger mocked-route
// unit-test suite.
describeEmbeddedPostgres("costRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/costs.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    costRoutes = routes.costRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!costRoutes || !errorHandler) {
      throw new Error("costs route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: randomUUID(),
        companyIds,
      };
      next();
    });
    app.use("/api", costRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithCostEvents(costCentsList: number[]) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    for (const costCents of costCentsList) {
      await db.insert(costEvents).values({
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        costCents,
        occurredAt: new Date(),
      });
    }
    return { companyId, agentId };
  }

  it("returns the requesting company's own cost summary over a real HTTP request through the scope middleware", async () => {
    const { companyId } = await seedCompanyWithCostEvents([100, 250]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/costs/summary`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ companyId, spendCents: 350 });
  });

  // DUR-3911-style regression: costService(db).createEvent() runs through the
  // real request-scoped db, not a mocked service -- exercising it here is the
  // only way to catch a route that quietly stopped working through the
  // scoped Proxy (e.g. a db.transaction() call that the Proxy refuses).
  it("creates a cost event over a real HTTP request through the scope middleware", async () => {
    const { companyId, agentId } = await seedCompanyWithCostEvents([]);
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/cost-events`)
      .send({
        agentId,
        provider: "openai",
        model: "gpt-5",
        costCents: 500,
        occurredAt: new Date().toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId, agentId, costCents: 500 });

    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/costs/summary");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithCostEvents([100]);
    const companyB = await seedCompanyWithCostEvents([200, 300]);
    const app = createApp([companyA.companyId, companyB.companyId]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA.companyId}/costs/summary`);
      expect(resA.status).toBe(200);
      expect(resA.body.spendCents).toBe(100);

      const resB = await request(app).get(`/api/companies/${companyB.companyId}/costs/summary`);
      expect(resB.status).toBe(200);
      expect(resB.body.spendCents).toBe(500);
    }
  });
});
