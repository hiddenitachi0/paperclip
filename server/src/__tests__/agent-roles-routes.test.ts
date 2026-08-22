import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyAgentRoles,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoleService } from "../services/agent-roles.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent role route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent role routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-role-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    return agentService(db).create(companyId, {
      name: "Backend Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    } as Parameters<ReturnType<typeof agentService>["create"]>[1]);
  }

  async function createApp(actor: Record<string, unknown>) {
    const [{ errorHandler }, { agentRoleRoutes }, { agentRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/agent-roles.js"),
      import("../routes/agents.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoleRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("blocks an agent-authenticated actor from assigning a role to itself", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const roles = agentRoleService(db);
    const role = await roles.create(companyId, { name: "Tech Developer" });

    const app = await createApp({
      type: "agent",
      agentId: agent.id,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/role`)
      .send({ roleId: role.id });

    expect(res.status).toBe(403);
    const refreshed = await agentService(db).getById(agent.id);
    expect(refreshed!.roleId).toBeNull();
  }, 20_000);

  it("blocks an agent-authenticated actor from assigning a role to another agent", async () => {
    const companyId = await seedCompany();
    const selfAgent = await seedAgent(companyId);
    const otherAgent = await seedAgent(companyId);
    const roles = agentRoleService(db);
    const role = await roles.create(companyId, { name: "Tech Developer" });

    const app = await createApp({
      type: "agent",
      agentId: selfAgent.id,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/agents/${otherAgent.id}/role`)
      .send({ roleId: role.id });

    expect(res.status).toBe(403);
  });

  it("allows a board actor to assign a role", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const roles = agentRoleService(db);
    const role = await roles.create(companyId, { name: "Tech Developer" });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agent.id}/role`)
      .send({ roleId: role.id });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agent.roleId).toBe(role.id);
  });

  it("rejects role definition CRUD from an agent-authenticated actor", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);

    const app = await createApp({
      type: "agent",
      agentId: agent.id,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-roles`)
      .send({ name: "Backdoor Role" });

    expect(res.status).toBe(403);
  });

  it("422s a PATCH /agents/:id that tries to set roleId directly instead of using the dedicated route", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ roleId: randomUUID() });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("/agents/:id/role");
    const refreshed = await agentService(db).getById(agent.id);
    expect(refreshed!.roleId).toBeNull();
  });
});
