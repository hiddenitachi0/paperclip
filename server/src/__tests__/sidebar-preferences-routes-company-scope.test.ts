import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyUserSidebarPreferences,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let sidebarPreferenceRoutes: typeof import("../routes/sidebar-preferences.js").sidebarPreferenceRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres sidebar-preferences company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 follow-up): proves sidebarPreferenceRoutes' scoped
// `/companies/:companyId/sidebar-preferences/me` pair is genuinely wired
// end-to-end over a real HTTP request -- a real reserved Postgres connection,
// a real `app.current_company_id` session claim, and that the claim never
// bleeds one company's preference row into another's response across
// pooled-connection reuse. This route family keys each row on
// (companyId, userId) -- not companyId alone -- so every request below fixes
// the board actor's userId and only varies companyId, to isolate the
// company-scope dimension specifically. The unscoped `/sidebar-preferences/me`
// pair (spans every company a board user belongs to, per the route file's own
// DUR-348 comment) is out of scope for this test. See
// secrets-routes-company-scope.test.ts for the original of this pattern
// (DUR-277/DUR-348).
describeEmbeddedPostgres("sidebarPreferenceRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sidebar-preferences-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/sidebar-preferences.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/sidebar-preferences.js")>("../routes/sidebar-preferences.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    sidebarPreferenceRoutes = routes.sidebarPreferenceRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyUserSidebarPreferences);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[], userId: string) {
    if (!sidebarPreferenceRoutes || !errorHandler) {
      throw new Error("sidebar-preferences route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId,
        companyIds,
      };
      next();
    });
    app.use("/api", sidebarPreferenceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedProjectOrder(companyId: string, userId: string, orderedIds: string[]) {
    await db.insert(companyUserSidebarPreferences).values({
      companyId,
      userId,
      projectOrder: orderedIds,
    });
  }

  it("returns the requesting company's own project order over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompany();
    const userId = randomUUID();
    await seedProjectOrder(companyId, userId, ["project-a", "project-b"]);
    const app = createApp([companyId], userId);

    const res = await request(app).get(`/api/companies/${companyId}/sidebar-preferences/me`);

    expect(res.status).toBe(200);
    expect(res.body.orderedIds).toEqual(["project-a", "project-b"]);
  });

  // DUR-3911: createRequestScopedDb's proxy refuses db.transaction() outright,
  // and this write endpoint also exercises logActivity(db, ...) through the
  // real scoped `db` -- a mocked-service route test can't see either
  // regression class.
  it("upserts a project order over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompany();
    const userId = randomUUID();
    const app = createApp([companyId], userId);
    const orderedIds = [randomUUID(), randomUUID()];

    const res = await request(app)
      .put(`/api/companies/${companyId}/sidebar-preferences/me`)
      .send({ orderedIds });

    expect(res.status).toBe(200);
    expect(res.body.orderedIds).toEqual(orderedIds);

    const rows = await db
      .select()
      .from(companyUserSidebarPreferences)
      .where(eq(companyUserSidebarPreferences.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.projectOrder).toEqual(orderedIds);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"], randomUUID());

    const res = await request(app).get("/api/companies/not-a-uuid/sidebar-preferences/me");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const userId = randomUUID();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    await seedProjectOrder(companyA, userId, ["a-only"]);
    await seedProjectOrder(companyB, userId, ["b-only-1", "b-only-2"]);
    const app = createApp([companyA, companyB], userId);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/sidebar-preferences/me`);
      expect(resA.status).toBe(200);
      expect(resA.body.orderedIds).toEqual(["a-only"]);

      const resB = await request(app).get(`/api/companies/${companyB}/sidebar-preferences/me`);
      expect(resB.status).toBe(200);
      expect(resB.body.orderedIds).toEqual(["b-only-1", "b-only-2"]);
    }
  });
});
