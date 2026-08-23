// DUR-114: routes for company agent roles ("jobs") and role assignment.
// Board-only throughout — agents are structurally blocked from reaching these routes.
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { mcpServerConfigSchema } from "@paperclipai/shared/validators/agent";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  createRole,
  listRoles,
  getRole,
  updateRole,
  deleteRole,
  copyRoleToCompany,
  assignRoleToAgent,
} from "../services/agent-roles.js";

// Schema for the {permissionKey, scope} grant shape
const grantSchema = z.object({
  permissionKey: z.enum(PERMISSION_KEYS),
  scope: z.record(z.unknown()).nullable().optional().transform((v) => v ?? null),
});

const roleBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  defaultInstructions: z.string().max(100_000).nullable().optional(),
  defaultMcpServers: z.array(mcpServerConfigSchema).max(50).optional(),
  defaultGrants: z.array(grantSchema).max(50).optional(),
});

const roleUpdateSchema = roleBodySchema.partial();

export function agentRoleRoutes(db: Db) {
  const router = Router();

  // ── Company role CRUD ────────────────────────────────────────────────────

  // List all roles for a company
  router.get("/companies/:companyId/agent-roles", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(req, req.params.companyId!);
    const roles = await listRoles(db, req.params.companyId!);
    res.json(roles);
  });

  // Create a new role
  router.post(
    "/companies/:companyId/agent-roles",
    validate(roleBodySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);
      const role = await createRole(db, companyId, req.body);
      res.status(201).json(role);
    }
  );

  // Get a single role (no company check — the role row itself carries companyId,
  // and assertBoard is sufficient since roles are company-scoped read-only data)
  router.get("/agent-roles/:roleId", async (req, res) => {
    assertBoard(req);
    const role = await getRole(db, req.params.roleId!);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    await assertCompanyAccess(req, role.companyId);
    res.json(role);
  });

  // Update a role
  router.patch(
    "/agent-roles/:roleId",
    validate(roleUpdateSchema),
    async (req, res) => {
      assertBoard(req);
      const roleId = req.params.roleId as string;
      const existing = await getRole(db, roleId);
      if (!existing) {
        res.status(404).json({ error: "Role not found" });
        return;
      }
      await assertCompanyAccess(req, existing.companyId);
      const updated = await updateRole(db, roleId, req.body);
      res.json(updated);
    }
  );

  // Delete a role (ON DELETE SET NULL keeps agents intact)
  router.delete("/agent-roles/:roleId", async (req, res) => {
    assertBoard(req);
    const existing = await getRole(db, req.params.roleId!);
    if (!existing) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    await assertCompanyAccess(req, existing.companyId);
    await deleteRole(db, req.params.roleId!);
    res.status(204).send();
  });

  // Copy a role to another company
  router.post(
    "/agent-roles/:roleId/copy",
    validate(z.object({ targetCompanyId: z.string().uuid() })),
    async (req, res) => {
      assertBoard(req);
      const roleId = req.params.roleId as string;
      const existing = await getRole(db, roleId);
      if (!existing) {
        res.status(404).json({ error: "Role not found" });
        return;
      }
      await assertCompanyAccess(req, existing.companyId);
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
    validate(
      z.object({
        roleId: z.string().uuid().nullable(),
      })
    ),
    async (req, res) => {
      // Hard rule: board actors only. assertBoard rejects agent-authenticated requests.
      assertBoard(req);

      const agentId = req.params.agentId as string;
      const { roleId } = req.body as { roleId: string | null };

      // Load the agent to check company membership
      const [agent] = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCompanyAccess(req, agent.companyId);

      // If assigning a role (not clearing), verify role belongs to same company
      if (roleId !== null) {
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
      const updated = await assignRoleToAgent(db, agentId, roleId, { grantedByUserId });
      res.json(updated);
    }
  );

  // GET /agents/:id/role — return the agent's current role with override metadata
  router.get("/agents/:agentId/role", async (req, res) => {
    assertBoard(req);
    const { agentId } = req.params;

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId!));
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(req, agent.companyId);

    if (!agent.roleId) {
      res.json({ role: null, overrides: null });
      return;
    }

    const role = await getRole(db, agent.roleId);
    if (!role) {
      res.json({ role: null, overrides: null });
      return;
    }

    // Compute MCP server override diff: which names were added or removed vs snapshot
    const appliedNames = new Set<string>(
      (agent.roleAppliedMcpServerNames as string[] | null) ?? []
    );
    const currentConfig = agent.adapterConfig as Record<string, unknown> ?? {};
    const currentMcpServers = (currentConfig.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
    const currentNames = new Set(currentMcpServers.map((s) => String(s.name ?? "")));

    const mcpOverrides = {
      added: currentMcpServers
        .filter((s) => !appliedNames.has(String(s.name ?? "")))
        .map((s) => s.name),
      removed: [...appliedNames].filter((n) => !currentNames.has(n)),
    };

    // Compute permission grant override diff
    const appliedKeys = new Set<string>(
      (agent.roleAppliedPermissionKeys as string[] | null) ?? []
    );
    // Live grants are fetched by the caller from the permissions API; here we
    // just report what was applied from the role so the UI can compute diffs.
    const permissionOverrides = {
      appliedKeys: [...appliedKeys],
    };

    res.json({
      role,
      appliedMcpServerNames: [...appliedNames],
      appliedPermissionKeys: [...appliedKeys],
      mcpOverrides,
      permissionOverrides,
    });
  });

  return router;
}
