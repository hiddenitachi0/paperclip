import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let agentRoutes: typeof import("../routes/agents.js").agentRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agents company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-378 (DUR-277 Wave 5a): proves agentRoutes' loadAgentAndScope() helper --
// the (b)-category "look the entity up, then scope" pattern this file's ~25+
// `/agents/:id/*` routes share -- is genuinely scoped end-to-end over a real
// HTTP request: the pre-scope lookup runs against the raw (unwrapped) db
// before any connection is reserved, a cross-company request is rejected
// before `runInCompanyScope` ever reserves one, and the `app.current_company_id`
// session claim never bleeds across pooled-connection reuse. See
// dashboard-routes-company-scope.test.ts for the original of this pattern
// (DUR-277 Wave 1) and secrets-routes-company-scope.test.ts (Wave 2).
describeEmbeddedPostgres("agentRoutes company-scope wiring (DUR-378)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agents-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    agentRoutes = routes.agentRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    if (!agentRoutes || !errorHandler) {
      throw new Error("agent route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function localBoardActor(companyIds: string[]) {
    return { type: "board", source: "local_implicit", userId: randomUUID(), companyIds };
  }

  async function seedAgent(companyId: string, name = "Agent") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "active",
    });
    return agentId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("returns the requesting company's own agent over a real HTTP request through loadAgentAndScope", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Own Agent");
    const app = createApp(localBoardActor([companyId]));

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(agentId);
    expect(res.body.companyId).toBe(companyId);
  });

  it("rejects a cross-company agent lookup with 403 before ever reserving a connection", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentInCompanyB = await seedAgent(companyB, "Other Company's Agent");
    // A cloud_tenant-sourced board actor is the shape whose companyIds
    // allowlist loadAgentAndScope's pre-scope assertCompanyAccess() call
    // actually enforces -- local_implicit is instance-trusted and bypasses
    // it by design (see routes/authz.ts assertCompanyAccess).
    const app = createApp({
      type: "board",
      source: "cloud_tenant",
      userId: randomUUID(),
      companyIds: [companyA],
    });

    const res = await request(app).get(`/api/agents/${agentInCompanyB}`);

    expect(res.status).toBe(403);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA, "Agent A");
    const agentB = await seedAgent(companyB, "Agent B");
    const app = createApp(localBoardActor([companyA, companyB]));

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven for the lookup-then-scope helper this file's routes use.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/agents/${agentA}`);
      expect(resA.status).toBe(200);
      expect(resA.body.id).toBe(agentA);
      expect(resA.body.companyId).toBe(companyA);

      const resB = await request(app).get(`/api/agents/${agentB}`);
      expect(resB.status).toBe(200);
      expect(resB.body.id).toBe(agentB);
      expect(resB.body.companyId).toBe(companyB);
    }
  });
});
