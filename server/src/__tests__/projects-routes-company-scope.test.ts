import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, projectWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let projectRoutes: typeof import("../routes/projects.js").projectRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres projects company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277 Wave 2 follow-up): proves projectRoutes is genuinely
// scoped end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's projects into another's response across
// pooled-connection reuse. See secrets-routes-company-scope.test.ts for the
// pattern this follows.
describeEmbeddedPostgres("projectRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projects-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    projectRoutes = routes.projectRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(activityLog);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[], actorOverrides: Record<string, unknown> = {}) {
    if (!projectRoutes || !errorHandler) {
      throw new Error("projects route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: randomUUID(),
        companyIds,
        ...actorOverrides,
      };
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithProjects(names: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const projectIds: string[] = [];
    for (const name of names) {
      const [project] = await db.insert(projects).values({ id: randomUUID(), companyId, name }).returning();
      projectIds.push(project!.id);
    }
    return { companyId, projectIds };
  }

  it("returns the requesting company's own projects over a real HTTP request through the scope middleware", async () => {
    const { companyId } = await seedCompanyWithProjects(["Alpha", "Beta"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/projects`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((project: { companyId: string }) => project.companyId === companyId)).toBe(true);
  });

  it("resolves the (b)-category /projects/:id route (post router.param shortname lookup) to the project's own company scope", async () => {
    const { companyId, projectIds } = await seedCompanyWithProjects(["Alpha"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/projects/${projectIds[0]}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: projectIds[0], companyId });
  });

  // DUR-3911-class regression: services/projects.ts's create/update/remove
  // workspace methods used to call db.transaction() directly, which the
  // request-scoped proxy refuses outright. Exercising the real (unmocked)
  // service through the real scoped `db` over an actual HTTP request is the
  // only way to catch that class of regression -- see the withCompanyScope
  // conversion this ticket made in services/projects.ts.
  it("creates a project workspace over a real HTTP request through the scope middleware", async () => {
    const { companyId, projectIds } = await seedCompanyWithProjects(["Alpha"]);
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/projects/${projectIds[0]}/workspaces`)
      .send({ name: "primary", cwd: "/tmp/alpha" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ name: "primary", cwd: "/tmp/alpha" });

    const rows = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectIds[0]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(companyId);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/projects");

    expect(res.status).toBe(400);
  });

  it("403s the (b)-category route for a session-sourced board caller with no membership in the project's company", async () => {
    const { projectIds } = await seedCompanyWithProjects(["Alpha"]);
    const outsiderCompanyId = randomUUID();
    await db.insert(companies).values({
      id: outsiderCompanyId,
      name: `Company ${outsiderCompanyId.slice(0, 8)}`,
      issuePrefix: `O${outsiderCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    // `local_implicit` (used by every other test in this file) is the
    // local-dev board identity and bypasses company-membership checks
    // entirely (see authorization.ts's "allow_local_board" branch) -- this
    // is the one test that needs a real session-sourced board actor to
    // exercise the actual cross-company boundary in assertCompanyAccess.
    const app = createApp([outsiderCompanyId], { source: "session", isInstanceAdmin: false });

    const res = await request(app).get(`/api/projects/${projectIds[0]}`);

    expect(res.status).toBe(403);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithProjects(["a-only"]);
    const companyB = await seedCompanyWithProjects(["b-only-1", "b-only-2"]);
    const app = createApp([companyA.companyId, companyB.companyId]);

    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA.companyId}/projects`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].name).toBe("a-only");

      const resB = await request(app).get(`/api/companies/${companyB.companyId}/projects`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((project: { companyId: string }) => project.companyId === companyB.companyId)).toBe(true);
    }
  });
});
