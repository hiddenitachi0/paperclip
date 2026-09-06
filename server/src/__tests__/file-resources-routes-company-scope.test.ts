import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, goals, issues, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let fileResourceRoutes: typeof import("../routes/file-resources.js").fileResourceRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres file-resources company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373: file-resources.test.ts already exercises fileResourceRoutes
// extensively against a real embedded Postgres instance -- per-issue
// project/execution workspace resolution, explicit cross-company denial
// (403 cross_company_workspace / assertCompanyAccess), path-traversal and
// symlink guards, rate limiting, and activity-log audit trails. What that
// file does not cover is the specific claim-bleed shape this suite targets:
// repeated *sequential* requests for two different companies' issues over
// the same Express app / pooled db connection, to prove runInCompanyScope's
// session claim never leaks company A's workspace listing into company B's
// response (or vice versa) across connection reuse -- matching the pattern
// in secrets-routes-company-scope.test.ts (DUR-348).
describeEmbeddedPostgres("fileResourceRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-resources-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/file-resources.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/file-resources.js")>("../routes/file-resources.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    fileResourceRoutes = routes.fileResourceRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!fileResourceRoutes || !errorHandler) {
      throw new Error("file-resources route test dependencies were not loaded");
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
    app.use("/api", fileResourceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWorkspace(markerFileName: string, markerContents: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-resources-company-scope-"));
    await fs.writeFile(path.join(root, markerFileName), markerContents, "utf8");

    const companyId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Goal",
      level: "company",
      status: "active",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: root,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      projectWorkspaceId,
      title: "Read workspace files",
      status: "todo",
      priority: "medium",
    });

    return { companyId, issueId, root };
  }

  it("returns only the requesting issue's own company workspace files over a real HTTP request through the scope middleware", async () => {
    const companyA = await seedCompanyWorkspace("company-a-only.txt", "company A secret\n");
    const app = createApp([companyA.companyId]);

    const res = await request(app)
      .get(`/api/issues/${companyA.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all" });

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual([
      "company-a-only.txt",
    ]);
  });

  it("never bleeds one company's session claim into the next request's workspace listing, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWorkspace("company-a-only.txt", "company A secret\n");
    const companyB = await seedCompanyWorkspace("company-b-only.txt", "company B secret\n");
    const app = createApp([companyA.companyId, companyB.companyId]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app)
        .get(`/api/issues/${companyA.issueId}/file-resources/list`)
        .query({ workspace: "project", mode: "all" });
      expect(resA.status).toBe(200);
      expect(resA.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual([
        "company-a-only.txt",
      ]);
      expect(JSON.stringify(resA.body)).not.toContain(companyB.root);

      const resB = await request(app)
        .get(`/api/issues/${companyB.issueId}/file-resources/list`)
        .query({ workspace: "project", mode: "all" });
      expect(resB.status).toBe(200);
      expect(resB.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual([
        "company-b-only.txt",
      ]);
      expect(JSON.stringify(resB.body)).not.toContain(companyA.root);
    }
  });
});
