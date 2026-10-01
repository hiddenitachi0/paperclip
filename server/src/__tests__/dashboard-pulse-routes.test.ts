import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, createDb } from "@paperclipai/db";
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
    `Skipping embedded Postgres dashboard pulse route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-4199: the pulse route is board-only (unlike /dashboard, which any
// company-scoped actor can read) because it surfaces today's spend -- the
// parent plan (DUR-4154) explicitly scopes budget display to company
// members, not agent API keys.
describeEmbeddedPostgres("dashboard pulse route access", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-pulse-route-");
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
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function appWithActor(actor: Record<string, unknown>) {
    if (!dashboardRoutes || !errorHandler) {
      throw new Error("dashboard route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("returns the pulse payload for a board actor who is a member of the company", async () => {
    const companyId = await seedCompany();
    const app = appWithActor({
      type: "board",
      source: "local_implicit",
      userId: randomUUID(),
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/dashboard/pulse`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.needsYouCount).toBe(0);
    expect(res.body.budget).toMatchObject({ spentTodayCents: 0, dailyLimitCents: null, status: "ok" });
  });

  it("refuses an agent actor from the same company", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Some Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = appWithActor({ type: "agent", agentId, companyId });

    const res = await request(app).get(`/api/companies/${companyId}/dashboard/pulse`);

    expect(res.status).toBe(403);
  });

  it("refuses a board actor who is not a member of the target company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const app = appWithActor({
      type: "board",
      source: "session",
      userId: randomUUID(),
      companyIds: [otherCompanyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/dashboard/pulse`);

    expect(res.status).toBe(403);
  });
});
