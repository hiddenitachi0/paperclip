// DUR-147: assignRoleToAgent's "apply once" model correctly revoked a
// role's grants/tools when the role was explicitly cleared (roleId: null),
// but switching an agent directly from job X to job Y left job X's
// job-owned grants and MCP servers in place forever if job Y didn't also
// carry them — the acceptance criterion ("job switch" reconciliation)
// never actually held. This exercises the real service against a real DB,
// covering the three required properties in one flow: add, remove (via
// switch), and operator grants surviving the switch.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyAgentRoles, createDb, principalPermissionGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assignRoleToAgent, createRole } from "../services/agent-roles.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-roles switch-reconciliation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("assignRoleToAgent — job switch reconciliation (DUR-147)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-switch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Switchable Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { mcpServers: [] },
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("revokes the old job's grants/tools on switch, adds the new job's, and leaves an operator grant/tool untouched", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const jobX = await createRole(db, companyId, {
      name: "Job X",
      defaultMcpServers: [{ name: "job-x-tool", command: "job-x", transport: "stdio" }],
      defaultGrants: [
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "pipelines:write", scope: null },
      ],
    });
    const jobY = await createRole(db, companyId, {
      name: "Job Y",
      defaultMcpServers: [{ name: "job-y-tool", command: "job-y", transport: "stdio" }],
      defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });

    await assignRoleToAgent(db, agentId, jobX.id, {});

    // Operator adds a grant and a tool that are NOT part of either job's
    // defaults, after Job X was assigned.
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "skills:create",
      scope: null,
      grantedByUserId: "operator-user",
    });
    const [afterJobX] = await db.select().from(agents).where(eq(agents.id, agentId));
    await db
      .update(agents)
      .set({
        adapterConfig: {
          ...(afterJobX!.adapterConfig as Record<string, unknown>),
          mcpServers: [
            ...((afterJobX!.adapterConfig as { mcpServers: unknown[] }).mcpServers ?? []),
            { name: "operator-tool", command: "operator", transport: "stdio" },
          ],
        },
      })
      .where(eq(agents.id, agentId));

    // Switch the agent from Job X to Job Y.
    await assignRoleToAgent(db, agentId, jobY.id, {});

    const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(updated!.roleId).toBe(jobY.id);

    const mcpNames = (
      (updated!.adapterConfig as { mcpServers: Array<{ name: string }> }).mcpServers ?? []
    ).map((s) => s.name);
    // Job X's tool is gone, Job Y's tool is present, the operator's tool survives.
    expect(mcpNames.sort()).toEqual(["job-y-tool", "operator-tool"].sort());

    const grants = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    const grantKeys = grants.map((g) => g.permissionKey).sort();
    // pipelines:write (Job X-only) is revoked; tasks:assign (in both) and
    // skills:create (operator-granted, never part of a role snapshot) survive.
    expect(grantKeys).toEqual(["skills:create", "tasks:assign"].sort());
  });

  it("does not attempt to revoke anything on first assignment (no previous role)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const job = await createRole(db, companyId, {
      name: "First Job",
      defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });

    await assignRoleToAgent(db, agentId, job.id, {});

    const grants = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    expect(grants.map((g) => g.permissionKey)).toEqual(["tasks:assign"]);
  });
});
