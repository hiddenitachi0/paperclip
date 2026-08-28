// DUR-114: routes for company agent roles ("jobs") and role assignment.
// Board-only throughout — agents are structurally blocked from reaching these routes.
import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { mcpServerConfigSchema } from "@paperclipai/shared/validators/agent";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import type { RoleMutationActor } from "../services/agent-roles.js";
import {
  createRole,
  listRoles,
  getRole,
  updateRole,
  deleteRole,
  copyRoleToCompany,
  assignRoleToAgent,
  getAgentRoleState,
  addAgentToolOverride,
  removeAgentToolOverride,
  addAgentRightOverride,
  removeAgentRightOverride,
  addAgentCatalogOverride,
  removeAgentCatalogOverride,
} from "../services/agent-roles.js";

// Board-only, and explicitly refuses actor==target even though assertBoard
// (called by every route below, before this) already makes that path
// structurally unreachable today — defense in depth against a future change
// that loosens assertBoard or adds a board-adjacent actor type that carries
// an agentId (DUR-148).
function assertNotSelfRoleMutation(req: { actor?: RoleMutationActor }, targetAgentId: string) {
  if (req.actor?.agentId && req.actor.agentId === targetAgentId) {
    throw forbidden("An agent cannot assign or modify its own role.");
  }
}

function actorFor(req: { actor?: RoleMutationActor }): RoleMutationActor {
  return { type: req.actor?.type ?? "none", agentId: req.actor?.agentId ?? null };
}

// Schema for the {permissionKey, scope} grant shape
const grantSchema = z.object({
  permissionKey: z.enum(PERMISSION_KEYS),
  scope: z.record(z.unknown()).nullable().optional().transform((v) => v ?? null),
});

// Opaque catalog keys (company_skills / company_mcp_tools). Not validated
// against either catalog here — see the PR description for why resolving
// them into live agent state is scoped out of this change.
const catalogKeySchema = z.string().trim().min(1).max(200);

const roleBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  defaultInstructions: z.string().max(100_000).nullable().optional(),
  defaultMcpServers: z.array(mcpServerConfigSchema).max(50).optional(),
  defaultGrants: z.array(grantSchema).max(50).optional(),
  skillKeys: z.array(catalogKeySchema).max(100).optional(),
  connectorKeys: z.array(catalogKeySchema).max(100).optional(),
});

const roleUpdateSchema = roleBodySchema.partial();

const catalogCategorySchema = z.enum(["skills", "connectors"]);

export function agentRoleRoutes(rawDb: Db) {
  const router = Router();
  // DUR-349 (DUR-277 Wave 3): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope role/agent lookups the (b)-category
  // routes below need before their companyId is known (scopeFromRole /
  // scopeFromAgent / scopeFromAgentForCategory), and is threaded through to
  // assignRoleToAgent/addAgent*Override's `rawDb` param, which the handful
  // of db.transaction() sites reachable from those services need directly —
  // the request-scoped proxy does not support .transaction(), see
  // packages/db/src/company-scope.ts. See middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);

  // ── Shared (b)-category resolvers: DUR-277 design doc §1 calls for "1
  // shared lookup helper" for this file's ~11 repeated lookup-then-scope
  // routes. Each runs from inside companyScope's resolver, i.e. before any
  // connection is reserved for company scope — see middleware/company-scope.ts
  // and DUR-348's should-fix. All three intentionally use rawDb, since no
  // scope exists yet at this point.

  // /agent-roles/:roleId and /agent-roles/:roleId/copy — companyId comes
  // from the role row itself.
  function scopeFromRole() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const role = await getRole(rawDb, req.params.roleId as string);
      if (!role) throw notFound("Role not found");
      await assertCompanyAccess(req, role.companyId);
      return role.companyId;
    });
  }

  // /agents/:agentId/role, /agents/:agentId/role/tools*, /agents/:agentId/role/rights*
  // — companyId comes from the agent row.
  function scopeFromAgent() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      assertNotSelfRoleMutation(req, agentId);
      const [agent] = await rawDb
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) throw notFound("Agent not found");
      await assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  // /agents/:agentId/role/:category* — same as scopeFromAgent, but the
  // category param must be validated (404 on an unknown category) before
  // the agent lookup, matching the original route ordering, so a bad
  // category still 404s without ever touching the db.
  function scopeFromAgentForCategory() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      assertNotSelfRoleMutation(req, agentId);
      if (!catalogCategorySchema.safeParse(req.params.category).success) {
        throw notFound("Unknown override category");
      }
      const [agent] = await rawDb
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) throw notFound("Agent not found");
      await assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  function parseCatalogCategory(req: Request): "skills" | "connectors" {
    // Guaranteed valid by scopeFromAgentForCategory's resolver, which already
    // ran (and would have 404'd) before this handler is ever reached.
    return catalogCategorySchema.parse(req.params.category);
  }

  // ── Company role CRUD ────────────────────────────────────────────────────

  // List all roles for a company
  router.get(
    "/companies/:companyId/agent-roles",
    companyScopeFromParam(rawDb, async (req, companyId) => {
      assertBoard(req);
      await assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const roles = await listRoles(db, req.params.companyId as string);
      res.json(roles);
    }
  );

  // Create a new role
  router.post(
    "/companies/:companyId/agent-roles",
    companyScopeFromParam(rawDb, async (req, companyId) => {
      assertBoard(req);
      await assertCompanyAccess(req, companyId);
    }),
    validate(roleBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const role = await createRole(db, companyId, req.body);
      res.status(201).json(role);
    }
  );

  // Get a single role — companyId comes from the role row itself, resolved
  // and access-checked by scopeFromRole() above.
  router.get("/agent-roles/:roleId", scopeFromRole(), async (req, res) => {
    const role = await getRole(db, req.params.roleId as string);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    res.json(role);
  });

  // Update a role
  router.patch(
    "/agent-roles/:roleId",
    scopeFromRole(),
    validate(roleUpdateSchema),
    async (req, res) => {
      const roleId = req.params.roleId as string;
      const updated = await updateRole(db, roleId, req.body);
      res.json(updated);
    }
  );

  // Delete a role (ON DELETE SET NULL keeps agents intact)
  router.delete("/agent-roles/:roleId", scopeFromRole(), async (req, res) => {
    await deleteRole(db, req.params.roleId as string);
    res.status(204).send();
  });

  // Copy a role to another company. Primary company scope stays the SOURCE
  // role's company (resolved by scopeFromRole()) — copyRoleToCompany writes
  // into targetCompanyId explicitly as a parameter, not via ambient scope,
  // so this deliberately does not attempt to scope to both companies at
  // once. The second assertCompanyAccess check below covers the target
  // company access decision on top of that.
  router.post(
    "/agent-roles/:roleId/copy",
    scopeFromRole(),
    validate(z.object({ targetCompanyId: z.string().uuid() })),
    async (req, res) => {
      const roleId = req.params.roleId as string;
      await assertCompanyAccess(req, req.body.targetCompanyId);
      const copied = await copyRoleToCompany(db, roleId, req.body.targetCompanyId);
      res.status(201).json(copied);
    }
  );

  // ── Role assignment on agents ────────────────────────────────────────────
  // POST /agents/:id/role  — board-only, never allow_self
  // An agent can never call this endpoint even if it holds permission grants.

  router.post(
    "/agents/:agentId/role",
    scopeFromAgent(),
    validate(
      z.object({
        roleId: z.string().uuid().nullable(),
      })
    ),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const { roleId } = req.body as { roleId: string | null };

      // roleId/company match is re-checked here (rather than only inside
      // assignRoleToAgent) to preserve the exact pre-existing 404/422
      // response shape for this route without relying on the service's
      // internal validation order.
      if (roleId !== null) {
        const [agent] = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, agentId));
        if (!agent) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        const role = await getRole(db, roleId);
        if (!role) {
          res.status(404).json({ error: "Role not found" });
          return;
        }
        if (role.companyId !== agent.companyId) {
          res.status(422).json({ error: "Role and agent must belong to the same company" });
          return;
        }
      }

      const grantedByUserId = (req as { actor?: { userId?: string | null } }).actor?.userId ?? null;
      const updated = await assignRoleToAgent(db, agentId, roleId, { grantedByUserId, actor: actorFor(req) }, rawDb);
      res.json(updated);
    }
  );

  // GET /agents/:id/role — return the agent's current role plus tool/right
  // overrides, in the AgentRoleState shape the UI (ui/src/api/jobs.ts) expects.
  // No role assigned is the normal case (all 22 live agents at the time of
  // DUR-142), so this always returns the full shape with empty arrays rather
  // than a shorter "no role" variant the UI was never built to read.
  router.get("/agents/:agentId/role", scopeFromAgent(), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await getAgentRoleState(db, agentId));
  });

  // ── Per-agent tool/right overrides on top of an assigned job ────────────
  // Board-only, and — like POST /agents/:id/role above — explicitly refuse
  // actor==target at the route layer as well as in the service functions
  // themselves (DUR-148).

  router.post(
    "/agents/:agentId/role/tools",
    scopeFromAgent(),
    validate(z.object({ tool: mcpServerConfigSchema })),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const { tool } = req.body as { tool: Record<string, unknown> };
      res.json(await addAgentToolOverride(db, agentId, tool, actorFor(req)));
    }
  );

  router.delete("/agents/:agentId/role/tools/:toolName", scopeFromAgent(), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await removeAgentToolOverride(db, agentId, req.params.toolName as string, actorFor(req)));
  });

  router.post(
    "/agents/:agentId/role/rights",
    scopeFromAgent(),
    validate(grantSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const grantedByUserId = (req as { actor?: { userId?: string | null } }).actor?.userId ?? null;
      const updated = await addAgentRightOverride(db, agentId, req.body, actorFor(req), grantedByUserId, rawDb);
      res.json(updated);
    }
  );

  router.delete("/agents/:agentId/role/rights/:permissionKey", scopeFromAgent(), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await removeAgentRightOverride(db, agentId, req.params.permissionKey as string, actorFor(req), rawDb));
  });

  // ── DUR-149: per-agent skill_key / connector_key overrides ──────────────
  // Same board-only, non-self shape as tools/rights above. `category` is
  // "skills" or "connectors" — validated in scopeFromAgentForCategory's
  // resolver (not the route path regex — Express 5's path-to-regexp doesn't
  // support the old inline-group syntax the same way v4 did) so a typo
  // 404s instead of silently no-op'ing inside the service.

  router.post(
    "/agents/:agentId/role/:category",
    scopeFromAgentForCategory(),
    validate(z.object({ key: catalogKeySchema })),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const category = parseCatalogCategory(req);
      const { key } = req.body as { key: string };
      res.json(await addAgentCatalogOverride(db, agentId, category, key, actorFor(req), rawDb));
    }
  );

  router.delete("/agents/:agentId/role/:category/:key", scopeFromAgentForCategory(), async (req, res) => {
    const agentId = req.params.agentId as string;
    const category = parseCatalogCategory(req);
    res.json(await removeAgentCatalogOverride(db, agentId, category, req.params.key as string, actorFor(req), rawDb));
  });

  return router;
}
