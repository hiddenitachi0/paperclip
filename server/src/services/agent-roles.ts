// DUR-114: agent roles ("jobs") service — create/read/update/delete roles,
// assign a role to an agent (apply-once model), copy roles across companies.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyAgentRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

// Derive a URL-safe slug from a human name. Unique within a company is enforced
// at the DB level; callers that need to disambiguate should append a suffix.
function deriveKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "role";
}

// Hard rule: no role right may ever carry deploy-approval power. Enforce this
// by stripping any key that isn't in PERMISSION_KEYS, and explicitly refusing
// the hypothetical future "deploys:approve" key even if someone adds it.
const DEPLOY_APPROVAL_KEYS = new Set(["deploys:approve", "merges:approve"]);

function sanitizeGrants(
  grants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>
): Array<{ permissionKey: PermissionKey; scope: Record<string, unknown> | null }> {
  return grants.filter((g) => {
    const key = g.permissionKey;
    if (DEPLOY_APPROVAL_KEYS.has(key)) {
      throw unprocessable(`Permission key '${key}' may never be assigned via a role — deploy/merge approval is board-only.`);
    }
    return (PERMISSION_KEYS as ReadonlyArray<string>).includes(key);
  }) as Array<{ permissionKey: PermissionKey; scope: Record<string, unknown> | null }>;
}

export interface RoleCreateInput {
  name: string;
  description?: string | null;
  defaultInstructions?: string | null;
  defaultMcpServers?: Array<Record<string, unknown>>;
  defaultGrants?: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
}

export async function createRole(db: Db, companyId: string, input: RoleCreateInput) {
  const key = deriveKey(input.name);
  const grants = sanitizeGrants(input.defaultGrants ?? []);

  // Check for key collision within the company and disambiguate automatically
  const existing = await db
    .select({ id: companyAgentRoles.id })
    .from(companyAgentRoles)
    .where(and(eq(companyAgentRoles.companyId, companyId), eq(companyAgentRoles.key, key)));
  const finalKey = existing.length > 0 ? `${key}-${Date.now().toString(36)}` : key;

  const [created] = await db
    .insert(companyAgentRoles)
    .values({
      companyId,
      name: input.name,
      key: finalKey,
      description: input.description ?? null,
      defaultInstructions: input.defaultInstructions ?? null,
      defaultMcpServers: input.defaultMcpServers ?? [],
      defaultGrants: grants,
    })
    .returning();
  return created!;
}

export async function listRoles(db: Db, companyId: string) {
  return db
    .select()
    .from(companyAgentRoles)
    .where(eq(companyAgentRoles.companyId, companyId))
    .orderBy(companyAgentRoles.name);
}

export async function getRole(db: Db, roleId: string) {
  const [row] = await db
    .select()
    .from(companyAgentRoles)
    .where(eq(companyAgentRoles.id, roleId));
  return row ?? null;
}

export async function updateRole(
  db: Db,
  roleId: string,
  input: Partial<RoleCreateInput>
) {
  const updates: Partial<typeof companyAgentRoles.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    updates.name = input.name;
    // Re-derive key when name changes. If the derived key is already taken by
    // another role in the same company, keep the existing key to avoid a
    // unique-constraint 500 and to preserve agent snapshots.
    const candidateKey = deriveKey(input.name);
    const current = await db
      .select({ companyId: companyAgentRoles.companyId, key: companyAgentRoles.key })
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.id, roleId))
      .then((rows) => rows[0] ?? null);
    if (current) {
      const collision = await db
        .select({ id: companyAgentRoles.id })
        .from(companyAgentRoles)
        .where(
          and(
            eq(companyAgentRoles.companyId, current.companyId),
            eq(companyAgentRoles.key, candidateKey)
          )
        );
      // Only update the key when there's no collision (or the collision IS this row).
      const collidingOther = collision.filter((r) => r.id !== roleId);
      updates.key = collidingOther.length === 0 ? candidateKey : current.key;
    }
  }
  if ("description" in input) updates.description = input.description ?? null;
  if ("defaultInstructions" in input) updates.defaultInstructions = input.defaultInstructions ?? null;
  if ("defaultMcpServers" in input) updates.defaultMcpServers = input.defaultMcpServers ?? [];
  if ("defaultGrants" in input) updates.defaultGrants = sanitizeGrants(input.defaultGrants ?? []);

  const [updated] = await db
    .update(companyAgentRoles)
    .set(updates)
    .where(eq(companyAgentRoles.id, roleId))
    .returning();
  if (!updated) throw notFound("Role not found");
  return updated;
}

export async function deleteRole(db: Db, roleId: string) {
  // ON DELETE SET NULL on the FK means agents keep their state; roleId becomes null.
  await db.delete(companyAgentRoles).where(eq(companyAgentRoles.id, roleId));
}

// Copy a role into a target company. Returns the new role.
export async function copyRoleToCompany(
  db: Db,
  sourceRoleId: string,
  targetCompanyId: string
) {
  const source = await getRole(db, sourceRoleId);
  if (!source) throw notFound("Source role not found");

  return createRole(db, targetCompanyId, {
    name: source.name,
    description: source.description,
    defaultInstructions: source.defaultInstructions,
    defaultMcpServers: source.defaultMcpServers as Array<Record<string, unknown>>,
    defaultGrants: source.defaultGrants as Array<{ permissionKey: string; scope: Record<string, unknown> | null }>,
  });
}

interface AssignRoleOptions {
  // Board actor performing the assignment (for audit trail on grants)
  grantedByUserId?: string | null;
}

// Apply a role to an agent once at assignment time. This is NOT continuous
// reconciliation — changes to the role after assignment do not affect the agent.
export async function assignRoleToAgent(
  db: Db,
  agentId: string,
  roleId: string | null,
  options: AssignRoleOptions = {}
) {
  // Clearing the role: null out the FK and snapshots, and revoke any permission
  // grants that were applied from the role (using the snapshot to know which ones).
  if (roleId === null) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, roleAppliedPermissionKeys: agents.roleAppliedPermissionKeys })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");

    const appliedKeys = (agent.roleAppliedPermissionKeys as string[] | null) ?? [];

    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({
          roleId: null,
          roleAppliedMcpServerNames: [],
          roleAppliedPermissionKeys: [],
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));

      if (appliedKeys.length > 0) {
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.principalType, "agent"),
              eq(principalPermissionGrants.principalId, agentId),
              inArray(principalPermissionGrants.permissionKey, appliedKeys as [string, ...string[]])
            )
          );
      }
    });

    const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!updated) throw notFound("Agent not found");
    return updated;
  }

  const role = await getRole(db, roleId);
  if (!role) throw notFound("Role not found");

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");
  if (agent.companyId !== role.companyId) {
    throw unprocessable("Role and agent must belong to the same company");
  }

  const grants = sanitizeGrants(
    role.defaultGrants as Array<{ permissionKey: string; scope: Record<string, unknown> | null }>
  );
  const mcpServers = (role.defaultMcpServers ?? []) as Array<Record<string, unknown>>;
  const mcpServerNames = mcpServers.map((s) => String(s.name ?? ""));
  const permissionKeys = grants.map((g) => g.permissionKey);

  const now = new Date();

  await db.transaction(async (tx) => {
    // Apply default instructions as the agent's instructions bootstrap prompt,
    // by merging into adapterConfig if the role provides instructions.
    const newAdapterConfig: Record<string, unknown> = {
      ...(agent.adapterConfig as Record<string, unknown> ?? {}),
    };
    if (role.defaultInstructions) {
      newAdapterConfig.bootstrapPromptTemplate = role.defaultInstructions;
    }

    // Merge MCP servers: add any role-defined servers that aren't already present
    // (match by name). We do not remove existing servers.
    const existingServers = (newAdapterConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
    const existingNames = new Set(existingServers.map((s) => String(s.name ?? "")));
    const toAdd = mcpServers.filter((s) => !existingNames.has(String(s.name ?? "")));
    newAdapterConfig.mcpServers = [...existingServers, ...toAdd];

    // Update the agent row: new roleId, new adapterConfig, and snapshots.
    await tx
      .update(agents)
      .set({
        roleId,
        adapterConfig: newAdapterConfig,
        roleAppliedMcpServerNames: mcpServerNames,
        roleAppliedPermissionKeys: permissionKeys,
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));

    // Apply permission grants (upsert by the unique index on companyId+type+id+key).
    // We use INSERT … ON CONFLICT DO NOTHING — the grant already exists, no need to
    // overwrite (the user may have customized scope on an existing grant).
    if (grants.length > 0) {
      await tx
        .insert(principalPermissionGrants)
        .values(
          grants.map((g) => ({
            companyId: agent.companyId,
            principalType: "agent",
            principalId: agentId,
            permissionKey: g.permissionKey,
            scope: g.scope ?? null,
            grantedByUserId: options.grantedByUserId ?? null,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing();
    }
  });

  // Return the updated agent row
  const [updated] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));
  return updated!;
}
