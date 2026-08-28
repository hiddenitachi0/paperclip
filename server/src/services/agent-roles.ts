// DUR-114: agent roles ("jobs") service — create/read/update/delete roles,
// assign a role to an agent (apply-once model), copy roles across companies.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyAgentRoles,
  principalPermissionGrants,
  withCompanyScope,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";

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

// Non-empty, trimmed, deduped — same shape whether the keys came from a
// human-authored request body or a seed script.
function sanitizeKeys(keys: string[] | undefined): string[] {
  if (!keys) return [];
  return [...new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0))];
}

export interface RoleCreateInput {
  name: string;
  description?: string | null;
  defaultInstructions?: string | null;
  defaultMcpServers?: Array<Record<string, unknown>>;
  defaultGrants?: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
  skillKeys?: string[];
  connectorKeys?: string[];
  // Provenance only — never gates edit/delete of the role it's set on.
  isBuiltin?: boolean;
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
      skillKeys: sanitizeKeys(input.skillKeys),
      connectorKeys: sanitizeKeys(input.connectorKeys),
      isBuiltin: input.isBuiltin ?? false,
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
  if ("skillKeys" in input) updates.skillKeys = sanitizeKeys(input.skillKeys);
  if ("connectorKeys" in input) updates.connectorKeys = sanitizeKeys(input.connectorKeys);
  // isBuiltin is deliberately not updatable here — it's a creation-time
  // provenance record (was this role created by a seed script?), not a
  // togglable flag, and it never gates edit/delete either way.

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
    skillKeys: source.skillKeys as string[],
    connectorKeys: source.connectorKeys as string[],
    // Deliberately not copying isBuiltin — a copy is a new, operator-created
    // role even if the source was seeded.
  });
}

// The caller's identity, required on every role-mutating service function so
// that a caller who reaches these functions directly (bypassing the
// assertBoard-gated routes in routes/agent-roles.ts — e.g. a future route, a
// script, or an import path like company-portability.ts) cannot assign or
// modify a role without board authority, and can never target its own agent
// id. This mirrors assertNoRoleAssignmentFields in services/agents.ts, which
// protects the same fields on the generic create/update path (DUR-148).
export interface RoleMutationActor {
  type: string;
  agentId?: string | null;
}

function assertBoardActorForRoleMutation(actor: RoleMutationActor | undefined, targetAgentId: string) {
  if (!actor || actor.type !== "board") {
    throw forbidden("Only board-authenticated callers may assign or modify an agent's role.");
  }
  if (actor.agentId && actor.agentId === targetAgentId) {
    throw forbidden("An agent cannot assign or modify its own role.");
  }
}

interface AssignRoleOptions {
  // Board actor performing the assignment (for audit trail on grants)
  grantedByUserId?: string | null;
  actor: RoleMutationActor;
}

// Apply a role to an agent once at assignment time. This is NOT continuous
// reconciliation — changes to the role after assignment do not affect the agent.
//
// DUR-349 (DUR-277 Wave 3): `rawDb` defaults to `db` for every unmigrated
// caller, which is a no-op there (`db` is already the raw pooled instance
// for them). Only routes/agent-roles.ts, once wired through
// createRequestScopedDb, passes a `db` that is the *scoped* proxy and a
// distinct `rawDb` — the two db.transaction() sites below are not supported
// through that proxy (see packages/db/src/company-scope.ts) and need the
// raw connection via withCompanyScope instead.
export async function assignRoleToAgent(
  db: Db,
  agentId: string,
  roleId: string | null,
  options: AssignRoleOptions,
  rawDb: Db = db
) {
  assertBoardActorForRoleMutation(options.actor, agentId);

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

    await withCompanyScope(rawDb, agent.companyId, async (tx) => {
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

    await resolveAgentRoleProvisioning(db, agentId, rawDb);
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

  // Job switch (assigning a different role over an already-assigned one): the
  // previous role's job-owned grants/tools that the new role doesn't also carry
  // must be revoked, the same way clearing a role (roleId === null, above)
  // revokes them. Only keys/names recorded in the PREVIOUS snapshot are
  // candidates for revocation, so an operator-granted permission that was never
  // part of a role snapshot is untouched and survives the switch.
  const previouslyAppliedKeys = (agent.roleAppliedPermissionKeys as string[] | null) ?? [];
  const previouslyAppliedMcpNames = (agent.roleAppliedMcpServerNames as string[] | null) ?? [];
  const keysToRevoke = previouslyAppliedKeys.filter((k) => !permissionKeys.includes(k as PermissionKey));
  const mcpNamesToRemove = previouslyAppliedMcpNames.filter((n) => !mcpServerNames.includes(n));

  const now = new Date();

  await withCompanyScope(rawDb, agent.companyId, async (tx) => {
    // Apply default instructions as the agent's instructions bootstrap prompt,
    // by merging into adapterConfig if the role provides instructions.
    const newAdapterConfig: Record<string, unknown> = {
      ...(agent.adapterConfig as Record<string, unknown> ?? {}),
    };
    if (role.defaultInstructions) {
      newAdapterConfig.bootstrapPromptTemplate = role.defaultInstructions;
    }

    // Merge MCP servers: drop any servers owned by the previous role that the
    // new role doesn't also carry, then add any new role-defined servers that
    // aren't already present (match by name). Servers outside both role
    // snapshots (operator-added) are left untouched either way.
    const existingServers = (
      (newAdapterConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? []
    ).filter((s) => !mcpNamesToRemove.includes(String(s.name ?? "")));
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

    if (keysToRevoke.length > 0) {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agentId),
            inArray(principalPermissionGrants.permissionKey, keysToRevoke as [string, ...string[]])
          )
        );
    }

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

  await resolveAgentRoleProvisioning(db, agentId, rawDb);

  // Return the updated agent row
  const [updated] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));
  return updated!;
}

// ── DUR-149: provisioning — resolve effective skills/connectors/rights ─────
// Three provenance buckets feed the effective set for each of the three
// categories (skills, connectors, rights):
//   - job-owned:            the currently-assigned role's skillKeys/connectorKeys/defaultGrants
//   - operator-granted:     agent.roleOverrides.<category>.add — never touched below
//   - migration-backfilled: whatever a one-time backfill wrote straight into
//                            role_provisioned_* before any job existed; treated
//                            as job-owned for reconciliation (droppable), not
//                            as a permanent operator grant.
// Effective = (job-owned ∪ operator-add) − operator-remove.
//
// Reconciliation only ever touches the "job-owned-or-backfilled" portion of
// what was previously provisioned (previous ∖ operator-add) — an
// operator-granted entry is never revoked just because the job changed.
export interface RoleOverridesShape {
  skills?: { add?: string[]; remove?: string[] };
  connectors?: { add?: string[]; remove?: string[] };
  rights?: { add?: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>; remove?: string[] };
}

function effectiveSet(
  jobOwned: string[],
  operatorAdd: string[],
  operatorRemove: string[]
): { effective: string[]; operatorAddKeys: Set<string> } {
  const removeSet = new Set(operatorRemove);
  const effectiveSetValue = new Set<string>([...jobOwned, ...operatorAdd].filter((k) => !removeSet.has(k)));
  return { effective: [...effectiveSetValue], operatorAddKeys: new Set(operatorAdd) };
}

// DUR-349 (DUR-277 Wave 3): see the `rawDb` note on assignRoleToAgent above —
// same reasoning applies to this function's one db.transaction() site.
export async function resolveAgentRoleProvisioning(db: Db, agentId: string, rawDb: Db = db) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const role = agent.roleId ? await getRole(db, agent.roleId) : null;
  const overrides = (agent.roleOverrides as RoleOverridesShape | null) ?? {};

  const jobSkillKeys = (role?.skillKeys as string[] | null) ?? [];
  const jobConnectorKeys = (role?.connectorKeys as string[] | null) ?? [];
  const jobGrants = sanitizeGrants(
    (role?.defaultGrants as Array<{ permissionKey: string; scope: Record<string, unknown> | null }> | null) ?? []
  );
  const jobPermissionKeys = jobGrants.map((g) => g.permissionKey);
  const grantScopeByKey = new Map(jobGrants.map((g) => [g.permissionKey, g.scope]));

  const rightsAdd = sanitizeGrants(overrides.rights?.add ?? []);
  for (const g of rightsAdd) grantScopeByKey.set(g.permissionKey, g.scope);

  const skills = effectiveSet(jobSkillKeys, overrides.skills?.add ?? [], overrides.skills?.remove ?? []);
  const connectors = effectiveSet(jobConnectorKeys, overrides.connectors?.add ?? [], overrides.connectors?.remove ?? []);
  const rights = effectiveSet(
    jobPermissionKeys,
    rightsAdd.map((g) => g.permissionKey),
    overrides.rights?.remove ?? []
  );

  const previousRightKeys = (agent.roleProvisionedPermissionKeys as string[] | null) ?? [];
  const reconcilableRightKeys = previousRightKeys.filter((k) => !rights.operatorAddKeys.has(k));
  const toRevoke = reconcilableRightKeys.filter((k) => !rights.effective.includes(k));
  const toGrant = rights.effective.filter((k) => !previousRightKeys.includes(k));

  const now = new Date();

  await withCompanyScope(rawDb, agent.companyId, async (tx) => {
    if (toRevoke.length > 0) {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agentId),
            inArray(principalPermissionGrants.permissionKey, toRevoke as [string, ...string[]])
          )
        );
    }
    if (toGrant.length > 0) {
      await tx
        .insert(principalPermissionGrants)
        .values(
          toGrant.map((permissionKey) => ({
            companyId: agent.companyId,
            principalType: "agent",
            principalId: agentId,
            permissionKey,
            scope: grantScopeByKey.get(permissionKey as PermissionKey) ?? null,
            grantedByUserId: null,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing();
    }
    await tx
      .update(agents)
      .set({
        roleProvisionedSkillKeys: skills.effective,
        roleProvisionedConnectorKeys: connectors.effective,
        roleProvisionedPermissionKeys: rights.effective,
        roleResolvedAt: now,
      })
      .where(eq(agents.id, agentId));
  });

  const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
  return updated!;
}

// Add/remove one skill_key or connector_key on top of the assigned job — same
// one-at-a-time shape as addAgentToolOverride/addAgentRightOverride above, so
// the route layer stays consistent. Board-only, same actor guard as role
// assignment itself: an override is exactly as sensitive as assigning a role.
function addToOverrideCategory(
  overrides: RoleOverridesShape,
  category: "skills" | "connectors",
  key: string
): RoleOverridesShape {
  const existing = overrides[category] ?? {};
  return {
    ...overrides,
    [category]: {
      add: [...new Set([...(existing.add ?? []), key])],
      remove: (existing.remove ?? []).filter((k) => k !== key),
    },
  };
}

function removeFromOverrideCategory(
  overrides: RoleOverridesShape,
  category: "skills" | "connectors",
  key: string
): RoleOverridesShape {
  const existing = overrides[category] ?? {};
  return {
    ...overrides,
    [category]: {
      add: (existing.add ?? []).filter((k) => k !== key),
      remove: [...new Set([...(existing.remove ?? []), key])],
    },
  };
}

// `rawDb` (default `= db`) is forwarded to resolveAgentRoleProvisioning's own
// db.transaction() site below — see the note on assignRoleToAgent above. Only
// needed here because this function transitively calls
// resolveAgentRoleProvisioning at the end; it does not itself open a
// transaction.
export async function addAgentCatalogOverride(
  db: Db,
  agentId: string,
  category: "skills" | "connectors",
  key: string,
  actor: RoleMutationActor,
  rawDb: Db = db
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");
  const sanitized = sanitizeKeys([key]);
  if (sanitized.length === 0) throw unprocessable("A non-empty key is required");

  const overrides = addToOverrideCategory((agent.roleOverrides as RoleOverridesShape | null) ?? {}, category, sanitized[0]!);
  await db.update(agents).set({ roleOverrides: overrides as Record<string, unknown>, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return resolveAgentRoleProvisioning(db, agentId, rawDb);
}

export async function removeAgentCatalogOverride(
  db: Db,
  agentId: string,
  category: "skills" | "connectors",
  key: string,
  actor: RoleMutationActor,
  rawDb: Db = db
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const overrides = removeFromOverrideCategory((agent.roleOverrides as RoleOverridesShape | null) ?? {}, category, key);
  await db.update(agents).set({ roleOverrides: overrides as Record<string, unknown>, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return resolveAgentRoleProvisioning(db, agentId, rawDb);
}

// ── Role state + per-agent overrides on top of an assigned job ─────────────
// "Overrides" are tools/rights added or removed directly on the agent, on top
// of (or in the absence of) whatever its assigned job would have given it.
// They are NOT recorded into roleAppliedMcpServerNames/roleAppliedPermissionKeys
// (those snapshots track only what the JOB granted), so an override naturally
// shows up in the "added"/"removed" diff buckets computed below.

export interface AgentRoleStateDto {
  job: { id: string; name: string; description: string } | null;
  assignedAt: null;
  tools: { fromJob: string[]; added: string[]; removed: string[] };
  rights: {
    fromJob: Array<{ permissionKey: PermissionKey; scope: Record<string, unknown> | null }>;
    added: Array<{ permissionKey: PermissionKey; scope: Record<string, unknown> | null }>;
    removed: Array<{ permissionKey: PermissionKey; scope: Record<string, unknown> | null }>;
  };
}

export async function getAgentRoleState(db: Db, agentId: string): Promise<AgentRoleStateDto> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const role = agent.roleId ? await getRole(db, agent.roleId) : null;

  const appliedNames = new Set<string>((agent.roleAppliedMcpServerNames as string[] | null) ?? []);
  const currentConfig = (agent.adapterConfig as Record<string, unknown>) ?? {};
  const currentMcpServers = (currentConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
  const currentNames = new Set(currentMcpServers.map((s) => String(s.name ?? "")));

  const appliedKeys = new Set<string>((agent.roleAppliedPermissionKeys as string[] | null) ?? []);
  const liveGrants = await db
    .select({
      permissionKey: principalPermissionGrants.permissionKey,
      scope: principalPermissionGrants.scope,
    })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId)
      )
    );
  const liveGrantsByKey = new Map(liveGrants.map((g) => [g.permissionKey, g]));
  const roleGrantsByKey = new Map(
    (
      (role?.defaultGrants as Array<{ permissionKey: string; scope: Record<string, unknown> | null }> | undefined) ?? []
    ).map((g) => [g.permissionKey, g])
  );

  return {
    job: role ? { id: role.id, name: role.name, description: role.description ?? "" } : null,
    assignedAt: null,
    tools: {
      fromJob: [...appliedNames].filter((n) => currentNames.has(n)),
      added: [...currentNames].filter((n) => !appliedNames.has(n)),
      removed: [...appliedNames].filter((n) => !currentNames.has(n)),
    },
    rights: {
      fromJob: [...appliedKeys]
        .filter((k) => liveGrantsByKey.has(k))
        .map((k) => ({
          permissionKey: k as PermissionKey,
          scope: roleGrantsByKey.get(k)?.scope ?? liveGrantsByKey.get(k)!.scope ?? null,
        })),
      added: liveGrants
        .filter((g) => !appliedKeys.has(g.permissionKey))
        .map((g) => ({ permissionKey: g.permissionKey as PermissionKey, scope: g.scope })),
      removed: [...appliedKeys]
        .filter((k) => !liveGrantsByKey.has(k))
        .map((k) => ({ permissionKey: k as PermissionKey, scope: roleGrantsByKey.get(k)?.scope ?? null })),
    },
  };
}

export async function addAgentToolOverride(
  db: Db,
  agentId: string,
  tool: Record<string, unknown>,
  actor: RoleMutationActor
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const toolName = String(tool.name ?? "");
  const adapterConfig = (agent.adapterConfig as Record<string, unknown>) ?? {};
  const existingServers = (adapterConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
  const nextServers = [...existingServers.filter((s) => String(s.name ?? "") !== toolName), tool];

  await db
    .update(agents)
    .set({ adapterConfig: { ...adapterConfig, mcpServers: nextServers }, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  return getAgentRoleState(db, agentId);
}

export async function removeAgentToolOverride(
  db: Db,
  agentId: string,
  toolName: string,
  actor: RoleMutationActor
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const adapterConfig = (agent.adapterConfig as Record<string, unknown>) ?? {};
  const existingServers = (adapterConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
  const nextServers = existingServers.filter((s) => String(s.name ?? "") !== toolName);

  await db
    .update(agents)
    .set({ adapterConfig: { ...adapterConfig, mcpServers: nextServers }, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  return getAgentRoleState(db, agentId);
}

// `rawDb` (default `= db`) — same reasoning as addAgentCatalogOverride above.
export async function addAgentRightOverride(
  db: Db,
  agentId: string,
  grant: { permissionKey: string; scope: Record<string, unknown> | null },
  actor: RoleMutationActor,
  grantedByUserId: string | null = null,
  rawDb: Db = db
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  const [sanitized] = sanitizeGrants([grant]);
  if (!sanitized) throw unprocessable(`Unknown permission key '${grant.permissionKey}'`);

  const existing = await db
    .select({ id: principalPermissionGrants.id })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, sanitized.permissionKey)
      )
    )
    .then((rows) => rows[0] ?? null);

  const now = new Date();
  if (existing) {
    await db
      .update(principalPermissionGrants)
      .set({ scope: sanitized.scope, grantedByUserId, updatedAt: now })
      .where(eq(principalPermissionGrants.id, existing.id));
  } else {
    await db.insert(principalPermissionGrants).values({
      companyId: agent.companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: sanitized.permissionKey,
      scope: sanitized.scope,
      grantedByUserId,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Record this as an explicit operator grant in roleOverrides.rights.add so
  // resolveAgentRoleProvisioning's reconciliation (called next) treats it as
  // protected — never auto-revoked just because the assigned job changes.
  const overrides = { ...((agent.roleOverrides as RoleOverridesShape | null) ?? {}) };
  const existingAdd = (overrides.rights?.add ?? []).filter((g) => g.permissionKey !== sanitized.permissionKey);
  const existingRemove = (overrides.rights?.remove ?? []).filter((k) => k !== sanitized.permissionKey);
  overrides.rights = { add: [...existingAdd, sanitized], remove: existingRemove };
  await db.update(agents).set({ roleOverrides: overrides as Record<string, unknown>, updatedAt: now }).where(eq(agents.id, agentId));

  await resolveAgentRoleProvisioning(db, agentId, rawDb);
  return getAgentRoleState(db, agentId);
}

// `rawDb` (default `= db`) — same reasoning as addAgentCatalogOverride above.
export async function removeAgentRightOverride(
  db: Db,
  agentId: string,
  permissionKey: string,
  actor: RoleMutationActor,
  rawDb: Db = db
) {
  assertBoardActorForRoleMutation(actor, agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");

  await db
    .delete(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, permissionKey)
      )
    );

  // Record the removal in roleOverrides.rights.remove so reconciliation never
  // re-grants it from the job's defaults, and drop any prior operator-add
  // entry for the same key (removed wins over a stale add).
  const overrides = { ...((agent.roleOverrides as RoleOverridesShape | null) ?? {}) };
  const existingAdd = (overrides.rights?.add ?? []).filter((g) => g.permissionKey !== permissionKey);
  const existingRemove = new Set(overrides.rights?.remove ?? []);
  existingRemove.add(permissionKey);
  overrides.rights = { add: existingAdd, remove: [...existingRemove] };
  await db.update(agents).set({ roleOverrides: overrides as Record<string, unknown>, updatedAt: new Date() }).where(eq(agents.id, agentId));

  await resolveAgentRoleProvisioning(db, agentId, rawDb);
  return getAgentRoleState(db, agentId);
}
