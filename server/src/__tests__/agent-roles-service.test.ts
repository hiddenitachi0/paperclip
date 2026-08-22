import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyAgentRoles,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { agentRolePermissionGrantSchema, PERMISSION_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoleService } from "../services/agent-roles.js";
import { agentService } from "../services/agents.ts";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent role tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent role assignment", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-roles");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
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

  async function seedAgent(companyId: string, overrides: Record<string, unknown> = {}) {
    return agentService(db).create(companyId, {
      name: "Backend Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      ...overrides,
    } as Parameters<ReturnType<typeof agentService>["create"]>[1]);
  }

  it("derives a unique slug key from the role name, never entered by the caller", async () => {
    const companyId = await seedCompany();
    const roles = agentRoleService(db);

    const first = await roles.create(companyId, { name: "Tech Developer" });
    const second = await roles.create(companyId, { name: "Tech Developer" });

    expect(first.key).toBe("tech-developer");
    expect(second.key).toBe("tech-developer-2");
  });

  it("applies a role's three defaults to an agent exactly once at assignment time", async () => {
    const companyId = await seedCompany();
    const roles = agentRoleService(db);
    const access = accessService(db);
    const agent = await seedAgent(companyId);

    const role = await roles.create(companyId, {
      name: "Customer Support Rep",
      defaultInstructions: "You help customers with billing questions.",
      defaultMcpServers: [{ name: "zendesk", command: "zendesk-mcp" }],
      defaultPermissionGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });

    const { agent: updated, warnings } = await roles.assign(companyId, agent.id, role.id, { userId: "board-user" });

    expect(warnings).toEqual([]);
    expect(updated.roleId).toBe(role.id);
    expect(updated.roleAssignedAt).toBeInstanceOf(Date);
    expect((updated.adapterConfig as { mcpServers?: Array<{ name: string }> }).mcpServers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "zendesk" })]));

    const grants = await access.listPrincipalGrants(companyId, "agent", agent.id);
    expect(grants.map((grant) => grant.permissionKey)).toContain("tasks:assign");
  });

  it("does not re-apply role defaults when the role definition changes after assignment (apply once, no reconciliation)", async () => {
    const companyId = await seedCompany();
    const roles = agentRoleService(db);
    const agent = await seedAgent(companyId);

    const role = await roles.create(companyId, {
      name: "Tech Developer",
      defaultMcpServers: [{ name: "github", command: "github-mcp" }],
    });
    await roles.assign(companyId, agent.id, role.id, { userId: "board-user" });

    await roles.update(companyId, role.id, {
      defaultMcpServers: [{ name: "github", command: "github-mcp" }, { name: "linear", command: "linear-mcp" }],
    });

    const refreshed = await agentService(db).getById(agent.id);
    const serverNames = ((refreshed!.adapterConfig as { mcpServers?: Array<{ name: string }> }).mcpServers ?? [])
      .map((server) => server.name);
    expect(serverNames).toEqual(["github"]);
    expect(serverNames).not.toContain("linear");
  });

  it("renders an agent-specific change as an override against what the role applied", async () => {
    const companyId = await seedCompany();
    const roles = agentRoleService(db);
    const access = accessService(db);
    const agentsSvc = agentService(db);
    const agent = await seedAgent(companyId);

    const role = await roles.create(companyId, {
      name: "Tech Developer",
      defaultMcpServers: [{ name: "github", command: "github-mcp" }],
      defaultPermissionGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });
    await roles.assign(companyId, agent.id, role.id, { userId: "board-user" });

    const zeroDiff = await roles.getOverrides(companyId, agent.id);
    expect(zeroDiff.tools).toEqual({ added: [], removed: [] });
    expect(zeroDiff.rights).toEqual({ added: [], removed: [] });

    await agentsSvc.update(agent.id, { adapterConfig: { mcpServers: [{ name: "linear", command: "linear-mcp" }] } });
    await access.setPrincipalPermission(companyId, "agent", agent.id, "skills:create", true, "board-user");
    await access.setPrincipalPermission(companyId, "agent", agent.id, "tasks:assign", false, "board-user");

    const diff = await roles.getOverrides(companyId, agent.id);
    expect(diff.tools.added).toEqual(["linear"]);
    expect(diff.tools.removed).toEqual(["github"]);
    expect(diff.rights.added).toEqual(["skills:create"]);
    expect(diff.rights.removed).toEqual(["tasks:assign"]);
  });

  it("unassigning a role clears roleId without reverting previously-applied grants or tools", async () => {
    const companyId = await seedCompany();
    const roles = agentRoleService(db);
    const access = accessService(db);
    const agent = await seedAgent(companyId);

    const role = await roles.create(companyId, {
      name: "Tech Developer",
      defaultPermissionGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });
    await roles.assign(companyId, agent.id, role.id, { userId: "board-user" });
    const { agent: unassigned } = await roles.assign(companyId, agent.id, null, { userId: "board-user" });

    expect(unassigned.roleId).toBeNull();
    const grants = await access.listPrincipalGrants(companyId, "agent", agent.id);
    expect(grants.map((grant) => grant.permissionKey)).toContain("tasks:assign");
  });

  it("rejects assigning a role belonging to a different company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const roles = agentRoleService(db);
    const agent = await seedAgent(companyId);
    const foreignRole = await roles.create(otherCompanyId, { name: "Tech Developer" });

    await expect(roles.assign(companyId, agent.id, foreignRole.id, { userId: "board-user" }))
      .rejects.toThrow(/not found/i);
  });

  it("duplicates a role into a different company as an independent copy", async () => {
    const companyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const roles = agentRoleService(db);

    const source = await roles.create(companyId, {
      name: "Tech Developer",
      defaultMcpServers: [{ name: "github", command: "github-mcp" }],
    });
    const copy = await roles.duplicateToCompany(companyId, source.id, targetCompanyId);

    expect(copy.id).not.toBe(source.id);
    expect(copy.companyId).toBe(targetCompanyId);
    expect(copy.name).toBe(source.name);
    expect(copy.defaultMcpServers).toEqual(source.defaultMcpServers);

    await roles.update(companyId, source.id, { name: "Renamed" });
    const untouchedCopy = await roles.getById(targetCompanyId, copy.id);
    expect(untouchedCopy!.name).toBe("Tech Developer");
  });

  it("rejects setting roleId through the general agent update/create service functions (company import bypass guard)", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const svc = agentService(db);

    await expect(svc.update(agent.id, { roleId: randomUUID() } as never)).rejects.toThrow(/POST \/agents\/:id\/role/);
    await expect(svc.create(companyId, {
      name: "Sneaky",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      roleId: randomUUID(),
    } as never)).rejects.toThrow(/POST \/agents\/:id\/role/);
  });

  it("never allows a role's permission grants to include a deploy/merge-approval permission key", () => {
    expect(PERMISSION_KEYS).not.toContain("deploys:approve");
    expect(PERMISSION_KEYS).not.toContain("merges:approve");
    const result = agentRolePermissionGrantSchema.safeParse({ permissionKey: "deploys:approve", scope: null });
    expect(result.success).toBe(false);
  });
});
