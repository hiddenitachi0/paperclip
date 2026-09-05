import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let issueTreeControlRoutes: typeof import("../routes/issue-tree-control.js").issueTreeControlRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-tree-control company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 wave): proves issueTreeControlRoutes is genuinely
// scoped end-to-end over a real HTTP request. Unlike the companyId-route-param
// route families, every route here resolves its companyId via a
// lookup-then-scope resolver (the root issue's own `company_id`, via
// scopeFromRootIssue()/companyScope in issue-tree-control.ts) -- so what
// needs proving here is that (a) each company only ever gets holds for its
// own root issue back, (b) a cross-company caller (whose actor.companyIds
// doesn't include the issue's owning company) is rejected before any tree
// data is returned, and (c) no session-claim bleed across repeated
// alternating requests for two different companies' issues over a reused
// pooled connection. See secrets-routes-company-scope.test.ts for the
// original of this pattern.
describeEmbeddedPostgres("issueTreeControlRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-control-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/issue-tree-control.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/issue-tree-control.js")>("../routes/issue-tree-control.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    issueTreeControlRoutes = routes.issueTreeControlRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    if (!issueTreeControlRoutes || !errorHandler) {
      throw new Error("issue-tree-control route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueTreeControlRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardApp(companyIds: string[]) {
    return createApp({
      type: "board",
      source: "local_implicit",
      userId: randomUUID(),
      companyIds,
    });
  }

  async function seedCompanyWithIssue(title: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const [issue] = await db
      .insert(issues)
      .values({
        id: randomUUID(),
        companyId,
        title,
      })
      .returning();
    return { companyId, issueId: issue!.id };
  }

  it("returns the requesting company's own root issue's tree-control state over a real HTTP request through the scope middleware", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("Root issue A");
    const app = boardApp([companyId]);

    const res = await request(app).get(`/api/issues/${issueId}/tree-control/state`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activePauseHold: null });
  });

  // DUR-3911-style regression guard: treeControlSvc.createHold runs its
  // insert through `withCompanyScope(rawDb, companyId, tx => ...)` -- a real
  // transaction against the real scoped `db` is the only way to catch a
  // db.transaction()-through-the-proxy or claim-mismatch regression here.
  it("creates a tree hold over a real HTTP request through the scope middleware, scoped to the root issue's own company", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("Root issue to pause");
    const app = boardApp([companyId]);

    const res = await request(app)
      .post(`/api/issues/${issueId}/tree-holds`)
      .send({ mode: "pause", reason: "company-scope test pause" });

    expect(res.status).toBe(201);
    expect(res.body.hold).toMatchObject({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
    });

    const rows = await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rootIssueId).toBe(issueId);
  });

  it("never returns another company's tree holds for its own root issue's list", async () => {
    const companyA = await seedCompanyWithIssue("A's root issue");
    const companyB = await seedCompanyWithIssue("B's root issue");
    const appA = boardApp([companyA.companyId]);
    const appB = boardApp([companyB.companyId]);

    const createRes = await request(appA)
      .post(`/api/issues/${companyA.issueId}/tree-holds`)
      .send({ mode: "pause" });
    expect(createRes.status).toBe(201);

    const listA = await request(appA).get(`/api/issues/${companyA.issueId}/tree-holds`);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(1);

    const listB = await request(appB).get(`/api/issues/${companyB.issueId}/tree-holds`);
    expect(listB.status).toBe(200);
    expect(listB.body).toHaveLength(0);
  });

  it("rejects a cross-company caller before returning any tree-control data for a root issue outside its access", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("Someone else's root issue");
    // "session" (not local_implicit) actually enforces assertCompanyAccess's
    // companyIds allow-list -- local_implicit unconditionally bypasses it, so
    // this is the actor shape needed to prove the boundary actually rejects.
    const app = createApp({
      type: "board",
      source: "session",
      isInstanceAdmin: false,
      userId: randomUUID(),
      companyIds: [randomUUID()],
    });

    const res = await request(app).get(`/api/issues/${issueId}/tree-control/state`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for a root issue that does not exist, without ever establishing a company scope", async () => {
    const app = boardApp([randomUUID()]);

    const res = await request(app).get(`/api/issues/${randomUUID()}/tree-control/state`);

    expect(res.status).toBe(404);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithIssue("A Only Issue");
    const companyB = await seedCompanyWithIssue("B Only Issue");
    const app = boardApp([companyA.companyId, companyB.companyId]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/issues/${companyA.issueId}/tree-control/state`);
      expect(resA.status).toBe(200);
      expect(resA.body).toMatchObject({ activePauseHold: null });

      const resB = await request(app).get(`/api/issues/${companyB.issueId}/tree-control/state`);
      expect(resB.status).toBe(200);
      expect(resB.body).toMatchObject({ activePauseHold: null });
    }
  });
});
