// Per-agent "ask" rights: whether one agent may ask a person to put changes
// live (deploys:request) or to merge finished code (merges:request).
//
// Before this, an agent only got these through a position's default grants,
// and assigning a position also overwrites the agent's starting instructions.
// This service lets a company owner or admin switch the two rights on or off
// for one agent directly.
//
// Rules:
//   - It only ever writes or deletes the two grant rows named above for that
//     one agent in its own company. Every other grant is left alone, and no
//     wider position reconciliation runs.
//   - A switch is independent of the agent's position. Positions are copied
//     onto an agent once (later edits to a position do not reach it), so
//     "manage it on the position" would leave no way to change one agent.
//     Instead the switch records a per-agent choice in agents.role_overrides
//     (the same bookkeeping the Job/Rights overrides use), so a later
//     position change or reconciliation neither drops a right switched on
//     here nor puts back a right switched off here.
//   - Asking is never approving: a person still approves every deploy and
//     every merge (assertBoard on the approve route), whatever is set here.
//
// Who may call it is decided by the route (owner/admin only, never an agent).
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyAgentRoles, principalPermissionGrants, withCompanyScope } from "@paperclipai/db";
import { notFound } from "../errors.js";
import type { RoleOverridesShape } from "./agent-roles.js";

export const AGENT_REQUEST_RIGHT_KEYS = ["deploys:request", "merges:request"] as const;
export type AgentRequestRightKey = (typeof AGENT_REQUEST_RIGHT_KEYS)[number];

export const AGENT_REQUEST_RIGHT_FIELDS: Record<"deploysRequest" | "mergesRequest", AgentRequestRightKey> = {
  deploysRequest: "deploys:request",
  mergesRequest: "merges:request",
};
export type AgentRequestRightField = keyof typeof AGENT_REQUEST_RIGHT_FIELDS;

export interface AgentRequestRightState {
  permissionKey: AgentRequestRightKey;
  /** The agent holds the grant right now. */
  enabled: boolean;
  /**
   * Where the current answer comes from:
   *   "position"     the right came with the agent's position
   *   "agent"        switched on for this agent directly (or held from before positions existed)
   *   "turned_off"   the position gives it, but it was switched off for this agent
   *   "none"         not held, and the position (if any) does not give it
   */
  source: "position" | "agent" | "turned_off" | "none";
  /** True when the agent's position carries this right. */
  positionGivesIt: boolean;
  grantedByUserId: string | null;
  updatedAt: string | null;
}

export interface AgentRequestRightsState {
  agentId: string;
  companyId: string;
  position: { id: string; name: string } | null;
  deploysRequest: AgentRequestRightState;
  mergesRequest: AgentRequestRightState;
}

export interface AgentRequestRightChange {
  permissionKey: AgentRequestRightKey;
  from: boolean;
  to: boolean;
}

type AgentRow = typeof agents.$inferSelect;

function readOverrides(agent: AgentRow): RoleOverridesShape {
  const raw = agent.roleOverrides as RoleOverridesShape | null;
  return raw && typeof raw === "object" ? raw : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function agentRequestRightsService(db: Db, rawDb: Db = db) {
  async function loadAgent(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function loadPosition(agent: AgentRow) {
    if (!agent.roleId) return null;
    const [role] = await db
      .select({
        id: companyAgentRoles.id,
        name: companyAgentRoles.name,
        companyId: companyAgentRoles.companyId,
        defaultGrants: companyAgentRoles.defaultGrants,
      })
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.id, agent.roleId));
    if (!role || role.companyId !== agent.companyId) return null;
    return role;
  }

  /**
   * Keys the agent's position gives it: what was copied on at assignment, plus
   * what the position carries today (reconciliation reads the latter).
   */
  function positionKeys(agent: AgentRow, position: Awaited<ReturnType<typeof loadPosition>>): Set<string> {
    if (!position) return new Set();
    const applied = stringArray(agent.roleAppliedPermissionKeys);
    const current = ((position.defaultGrants as Array<{ permissionKey?: unknown }> | null) ?? [])
      .map((g) => g?.permissionKey)
      .filter((k): k is string => typeof k === "string");
    return new Set([...applied, ...current]);
  }

  async function loadGrants(agent: AgentRow, client: Db = db) {
    return client
      .select({
        id: principalPermissionGrants.id,
        permissionKey: principalPermissionGrants.permissionKey,
        grantedByUserId: principalPermissionGrants.grantedByUserId,
        updatedAt: principalPermissionGrants.updatedAt,
      })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, agent.companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agent.id),
          inArray(principalPermissionGrants.permissionKey, [...AGENT_REQUEST_RIGHT_KEYS]),
        ),
      );
  }

  async function buildState(agent: AgentRow): Promise<AgentRequestRightsState> {
    const position = await loadPosition(agent);
    const fromPosition = positionKeys(agent, position);
    const overrides = readOverrides(agent);
    const added = new Set((overrides.rights?.add ?? []).map((g) => g.permissionKey));
    const removed = new Set(overrides.rights?.remove ?? []);
    const grants = new Map((await loadGrants(agent)).map((g) => [g.permissionKey, g]));

    const stateFor = (key: AgentRequestRightKey): AgentRequestRightState => {
      const grant = grants.get(key) ?? null;
      const positionGivesIt = fromPosition.has(key);
      let source: AgentRequestRightState["source"];
      if (grant) source = positionGivesIt && !added.has(key) ? "position" : "agent";
      else source = positionGivesIt && removed.has(key) ? "turned_off" : "none";
      return {
        permissionKey: key,
        enabled: Boolean(grant),
        source,
        positionGivesIt,
        grantedByUserId: grant?.grantedByUserId ?? null,
        updatedAt: grant?.updatedAt ? new Date(grant.updatedAt).toISOString() : null,
      };
    };

    return {
      agentId: agent.id,
      companyId: agent.companyId,
      position: position ? { id: position.id, name: position.name } : null,
      deploysRequest: stateFor("deploys:request"),
      mergesRequest: stateFor("merges:request"),
    };
  }

  return {
    async get(agentId: string) {
      return buildState(await loadAgent(agentId));
    },

    /**
     * Switch either or both rights for one agent. Fields left out are not
     * touched. Returns the new state and the changes actually made (empty
     * when nothing changed).
     */
    async set(
      agentId: string,
      input: Partial<Record<AgentRequestRightField, boolean>>,
      grantedByUserId: string | null,
    ): Promise<{ state: AgentRequestRightsState; changes: AgentRequestRightChange[] }> {
      const agent = await loadAgent(agentId);
      const position = await loadPosition(agent);
      const fromPosition = positionKeys(agent, position);
      const changes: AgentRequestRightChange[] = [];

      await withCompanyScope(rawDb, agent.companyId, async (tx) => {
        const txDb = tx as unknown as Db;
        // Re-read inside the transaction so concurrent switches don't
        // overwrite each other's bookkeeping.
        const [fresh] = await txDb.select().from(agents).where(eq(agents.id, agent.id)).for("update");
        if (!fresh) throw notFound("Agent not found");
        const overrides = readOverrides(fresh);
        let add = [...(overrides.rights?.add ?? [])];
        let remove = [...(overrides.rights?.remove ?? [])];
        let provisioned = stringArray(fresh.roleProvisionedPermissionKeys);
        const grants = new Map((await loadGrants(fresh, txDb)).map((g) => [g.permissionKey, g]));
        const now = new Date();

        for (const [field, key] of Object.entries(AGENT_REQUEST_RIGHT_FIELDS) as Array<
          [AgentRequestRightField, AgentRequestRightKey]
        >) {
          const wanted = input[field];
          if (typeof wanted !== "boolean") continue;
          const existing = grants.get(key) ?? null;
          const positionGivesIt = fromPosition.has(key);

          if (wanted) {
            if (!existing) {
              await txDb.insert(principalPermissionGrants).values({
                companyId: fresh.companyId,
                principalType: "agent",
                principalId: fresh.id,
                permissionKey: key,
                scope: null,
                grantedByUserId,
                createdAt: now,
                updatedAt: now,
              });
              changes.push({ permissionKey: key, from: false, to: true });
            }
            remove = remove.filter((k) => k !== key);
            // A right the position does not give is recorded as this agent's
            // own, so a later position change never drops it.
            if (!positionGivesIt && !add.some((g) => g.permissionKey === key)) {
              add = [...add, { permissionKey: key, scope: null }];
            }
            if (!provisioned.includes(key)) provisioned = [...provisioned, key];
          } else {
            if (existing) {
              await txDb
                .delete(principalPermissionGrants)
                .where(eq(principalPermissionGrants.id, existing.id));
              changes.push({ permissionKey: key, from: true, to: false });
            }
            add = add.filter((g) => g.permissionKey !== key);
            // Only remember "switched off" when the position would otherwise
            // give it back; otherwise a stale entry would silently block a
            // position assigned later.
            if (positionGivesIt && !remove.includes(key)) remove = [...remove, key];
            if (!positionGivesIt) remove = remove.filter((k) => k !== key);
            provisioned = provisioned.filter((k) => k !== key);
          }
        }

        await txDb
          .update(agents)
          .set({
            roleOverrides: { ...overrides, rights: { add, remove } } as Record<string, unknown>,
            roleProvisionedPermissionKeys: provisioned,
            updatedAt: now,
          })
          .where(eq(agents.id, fresh.id));
      });

      return { state: await buildState(await loadAgent(agentId)), changes };
    },
  };
}
