// DUR-114: role-assignment fields (roleId, roleAssignedAt,
// roleAppliedMcpServerNames, roleAppliedPermissionKeys, and — DUR-149 —
// roleOverrides/roleProvisioned*/roleResolvedAt) must only ever be
// writable through assignRoleToAgent (server/src/services/agent-roles.ts),
// which updates the agents row directly via db.update(agents) and never
// calls agentService.create/.update.
//
// The PATCH /agents/:id route already 422s a raw roleId field, but that is
// a route-level check only. Company import (company-portability.ts) writes
// agent fields straight through agentService.create/.update, bypassing the
// route guard entirely — so the restriction has to be enforced in the
// service layer too (the DUR-56 bypass pattern) or any future caller of
// these generic functions could silently reassign roles.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service role-guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService role-assignment field guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
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

  it("rejects roleId on agentService.create, mirroring the import bypass path", async () => {
    const companyId = await seedCompany();
    const roleId = randomUUID();

    await expect(
      agentService(db).create(companyId, {
        name: "Imported Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        roleId,
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(0);
  });

  it("rejects role-snapshot fields on agentService.update", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Existing Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(
      agentService(db).update(agentId, {
        roleAppliedMcpServerNames: ["github-mcp"],
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      agentService(db).update(agentId, {
        roleAppliedPermissionKeys: ["tasks:assign"],
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      agentService(db).update(agentId, {
        roleAssignedAt: new Date(),
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      agentService(db).update(agentId, {
        roleOverrides: { rights: { add: [{ permissionKey: "deploys:request", scope: null }] } },
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      agentService(db).update(agentId, {
        roleProvisionedPermissionKeys: ["deploys:request"],
      } as never),
    ).rejects.toMatchObject({ status: 422 });

    const [row] = await db.select().from(agents);
    expect(row).toMatchObject({
      id: agentId,
      roleId: null,
      roleAppliedMcpServerNames: [],
      roleAppliedPermissionKeys: [],
    });
  });
});
