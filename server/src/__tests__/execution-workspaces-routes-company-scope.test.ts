import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, executionWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let executionWorkspaceRoutes: typeof import("../routes/execution-workspaces.js").executionWorkspaceRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-workspaces company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277 Wave 2 follow-up): proves executionWorkspaceRoutes is
// genuinely scoped end-to-end over a real HTTP request -- a real reserved
// Postgres connection, a real `app.current_company_id` session claim, and
// that the claim never bleeds one company's execution workspaces into
// another's response across pooled-connection reuse. See
// secrets-routes-company-scope.test.ts for the pattern this follows.
describeEmbeddedPostgres("executionWorkspaceRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspaces-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/execution-workspaces.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/execution-workspaces.js")>("../routes/execution-workspaces.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    executionWorkspaceRoutes = routes.executionWorkspaceRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[], actorOverrides: Record<string, unknown> = {}) {
    if (!executionWorkspaceRoutes || !errorHandler) {
      throw new Error("execution-workspaces route test dependencies were not loaded");
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
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithWorkspaces(names: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const [project] = await db
      .insert(projects)
      .values({ id: randomUUID(), companyId, name: `Project ${companyId.slice(0, 8)}` })
      .returning();
    const workspaceIds: string[] = [];
    for (const name of names) {
      const id = randomUUID();
      workspaceIds.push(id);
      await db.insert(executionWorkspaces).values({
        id,
        companyId,
        projectId: project!.id,
        mode: "shared",
        strategyType: "project_primary",
        name,
      });
    }
    return { companyId, workspaceIds };
  }

  it("returns the requesting company's own execution workspaces over a real HTTP request through the scope middleware", async () => {
    const { companyId } = await seedCompanyWithWorkspaces(["ws-a", "ws-b"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/execution-workspaces`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((ws: { companyId: string }) => ws.companyId === companyId)).toBe(true);
  });

  it("resolves the (b)-category /execution-workspaces/:id route to the workspace's own company scope", async () => {
    const { companyId, workspaceIds } = await seedCompanyWithWorkspaces(["ws-only"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/execution-workspaces/${workspaceIds[0]}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceIds[0], companyId });
  });

  it("403s the (b)-category route for a session-sourced board caller with no membership in the workspace's company", async () => {
    const { workspaceIds } = await seedCompanyWithWorkspaces(["ws-only"]);
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

    const res = await request(app).get(`/api/execution-workspaces/${workspaceIds[0]}`);

    expect(res.status).toBe(403);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/execution-workspaces");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithWorkspaces(["a-only"]);
    const companyB = await seedCompanyWithWorkspaces(["b-only-1", "b-only-2"]);
    const app = createApp([companyA.companyId, companyB.companyId]);

    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA.companyId}/execution-workspaces`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].name).toBe("a-only");

      const resB = await request(app).get(`/api/companies/${companyB.companyId}/execution-workspaces`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((ws: { companyId: string }) => ws.companyId === companyB.companyId)).toBe(true);
    }
  });
});
