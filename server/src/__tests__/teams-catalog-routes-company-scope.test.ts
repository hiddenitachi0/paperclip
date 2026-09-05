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
let teamsCatalogRoutes: typeof import("../routes/teams-catalog.js").teamsCatalogRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres teams-catalog company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 follow-up): proves teamsCatalogRoutes' scoped
// `/companies/:companyId/teams/catalog/*` group is genuinely wired
// end-to-end over a real HTTP request -- a real reserved Postgres connection,
// a real `app.current_company_id` session claim, and that the claim never
// bleeds one company's installed-team roster into another's response across
// pooled-connection reuse. The plain `/teams/catalog*` group (global catalog
// browsing, no companyId) stays unscoped by design per the route file's own
// DUR-348 comment and is out of scope for this test. See
// secrets-routes-company-scope.test.ts for the original of this pattern
// (DUR-277/DUR-348).
describeEmbeddedPostgres("teamsCatalogRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-catalog-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/teams-catalog.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/teams-catalog.js")>("../routes/teams-catalog.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    teamsCatalogRoutes = routes.teamsCatalogRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!teamsCatalogRoutes || !errorHandler) {
      throw new Error("teams-catalog route test dependencies were not loaded");
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
    app.use("/api", teamsCatalogRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithCatalogAgents(installs: { catalogId: string; catalogKey: string }[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const install of installs) {
      await db.insert(agents).values({
        id: randomUUID(),
        companyId,
        name: `Agent for ${install.catalogKey}`,
        metadata: {
          paperclip: {
            catalogTeam: {
              catalogId: install.catalogId,
              catalogKey: install.catalogKey,
              originHash: "deadbeef",
            },
          },
        },
      });
    }
    return companyId;
  }

  it("returns the requesting company's own installed catalog teams over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithCatalogAgents([
      { catalogId: "catalog-team-a", catalogKey: "team-a" },
    ]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/teams/catalog/installed`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ catalogId: "catalog-team-a", catalogKey: "team-a", agentCount: 1 });
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/teams/catalog/installed");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithCatalogAgents([{ catalogId: "catalog-a-only", catalogKey: "a-only" }]);
    const companyB = await seedCompanyWithCatalogAgents([
      { catalogId: "catalog-b-only-1", catalogKey: "b-only-1" },
      { catalogId: "catalog-b-only-2", catalogKey: "b-only-2" },
    ]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/teams/catalog/installed`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].catalogId).toBe("catalog-a-only");

      const resB = await request(app).get(`/api/companies/${companyB}/teams/catalog/installed`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.map((entry: { catalogId: string }) => entry.catalogId).sort()).toEqual([
        "catalog-b-only-1",
        "catalog-b-only-2",
      ]);
    }
  });
});
