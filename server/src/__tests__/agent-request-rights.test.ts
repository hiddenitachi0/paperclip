// Per-agent "ask" switches (deploys:request / merges:request), against a real
// database: who may change them, what they write, what they leave alone, how
// they sit next to a position, and that the grant really is what lets an
// agent file a deploy card.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { agentRequestRightsService } from "../services/agent-request-rights.js";
import { agentRequestRightsRoutes } from "../routes/agent-request-rights.js";
import { agentRoleRoutes } from "../routes/agent-roles.js";
import { assignRoleToAgent, createRole, resolveAgentRoleProvisioning } from "../services/agent-roles.js";
import { accessService } from "../services/access.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent request-rights tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Role = "owner" | "admin" | "operator" | "viewer";

describeEmbeddedPostgres("per-agent ask rights (deploy / merge approval cards)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-request-rights-");
    db = createDb(tempDb.connectionString);
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
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Web Administrator",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { mcpServers: [] },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    return agentId;
  }

  async function grantRow(companyId: string, agentId: string, permissionKey: string, grantedByUserId: string | null = null) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      scope: null,
      grantedByUserId,
    });
  }

  async function agentGrants(agentId: string) {
    const rows = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, agentId)));
    return new Map(rows.map((row) => [row.permissionKey, row]));
  }

  function boardActor(companyId: string, role: Role) {
    return {
      type: "board",
      source: "session",
      userId: `user-${role}`,
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_jwt", runId: null };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRequestRightsRoutes(db));
    app.use("/api", agentRoleRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function canAskForDeploy(companyId: string, agentId: string) {
    const decision = await accessService(db).decide({
      actor: agentActor(companyId, agentId) as any,
      action: "deploys:request",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  describe("who may change it", () => {
    it.each(["owner", "admin"] as const)("lets the company %s switch both rights on", async (role) => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(boardActor(companyId, role)))
        .put(`/api/agents/${agentId}/request-rights`)
        .send({ deploysRequest: true, mergesRequest: true });

      expect(res.status).toBe(200);
      expect(res.body.deploysRequest).toMatchObject({ enabled: true, source: "agent" });
      expect(res.body.mergesRequest).toMatchObject({ enabled: true, source: "agent" });
      const grants = await agentGrants(agentId);
      expect(grants.get("deploys:request")?.grantedByUserId).toBe(`user-${role}`);
      expect(grants.get("merges:request")?.grantedByUserId).toBe(`user-${role}`);
    });

    it.each(["operator", "viewer"] as const)("refuses a company %s, and writes nothing", async (role) => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(boardActor(companyId, role)))
        .put(`/api/agents/${agentId}/request-rights`)
        .send({ deploysRequest: true });

      expect(res.status).toBe(403);
      expect((await agentGrants(agentId)).size).toBe(0);
    });

    it("lets an operator see the switches, but marks them as not changeable", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(boardActor(companyId, "operator"))).get(`/api/agents/${agentId}/request-rights`);

      expect(res.status).toBe(200);
      expect(res.body.canChange).toBe(false);
      expect(res.body.deploysRequest.enabled).toBe(false);
    });

    it("refuses an agent, even on itself, on both reading and changing", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const app = createApp(agentActor(companyId, agentId));

      const put = await request(app).put(`/api/agents/${agentId}/request-rights`).send({ deploysRequest: true });
      const get = await request(app).get(`/api/agents/${agentId}/request-rights`);

      expect(put.status).toBe(403);
      expect(put.body.error).toContain("Agents cannot");
      expect(get.status).toBe(403);
      expect((await agentGrants(agentId)).size).toBe(0);
      expect(await canAskForDeploy(companyId, agentId)).toBe(false);
    });

    it("refuses an agent holding the right to manage other agents' permissions too", async () => {
      const companyId = await seedCompany();
      const targetId = await seedAgent(companyId);
      const bossId = await seedAgent(companyId);
      await db.update(agents).set({ permissions: { canManageOtherAgentsPermissions: true, canCreateAgents: true } }).where(eq(agents.id, bossId));
      await grantRow(companyId, bossId, "agents:create");

      const res = await request(createApp(agentActor(companyId, bossId)))
        .put(`/api/agents/${targetId}/request-rights`)
        .send({ deploysRequest: true });

      expect(res.status).toBe(403);
      expect((await agentGrants(targetId)).size).toBe(0);
    });

    it("refuses the owner of another company (company scoping)", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const agentInB = await seedAgent(companyB);

      const res = await request(createApp(boardActor(companyA, "owner")))
        .put(`/api/agents/${agentInB}/request-rights`)
        .send({ deploysRequest: true });

      expect(res.status).toBe(403);
      expect((await agentGrants(agentInB)).size).toBe(0);
    });

    it("refuses an operator adding the deploy ask-right through the generic rights override instead", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const res = await request(createApp(boardActor(companyId, "operator")))
        .post(`/api/agents/${agentId}/role/rights`)
        .send({ permissionKey: "deploys:request", scope: null });

      expect(res.status).toBe(403);
      expect((await agentGrants(agentId)).has("deploys:request")).toBe(false);
    });

    it("rejects a body with neither switch, or with other keys", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const app = createApp(boardActor(companyId, "owner"));

      expect((await request(app).put(`/api/agents/${agentId}/request-rights`).send({})).status).toBe(400);
      expect(
        (await request(app).put(`/api/agents/${agentId}/request-rights`).send({ deploysRequest: true, approve: true })).status,
      ).toBe(400);
      expect((await agentGrants(agentId)).size).toBe(0);
    });
  });

  describe("what it writes", () => {
    it("grants and revokes only the asked-for row, keeps other grants, and logs each change", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await grantRow(companyId, agentId, "tasks:assign", "earlier-user");
      await grantRow(companyId, agentId, "merges:request", "earlier-user");
      const app = createApp(boardActor(companyId, "owner"));

      expect(await canAskForDeploy(companyId, agentId)).toBe(false);

      const on = await request(app).put(`/api/agents/${agentId}/request-rights`).send({ deploysRequest: true });
      expect(on.status).toBe(200);
      expect(on.body.changes).toEqual([{ permissionKey: "deploys:request", from: false, to: true }]);
      let grants = await agentGrants(agentId);
      expect([...grants.keys()].sort()).toEqual(["deploys:request", "merges:request", "tasks:assign"]);
      expect(grants.get("merges:request")?.grantedByUserId).toBe("earlier-user");
      expect(grants.get("tasks:assign")?.grantedByUserId).toBe("earlier-user");
      expect(await canAskForDeploy(companyId, agentId)).toBe(true);

      // Same answer again: nothing changes, nothing is logged.
      const again = await request(app).put(`/api/agents/${agentId}/request-rights`).send({ deploysRequest: true });
      expect(again.body.changes).toEqual([]);

      const off = await request(app).put(`/api/agents/${agentId}/request-rights`).send({ deploysRequest: false });
      expect(off.status).toBe(200);
      grants = await agentGrants(agentId);
      expect([...grants.keys()].sort()).toEqual(["merges:request", "tasks:assign"]);
      expect(await canAskForDeploy(companyId, agentId)).toBe(false);

      const logs = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.request_rights_updated")));
      expect(logs).toHaveLength(2);
      const details = logs.map((row) => row.details as Record<string, any>);
      expect(details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            changes: [{ permissionKey: "deploys:request", from: false, to: true }],
            _previous: { deploysRequest: false, mergesRequest: true },
          }),
          expect.objectContaining({ changes: [{ permissionKey: "deploys:request", from: true, to: false }] }),
        ]),
      );
      expect(logs.every((row) => row.actorType === "user" && row.actorId === "user-owner")).toBe(true);
    });
  });

  describe("next to a position", () => {
    it("shows a right that came with the position, and switching it off here sticks through reconciliation", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const boss = await createRole(db, companyId, {
        name: "Boss",
        defaultGrants: [
          { permissionKey: "deploys:request", scope: null },
          { permissionKey: "merges:request", scope: null },
        ],
      });
      await assignRoleToAgent(db, agentId, boss.id, { actor: { type: "board" } });
      const svc = agentRequestRightsService(db);

      let state = await svc.get(agentId);
      expect(state.position?.name).toBe("Boss");
      expect(state.deploysRequest).toMatchObject({ enabled: true, source: "position", positionGivesIt: true });

      await svc.set(agentId, { deploysRequest: false }, "user-owner");
      await resolveAgentRoleProvisioning(db, agentId);
      state = await svc.get(agentId);
      expect(state.deploysRequest).toMatchObject({ enabled: false, source: "turned_off" });
      expect(state.mergesRequest).toMatchObject({ enabled: true, source: "position" });
      expect(await canAskForDeploy(companyId, agentId)).toBe(false);

      // Re-assigning the position does not quietly hand it back either.
      await assignRoleToAgent(db, agentId, boss.id, { actor: { type: "board" } });
      expect((await svc.get(agentId)).deploysRequest.enabled).toBe(false);

      await svc.set(agentId, { deploysRequest: true }, "user-owner");
      await resolveAgentRoleProvisioning(db, agentId);
      state = await svc.get(agentId);
      expect(state.deploysRequest).toMatchObject({ enabled: true, source: "position" });
    });

    it("keeps a right switched on here when the agent later gets, changes and loses a position", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const boss = await createRole(db, companyId, {
        name: "Boss",
        defaultGrants: [{ permissionKey: "deploys:request", scope: null }],
      });
      const developer = await createRole(db, companyId, {
        name: "Developer",
        defaultGrants: [{ permissionKey: "merges:request", scope: null }],
      });
      const svc = agentRequestRightsService(db);

      await svc.set(agentId, { deploysRequest: true }, "user-owner");
      await assignRoleToAgent(db, agentId, boss.id, { actor: { type: "board" } });
      await assignRoleToAgent(db, agentId, developer.id, { actor: { type: "board" } });
      expect((await svc.get(agentId)).deploysRequest).toMatchObject({ enabled: true, source: "agent" });
      await assignRoleToAgent(db, agentId, null, { actor: { type: "board" } });
      expect((await svc.get(agentId)).deploysRequest).toMatchObject({ enabled: true, source: "agent" });
      expect(await canAskForDeploy(companyId, agentId)).toBe(true);
    });
  });
});
