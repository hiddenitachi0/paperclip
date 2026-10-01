/**
 * DUR-4182: `/jobs/:id/run` must gate on the *target* (`runAgentId`) holding
 * a position linked to the job, not the caller. The route previously OR'd in
 * "caller holds any linked position", which let any agent holding some
 * linked position direct the created task -- title/instructions, model
 * profile and effort all included -- onto an unrelated agent who never
 * qualified for the job. See server/src/routes/jobs.ts for the fix.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyAgentRoles, createDb, issues, jobPositions, jobRuns, jobs, jobTriggers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let jobRoutes: typeof import("../routes/jobs.js").jobRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres jobs run-authz route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /jobs/:id/run position authz (DUR-4182)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-jobs-run-authz-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/jobs.js");
    vi.doUnmock("../middleware/index.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/jobs.js")>("../routes/jobs.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    jobRoutes = routes.jobRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(jobRuns);
    await db.delete(jobTriggers);
    await db.delete(jobPositions);
    await db.delete(jobs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    if (!jobRoutes || !errorHandler) {
      throw new Error("job route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", jobRoutes(db, { heartbeat: { wakeup: async () => null } }));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const linkedPositionId = randomUUID();
    const unrelatedPositionId = randomUUID();
    await db.insert(companyAgentRoles).values([
      { id: linkedPositionId, companyId, name: "Legal Advisor", key: "legal-advisor", isBuiltin: true },
      { id: unrelatedPositionId, companyId, name: "Researcher", key: "researcher", isBuiltin: true },
    ]);

    // Holds the position linked to the job -- a legitimate run target.
    const holderAgentId = randomUUID();
    // Holds a *different*, unlinked position -- never a legitimate run target.
    const outsiderAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: holderAgentId,
        companyId,
        name: "Legal Advisor Agent",
        role: "legal_advisor",
        roleId: linkedPositionId,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: outsiderAgentId,
        companyId,
        name: "Researcher Agent",
        role: "researcher",
        roleId: unrelatedPositionId,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      companyId,
      title: "Revise contract",
      instructions: "Revise the contract.",
      status: "active",
      variables: [],
      runMode: "full_agent",
      requiresApproval: false,
    });
    await db.insert(jobPositions).values({ id: randomUUID(), companyId, jobId, positionId: linkedPositionId });

    return { companyId, jobId, holderAgentId, outsiderAgentId, linkedPositionId, unrelatedPositionId };
  }

  it("rejects a run where the position-holding caller names an unrelated target agent", async () => {
    const { companyId, jobId, holderAgentId, outsiderAgentId } = await seed();
    const app = createApp({ type: "agent", agentId: holderAgentId, companyId });

    // holderAgentId (caller) holds the job's linked position; outsiderAgentId
    // (target) does not. Directing the task onto the outsider must be refused
    // even though the caller qualifies -- the position check is about who the
    // task lands on, not who is asking.
    const res = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .send({ runAgentId: outsiderAgentId, source: "manual" });

    expect(res.status).toBe(403);
  });

  it("allows a non-holding caller to start the job on a colleague who holds the position (Telegram-bridge case)", async () => {
    const { companyId, jobId, holderAgentId, outsiderAgentId } = await seed();
    const app = createApp({ type: "agent", agentId: outsiderAgentId, companyId });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .send({ runAgentId: holderAgentId, source: "telegram" });

    expect(res.status).toBe(202);
    expect(res.body.runAgentId).toBe(holderAgentId);
  });

  it("allows a position holder to self-run the job", async () => {
    const { companyId, jobId, holderAgentId } = await seed();
    const app = createApp({ type: "agent", agentId: holderAgentId, companyId });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .send({ runAgentId: holderAgentId, source: "manual" });

    expect(res.status).toBe(202);
  });

  it("lets a board actor run the job on any agent regardless of position", async () => {
    const { companyId, jobId, outsiderAgentId } = await seed();
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .send({ runAgentId: outsiderAgentId, source: "manual" });

    expect(res.status).toBe(202);
  });
});
