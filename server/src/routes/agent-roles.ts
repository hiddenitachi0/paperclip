import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  assignAgentRoleSchema,
  createAgentRoleSchema,
  duplicateAgentRoleSchema,
  updateAgentRoleSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentRoleService, agentService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound } from "../errors.js";

export function agentRoleRoutes(db: Db) {
  const router = Router();
  const roles = agentRoleService(db);
  const agents = agentService(db);

  // DUR-114: role definitions (CRUD, duplication) and role assignment are
  // both board-only in v1 -- an agent may never assign a role, its own or
  // anyone else's, and no agent-held permission grant changes that. See the
  // hard rules in DUR-114/DUR-65.
  router.get("/companies/:companyId/agent-roles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await roles.list(companyId));
  });

  router.post("/companies/:companyId/agent-roles", validate(createAgentRoleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const created = await roles.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_role.created",
      entityType: "company_agent_role",
      entityId: created.id,
      details: { name: created.name },
    });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/agent-roles/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const role = await roles.getById(companyId, id);
    if (!role) throw notFound("Role not found");
    res.json(role);
  });

  router.patch("/companies/:companyId/agent-roles/:id", validate(updateAgentRoleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const updated = await roles.update(companyId, id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_role.updated",
      entityType: "company_agent_role",
      entityId: updated.id,
      details: { changedKeys: Object.keys(req.body) },
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/agent-roles/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    await roles.remove(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_role.deleted",
      entityType: "company_agent_role",
      entityId: id,
    });
    res.status(204).end();
  });

  // Roles are copyable to a new company (Filip is creating more companies
  // and doesn't want to rebuild the same jobs each time) -- a simple
  // duplicate-into-target-company operation, no cross-company live-linking.
  router.post(
    "/companies/:companyId/agent-roles/:id/duplicate",
    validate(duplicateAgentRoleSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const targetCompanyId = req.body.targetCompanyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      assertCompanyAccess(req, targetCompanyId);
      const created = await roles.duplicateToCompany(companyId, id, targetCompanyId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: targetCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent_role.duplicated",
        entityType: "company_agent_role",
        entityId: created.id,
        details: { sourceRoleId: id, sourceCompanyId: companyId },
      });
      res.status(201).json(created);
    },
  );

  function assertNotSelfAssignment(req: Request, targetAgentId: string) {
    const actorAgentId = req.actor.type === "agent" ? req.actor.agentId : null;
    if (actorAgentId && actorAgentId === targetAgentId) {
      throw forbidden("Agents cannot assign their own role");
    }
  }

  router.post("/agents/:id/role", validate(assignAgentRoleSchema), async (req, res) => {
    const id = req.params.id as string;
    // Board-only, full stop -- deliberately does NOT reuse
    // assertCanUpdateAgent/agent_config:update, whose `allow_self` decision
    // would authorize an agent to hit this route for its own record. See
    // DUR-114's hard rule: allow_self must never reach role assignment.
    assertBoard(req);
    assertNotSelfAssignment(req, id);

    const existing = await agents.getById(id);
    if (!existing) throw notFound("Agent not found");
    assertCompanyAccess(req, existing.companyId);

    const actor = getActorInfo(req);
    const { agent: updated, warnings } = await roles.assign(
      existing.companyId,
      id,
      req.body.roleId,
      { userId: actor.actorType === "user" ? actor.actorId : null },
    );
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent.role_assigned",
      entityType: "agent",
      entityId: id,
      details: { roleId: req.body.roleId, warnings },
    });
    res.json({ agent: updated, warnings });
  });

  router.get("/agents/:id/role-overrides", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const existing = await agents.getById(id);
    if (!existing) throw notFound("Agent not found");
    assertCompanyAccess(req, existing.companyId);
    res.json(await roles.getOverrides(existing.companyId, id));
  });

  return router;
}
