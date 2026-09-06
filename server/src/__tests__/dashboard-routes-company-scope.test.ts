import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let dashboardRoutes: typeof import("../routes/dashboard.js").dashboardRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-277: proves dashboardRoutes -- the first route family wired through
// server/src/middleware/company-scope.ts -- is genuinely scoped end-to-end
// over a real HTTP request: a real reserved Postgres connection, a real
// `app.current_company_id` session claim, and (critically, since the app's
// live DATABASE_URL role still owns every table and is unaffected by RLS
// until the Phase 2 cutover DUR-250 tracks separately) that the claim is
// reset before a reserved connection is recycled by the pool, so back-to-back
// requests for different companies over the same physical connection can
// never bleed one company's dashboard into another's response.
describeEmbeddedPostgres("dashboardRoutes company-scope wiring (DUR-277)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/dashboard.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/dashboard.js")>("../routes/dashboard.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    dashboardRoutes = routes.dashboardRoutes;
    errorHandler = middleware.errorHandler;
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!dashboardRoutes || !errorHandler) {
      throw new Error("dashboard route test dependencies were not loaded");
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
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(agentCount: number, issueCount: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (let i = 0; i < agentCount; i++) {
      await db.insert(agents).values({
        id: randomUUID(),
        companyId,
        name: `Agent ${i}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        status: "active",
      });
    }
    for (let i = 0; i < issueCount; i++) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `Issue ${i}`,
        status: "in_progress",
        priority: "medium",
        identifier: `D${i}-${companyId.slice(0, 4)}`,
      });
    }
    return companyId;
  }

  it("returns the requesting company's own dashboard summary over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompany(2, 3);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/dashboard`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.agents.active).toBe(2);
    expect(res.body.tasks.inProgress).toBe(3);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/dashboard");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompany(1, 2);
    const companyB = await seedCompany(5, 1);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/dashboard`);
      expect(resA.status).toBe(200);
      expect(resA.body.companyId).toBe(companyA);
      expect(resA.body.agents.active).toBe(1);

      const resB = await request(app).get(`/api/companies/${companyB}/dashboard`);
      expect(resB.status).toBe(200);
      expect(resB.body.companyId).toBe(companyB);
      expect(resB.body.agents.active).toBe(5);
    }
  });
});
