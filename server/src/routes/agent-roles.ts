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

export function agentRoleRoutes(rawDb: Db) {
  const router = Router();
  // DUR-394 (DUR-277 Wave 3): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope role/agent lookups below (see
  // middleware/company-scope.ts).
  const db = createRequestScopedDb(rawDb);

  /** Resolve `req.params[paramName]` to a role, assert access, then scope. */
  function scopeFromRoleParam(paramName: string = "roleId") {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const roleId = req.params[paramName] as string;
      const role = await getRole(rawDb, roleId);
      if (!role) throw notFound("Role not found");
      await assertCompanyAccess(req, role.companyId);
      return role.companyId;
    });
  }

  /**
   * Resolve `req.params.agentId` to an agent, assert access, then scope.
   * `refuseSelf` mirrors the per-handler `assertNotSelfRoleMutation` calls
   * this replaces -- true for every role-mutating route, false for the
   * read-only GET (an agent may read its own role state).
   */
  function scopeFromAgentIdParam(refuseSelf: boolean) {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      if (refuseSelf) assertNotSelfRoleMutation(req, agentId);
      const [agent] = await rawDb
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) throw notFound("Agent not found");
      await assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  // ── Company role CRUD ────────────────────────────────────────────────────

  // List all roles for a company
  router.get(
    "/companies/:companyId/agent-roles",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      return assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const roles = await listRoles(db, req.params.companyId as string);
      res.json(roles);
    },
  );

  // Create a new role
  router.post(
    "/companies/:companyId/agent-roles",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      return assertCompanyAccess(req, companyId);
    }),
    validate(roleBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const role = await createRole(db, companyId, req.body);
      res.status(201).json(role);
    }
  );

  // Get a single role (no company check — the role row itself carries companyId,
  // and assertBoard is sufficient since roles are company-scoped read-only data)
  router.get("/agent-roles/:roleId", scopeFromRoleParam(), async (req, res) => {
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
    scopeFromRoleParam(),
    validate(roleUpdateSchema),
    async (req, res) => {
      const roleId = req.params.roleId as string;
      const updated = await updateRole(db, roleId, req.body);
      res.json(updated);
    }
  );

  // Delete a role (ON DELETE SET NULL keeps agents intact)
  router.delete("/agent-roles/:roleId", scopeFromRoleParam(), async (req, res) => {
    await deleteRole(db, req.params.roleId as string);
    res.status(204).send();
  });

  // Copy a role to another company. Deliberately left on the raw,
  // request-unscoped `db` (like DUR-348's execution-workspaces.ts/projects.ts
  // carve-outs) -- this is a genuine two-company operation (reads the source
  // role in one company, inserts a new role in another), which a single
  // `runInCompanyScope(companyId)` call cannot cover: RLS only admits rows
  // for the one company_id set on the session claim, so scoping to either
  // side would make the other side's query return nothing / fail to insert.
  // Both companies' access are still explicitly checked below before any
  // data is read or written. Tracked as a DUR-394 follow-up to give this one
  // route its own design pass (e.g. two sequential single-company scopes, or
  // a narrowly-reasoned runInCompanyScopeBypass) rather than bolting on a
  // bypass here without that review.
  router.post(
    "/agent-roles/:roleId/copy",
    validate(z.object({ targetCompanyId: z.string().uuid() })),
    async (req, res) => {
      assertBoard(req);
      const roleId = req.params.roleId as string;
      const existing = await getRole(rawDb, roleId);
      if (!existing) {
        res.status(404).json({ error: "Role not found" });
        return;
      }
      await assertCompanyAccess(req, existing.companyId);
      await assertCompanyAccess(req, req.body.targetCompanyId);
      const copied = await copyRoleToCompany(rawDb, roleId, req.body.targetCompanyId);
      res.status(201).json(copied);
    }
  );

  // ── Role assignment on agents ────────────────────────────────────────────
  // POST /agents/:id/role  — board-only, never allow_self
  // An agent can never call this endpoint even if it holds permission grants.

  router.post(
    "/agents/:agentId/role",
    scopeFromAgentIdParam(true),
    validate(
      z.object({
        roleId: z.string().uuid().nullable(),
      })
    ),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const { roleId } = req.body as { roleId: string | null };

      // If assigning a role (not clearing), verify role belongs to same company
      if (roleId !== null) {
        const role = await getRole(db, roleId);
        if (!role) {
          res.status(404).json({ error: "Role not found" });
          return;
        }
      }

      const grantedByUserId = (req as { actor?: { userId?: string | null } }).actor?.userId ?? null;
      const updated = await assignRoleToAgent(db, agentId, roleId, { grantedByUserId, actor: actorFor(req) });
      res.json(updated);
    }
  );

  // GET /agents/:id/role — return the agent's current role plus tool/right
  // overrides, in the AgentRoleState shape the UI (ui/src/api/jobs.ts) expects.
  // No role assigned is the normal case (all 22 live agents at the time of
  // DUR-142), so this always returns the full shape with empty arrays rather
  // than a shorter "no role" variant the UI was never built to read.
  router.get("/agents/:agentId/role", scopeFromAgentIdParam(false), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await getAgentRoleState(db, agentId));
  });

  // ── Per-agent tool/right overrides on top of an assigned job ────────────
  // Board-only, and — like POST /agents/:id/role above — explicitly refuse
  // actor==target at the route layer as well as in the service functions
  // themselves (DUR-148).

  router.post(
    "/agents/:agentId/role/tools",
    scopeFromAgentIdParam(true),
    validate(z.object({ tool: mcpServerConfigSchema })),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const { tool } = req.body as { tool: Record<string, unknown> };
      res.json(await addAgentToolOverride(db, agentId, tool, actorFor(req)));
    }
  );

  router.delete("/agents/:agentId/role/tools/:toolName", scopeFromAgentIdParam(true), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await removeAgentToolOverride(db, agentId, req.params.toolName as string, actorFor(req)));
  });

  router.post(
    "/agents/:agentId/role/rights",
    scopeFromAgentIdParam(true),
    validate(grantSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const grantedByUserId = (req as { actor?: { userId?: string | null } }).actor?.userId ?? null;
      const updated = await addAgentRightOverride(db, agentId, req.body, actorFor(req), grantedByUserId);
      res.json(updated);
    }
  );

  router.delete("/agents/:agentId/role/rights/:permissionKey", scopeFromAgentIdParam(true), async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await removeAgentRightOverride(db, agentId, req.params.permissionKey as string, actorFor(req)));
  });

  // ── DUR-149: per-agent skill_key / connector_key overrides ──────────────
  // Same board-only, non-self shape as tools/rights above. `category` is
  // "skills" or "connectors" — validated in the handler (not the route path
  // regex — Express 5's path-to-regexp doesn't support the old inline-group
  // syntax the same way v4 did) so a typo 404s instead of silently no-op'ing
  // inside the service.
  const catalogCategorySchema = z.enum(["skills", "connectors"]);

  function parseCatalogCategory(req: Request, res: any): "skills" | "connectors" | null {
    const parsed = catalogCategorySchema.safeParse(req.params.category);
    if (!parsed.success) {
      res.status(404).json({ error: "Unknown override category" });
      return null;
    }
    return parsed.data;
  }

  router.post(
    "/agents/:agentId/role/:category",
    scopeFromAgentIdParam(true),
    validate(z.object({ key: catalogKeySchema })),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const category = parseCatalogCategory(req, res);
      if (!category) return;

      const { key } = req.body as { key: string };
      res.json(await addAgentCatalogOverride(db, agentId, category, key, actorFor(req)));
    }
  );

  router.delete("/agents/:agentId/role/:category/:key", scopeFromAgentIdParam(true), async (req, res) => {
    const agentId = req.params.agentId as string;
    const category = parseCatalogCategory(req, res);
    if (!category) return;

    res.json(await removeAgentCatalogOverride(db, agentId, category, req.params.key as string, actorFor(req)));
  });

  return router;
}
