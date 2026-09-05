import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, goals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let goalRoutes: typeof import("../routes/goals.js").goalRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goals company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 wave): proves goalRoutes is genuinely scoped
// end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's goals into another's response across
// pooled-connection reuse. See secrets-routes-company-scope.test.ts for the
// original of this pattern.
describeEmbeddedPostgres("goalRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goals-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/goals.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/goals.js")>("../routes/goals.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    goalRoutes = routes.goalRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(goals);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!goalRoutes || !errorHandler) {
      throw new Error("goals route test dependencies were not loaded");
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
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithGoals(titles: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const title of titles) {
      await db.insert(goals).values({
        id: randomUUID(),
        companyId,
        title,
      });
    }
    return companyId;
  }

  it("returns the requesting company's own goals over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithGoals(["Ship DUR-373", "Grow revenue"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/goals`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((goal: { companyId: string }) => goal.companyId === companyId)).toBe(true);
  });

  // DUR-3911-style regression guard: goalService(db).create() runs through
  // the request-scoped `db` (not rawDb), and the route also calls
  // logActivity(db, ...) after creating -- exercising the real service
  // through the real scoped proxy is the only way to catch a
  // db.transaction()-through-the-proxy or claim-mismatch regression here.
  it("creates a goal over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithGoals([]);
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "New goal via scoped route" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      title: "New goal via scoped route",
    });

    const rows = await db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("New goal via scoped route");
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/goals");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithGoals(["A Only Goal"]);
    const companyB = await seedCompanyWithGoals(["B Only Goal 1", "B Only Goal 2"]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/goals`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].title).toBe("A Only Goal");

      const resB = await request(app).get(`/api/companies/${companyB}/goals`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((goal: { companyId: string }) => goal.companyId === companyB)).toBe(true);
    }
  });
});
