import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let activityRoutes: typeof import("../routes/activity.js").activityRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 wave, PR #205 wired activityRoutes through
// companyScope/companyScopeFromParam): proves activityRoutes is genuinely
// scoped end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's activity into another's response across
// pooled-connection reuse. See secrets-routes-company-scope.test.ts for the
// original of this pattern (DUR-348).
describeEmbeddedPostgres("activityRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/activity.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/activity.js")>("../routes/activity.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    activityRoutes = routes.activityRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!activityRoutes || !errorHandler) {
      throw new Error("activity route test dependencies were not loaded");
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
    app.use("/api", activityRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithActivity(actions: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const action of actions) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "seed-script",
        action,
        entityType: "test_entity",
        entityId: randomUUID(),
        details: {},
      });
    }
    return companyId;
  }

  it("returns the requesting company's own activity over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithActivity(["issue.created", "issue.checked_out"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/activity`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((event: { companyId: string }) => event.companyId === companyId)).toBe(true);
  });

  it("creates an activity event over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithActivity([]);
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/activity`)
      .send({
        actorId: "test-actor",
        action: "issue.created",
        entityType: "issue",
        entityId: randomUUID(),
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      actorId: "test-actor",
      action: "issue.created",
    });

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/activity");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithActivity(["a.only.action"]);
    const companyB = await seedCompanyWithActivity(["b.only.action.1", "b.only.action.2"]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/activity`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].action).toBe("a.only.action");

      const resB = await request(app).get(`/api/companies/${companyB}/activity`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((event: { companyId: string }) => event.companyId === companyB)).toBe(true);
    }
  });
});
