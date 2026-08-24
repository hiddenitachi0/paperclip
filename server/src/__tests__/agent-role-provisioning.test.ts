// DUR-149 (DUR-146 Stage 1 backend): resolveAgentRoleProvisioning resolves
// the effective skill_keys/connector_keys/rights set from three provenance
// buckets — job-owned, operator-granted (agent.roleOverrides.*.add, never
// touched by reconciliation), and migration-backfilled (stored the same way
// job-owned entries are, so a later reconciliation pass CAN drop them).
// Effective = (job ∪ add) − remove. These tests exercise the real service
// against a real DB, the same way DUR-147's switch-reconciliation tests do.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyAgentRoles, createDb, principalPermissionGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  addAgentCatalogOverride,
  addAgentRightOverride,
  assignRoleToAgent,
  createRole,
  removeAgentCatalogOverride,
  removeAgentRightOverride,
  resolveAgentRoleProvisioning,
} from "../services/agent-roles.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres role-provisioning tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resolveAgentRoleProvisioning (DUR-149)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-role-provisioning-");
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
      name: "Provisioned Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { mcpServers: [] },
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function grantKeysOf(agentId: string) {
    const rows = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId));
    return rows.map((r) => r.permissionKey).sort();
  }

  it("resolves job-owned skills/connectors/rights and writes the provenance snapshot", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const job = await createRole(db, companyId, {
      name: "Support Rep",
      skillKeys: ["customer-inbox"],
      connectorKeys: ["zendesk"],
      defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });

    await assignRoleToAgent(db, agentId, job.id, { actor: { type: "board" } });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.roleProvisionedSkillKeys).toEqual(["customer-inbox"]);
    expect(agent!.roleProvisionedConnectorKeys).toEqual(["zendesk"]);
    expect(agent!.roleProvisionedPermissionKeys).toEqual(["tasks:assign"]);
    expect(agent!.roleResolvedAt).not.toBeNull();
    expect(await grantKeysOf(agentId)).toEqual(["tasks:assign"]);
  });

  it("keeps an operator-granted right through a job switch that doesn't carry it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const jobX = await createRole(db, companyId, { name: "Job X", defaultGrants: [{ permissionKey: "tasks:assign", scope: null }] });
    const jobY = await createRole(db, companyId, { name: "Job Y", defaultGrants: [{ permissionKey: "tasks:assign", scope: null }] });

    await assignRoleToAgent(db, agentId, jobX.id, { actor: { type: "board" } });
    await addAgentRightOverride(db, agentId, { permissionKey: "skills:create", scope: null }, { type: "board" });

    await assignRoleToAgent(db, agentId, jobY.id, { actor: { type: "board" } });

    expect(await grantKeysOf(agentId)).toEqual(["skills:create", "tasks:assign"]);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent!.roleProvisionedPermissionKeys as string[]).sort()).toEqual(["skills:create", "tasks:assign"]);
  });

  it("an operator-removed right stays revoked even though the job grants it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const job = await createRole(db, companyId, {
      name: "Job",
      defaultGrants: [
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "pipelines:write", scope: null },
      ],
    });

    await assignRoleToAgent(db, agentId, job.id, { actor: { type: "board" } });
    expect(await grantKeysOf(agentId)).toEqual(["pipelines:write", "tasks:assign"]);

    await removeAgentRightOverride(db, agentId, "pipelines:write", { type: "board" });
    expect(await grantKeysOf(agentId)).toEqual(["tasks:assign"]);

    // Re-resolving (e.g. a later reconciliation pass) must not re-grant it —
    // the operator's remove is sticky, not a one-time diff.
    await resolveAgentRoleProvisioning(db, agentId);
    expect(await grantKeysOf(agentId)).toEqual(["tasks:assign"]);
  });

  it("treats a migration-backfilled grant as job-owned — reconciled away once a job stops carrying it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // Simulate what backfillDeployMergeRequestGrants does: grant directly and
    // seed the provenance column, with no role assigned yet.
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "merges:request",
      scope: null,
      grantedByUserId: null,
    });
    await db.update(agents).set({ roleProvisionedPermissionKeys: ["merges:request"] }).where(eq(agents.id, agentId));

    const jobWithoutIt = await createRole(db, companyId, {
      name: "No Merge Rights",
      defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
    });
    await assignRoleToAgent(db, agentId, jobWithoutIt.id, { actor: { type: "board" } });

    // The backfilled grant was never protected by roleOverrides.rights.add,
    // so it's reconciled away exactly like a stale job-owned grant would be.
    expect(await grantKeysOf(agentId)).toEqual(["tasks:assign"]);
  });

  it("adds and removes a skill_key / connector_key override independently of the job", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const job = await createRole(db, companyId, { name: "Job", skillKeys: ["base-skill"] });
    await assignRoleToAgent(db, agentId, job.id, { actor: { type: "board" } });

    await addAgentCatalogOverride(db, agentId, "connectors", "extra-connector", { type: "board" });
    let [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent!.roleProvisionedSkillKeys as string[])).toEqual(["base-skill"]);
    expect((agent!.roleProvisionedConnectorKeys as string[])).toEqual(["extra-connector"]);

    await removeAgentCatalogOverride(db, agentId, "skills", "base-skill", { type: "board" });
    [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent!.roleProvisionedSkillKeys as string[])).toEqual([]);
    expect((agent!.roleProvisionedConnectorKeys as string[])).toEqual(["extra-connector"]);

    // The removed skill_key stays removed even after a plain re-resolve.
    await resolveAgentRoleProvisioning(db, agentId);
    [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent!.roleProvisionedSkillKeys as string[])).toEqual([]);
  });
});
