import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyAgentRoles } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type { CreateAgentRole, McpServerConfig, UpdateAgentRole } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { accessService } from "./access.js";
import { agentInstructionsService } from "./agent-instructions.js";

type PermissionGrant = { permissionKey: string; scope: Record<string, unknown> | null };
type AgentRoleRow = typeof companyAgentRoles.$inferSelect;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveUniqueRoleKey(name: string, existingKeys: Set<string>): string {
  const base = normalizeAgentUrlKey(name) ?? "role";
  if (!existingKeys.has(base)) return base;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function agentRoleService(db: Db) {
  const agentsSvc = agentService(db);
  const access = accessService(db);
  const instructions = agentInstructionsService();

  async function list(companyId: string): Promise<AgentRoleRow[]> {
    return db
      .select()
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.companyId, companyId))
      .orderBy(companyAgentRoles.name);
  }

  async function getById(companyId: string, id: string): Promise<AgentRoleRow | null> {
    return db
      .select()
      .from(companyAgentRoles)
      .where(and(eq(companyAgentRoles.id, id), eq(companyAgentRoles.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function existingKeys(companyId: string): Promise<Set<string>> {
    const rows = await db
      .select({ key: companyAgentRoles.key })
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.companyId, companyId));
    return new Set(rows.map((row) => row.key));
  }

  async function create(companyId: string, data: CreateAgentRole): Promise<AgentRoleRow> {
    const keys = await existingKeys(companyId);
    const key = deriveUniqueRoleKey(data.name, keys);
    const [created] = await db
      .insert(companyAgentRoles)
      .values({
        companyId,
        name: data.name,
        key,
        description: data.description ?? null,
        defaultInstructions: data.defaultInstructions ?? null,
        defaultMcpServers: data.defaultMcpServers ?? [],
        defaultPermissionGrants: data.defaultPermissionGrants ?? [],
      })
      .returning();
    return created!;
  }

  async function update(companyId: string, id: string, data: UpdateAgentRole): Promise<AgentRoleRow> {
    const existing = await getById(companyId, id);
    if (!existing) throw notFound("Role not found");

    const patch: Partial<typeof companyAgentRoles.$inferInsert> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description ?? null;
    if (data.defaultInstructions !== undefined) patch.defaultInstructions = data.defaultInstructions ?? null;
    if (data.defaultMcpServers !== undefined) patch.defaultMcpServers = data.defaultMcpServers;
    if (data.defaultPermissionGrants !== undefined) patch.defaultPermissionGrants = data.defaultPermissionGrants;

    const [updated] = await db
      .update(companyAgentRoles)
      .set(patch)
      .where(eq(companyAgentRoles.id, id))
      .returning();
    return updated!;
  }

  async function remove(companyId: string, id: string): Promise<void> {
    const existing = await getById(companyId, id);
    if (!existing) throw notFound("Role not found");
    // agents.role_id is ON DELETE SET NULL -- deleting a role unassigns it
    // from every agent that held it without touching those agent rows or
    // the role_applied_* snapshots already written to them.
    await db.delete(companyAgentRoles).where(eq(companyAgentRoles.id, id));
  }

  async function duplicateToCompany(companyId: string, id: string, targetCompanyId: string): Promise<AgentRoleRow> {
    const source = await getById(companyId, id);
    if (!source) throw notFound("Role not found");
    if (targetCompanyId === companyId) {
      throw conflict("Duplicate a role into a different company");
    }

    const keys = await existingKeys(targetCompanyId);
    const key = deriveUniqueRoleKey(source.name, keys);
    const [created] = await db
      .insert(companyAgentRoles)
      .values({
        companyId: targetCompanyId,
        name: source.name,
        key,
        description: source.description,
        defaultInstructions: source.defaultInstructions,
        defaultMcpServers: source.defaultMcpServers,
        defaultPermissionGrants: source.defaultPermissionGrants,
      })
      .returning();
    return created!;
  }

  // DUR-114: applies a role's three defaults to an agent exactly once, at
  // assignment time -- not continuous reconciliation. Later changes to the
  // role definition never re-propagate to already-assigned agents.
  async function assign(
    companyId: string,
    agentId: string,
    roleId: string | null,
    actor: { userId: string | null },
  ): Promise<{ agent: NonNullable<Awaited<ReturnType<typeof agentsSvc.getById>>>; warnings: string[] }> {
    const agent = await agentsSvc.getById(agentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

    if (roleId === null) {
      const updated = await agentsSvc.applyRoleAssignment(agentId, {
        roleId: null,
        roleAssignedAt: null,
        roleAppliedMcpServerNames: null,
        roleAppliedPermissionGrants: null,
      });
      if (!updated) throw notFound("Agent not found");
      return { agent: updated, warnings: [] };
    }

    const role = await getById(companyId, roleId);
    if (!role) throw notFound("Role not found");

    const warnings: string[] = [];

    // 1. Tools: add the role's default MCP servers to the agent's
    // adapterConfig.mcpServers. Name collisions keep the agent's existing
    // entry rather than clobbering it.
    const defaultServers = role.defaultMcpServers as McpServerConfig[];
    const currentAdapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const currentServers: McpServerConfig[] = Array.isArray(currentAdapterConfig.mcpServers)
      ? (currentAdapterConfig.mcpServers as McpServerConfig[])
      : [];
    const currentNames = new Set(currentServers.map((server) => server.name));
    const serversToAdd = defaultServers.filter((server) => !currentNames.has(server.name));
    if (serversToAdd.length > 0) {
      await agentsSvc.update(agentId, {
        adapterConfig: { ...currentAdapterConfig, mcpServers: [...currentServers, ...serversToAdd] },
      });
    }

    // 2. Rights: grant each of the role's default permission grants.
    const defaultGrants = role.defaultPermissionGrants as PermissionGrant[];
    for (const grant of defaultGrants) {
      await access.setPrincipalPermission(
        companyId,
        "agent",
        agentId,
        grant.permissionKey as Parameters<typeof access.setPrincipalPermission>[3],
        true,
        actor.userId,
        grant.scope ?? null,
      );
    }

    // 3. Instructions: direct replace of the agent's managed instructions
    // bundle entry file. Best-effort -- a filesystem failure here (e.g. no
    // workspace materialized yet) does not block role assignment, matching
    // the same non-fatal-warning pattern company-portability.ts uses when
    // materializing an imported agent's instructions bundle.
    if (role.defaultInstructions) {
      try {
        const refreshedAgent = await agentsSvc.getById(agentId);
        if (refreshedAgent) {
          const bundle = await instructions.getBundle(refreshedAgent);
          const entryFile = bundle.entryFile || "AGENTS.md";
          const materialized = await instructions.materializeManagedBundle(
            refreshedAgent,
            { [entryFile]: role.defaultInstructions },
            { clearLegacyPromptTemplate: true, replaceExisting: true, entryFile },
          );
          await agentsSvc.update(agentId, { adapterConfig: materialized.adapterConfig });
        }
      } catch (err) {
        warnings.push(`Failed to apply role instructions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updated = await agentsSvc.applyRoleAssignment(agentId, {
      roleId: role.id,
      roleAssignedAt: new Date(),
      roleAppliedMcpServerNames: defaultServers.map((server) => server.name),
      roleAppliedPermissionGrants: defaultGrants,
    });
    if (!updated) throw notFound("Agent not found");

    return { agent: updated, warnings };
  }

  // Diffs the agent's live tools/rights against the snapshot recorded at
  // assignment time, so callers can render "added"/"removed" without
  // continuous reconciliation.
  async function getOverrides(companyId: string, agentId: string) {
    const agent = await agentsSvc.getById(agentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

    const currentAdapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const currentServers: McpServerConfig[] = Array.isArray(currentAdapterConfig.mcpServers)
      ? (currentAdapterConfig.mcpServers as McpServerConfig[])
      : [];
    const currentToolNames = new Set(currentServers.map((server) => server.name));
    const appliedToolNames = new Set((agent.roleAppliedMcpServerNames as string[] | null) ?? []);

    const currentGrants = await access.listPrincipalGrants(companyId, "agent", agentId);
    const currentPermissionKeys = new Set(currentGrants.map((grant) => grant.permissionKey));
    const appliedGrants = (agent.roleAppliedPermissionGrants as PermissionGrant[] | null) ?? [];
    const appliedPermissionKeys = new Set(appliedGrants.map((grant) => grant.permissionKey));

    return {
      roleId: agent.roleId,
      roleAssignedAt: agent.roleAssignedAt,
      tools: {
        added: [...currentToolNames].filter((name) => !appliedToolNames.has(name)),
        removed: [...appliedToolNames].filter((name) => !currentToolNames.has(name)),
      },
      rights: {
        added: [...currentPermissionKeys].filter((key) => !appliedPermissionKeys.has(key)),
        removed: [...appliedPermissionKeys].filter((key) => !currentPermissionKeys.has(key)),
      },
    };
  }

  return { list, getById, create, update, remove, duplicateToCompany, assign, getOverrides };
}
