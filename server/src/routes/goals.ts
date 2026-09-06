import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { trackGoalCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { notFound } from "../errors.js";

export function goalRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; the
  // raw `rawDb` stays unwrapped for the pre-scope lookups the (b)-category
  // routes below need before their companyId (and therefore their scope) is
  // known. See middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const svc = goalService(db);
  const rawSvc = goalService(rawDb);

  router.get("/companies/:companyId/goals", companyScopeFromParam(rawDb, assertCompanyAccess), async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get(
    "/goals/:id",
    companyScope(rawDb, async (req) => {
      const goal = await rawSvc.getById(req.params.id as string);
      if (!goal) throw notFound("Goal not found");
      assertCompanyAccess(req, goal.companyId);
      return goal.companyId;
    }),
    async (req, res) => {
      const id = req.params.id as string;
      const goal = await svc.getById(id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      res.json(goal);
    },
  );

  router.post("/companies/:companyId/goals", companyScopeFromParam(rawDb, assertCompanyAccess), validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    res.status(201).json(goal);
  });

  router.patch(
    "/goals/:id",
    companyScope(rawDb, async (req) => {
      const existing = await rawSvc.getById(req.params.id as string);
      if (!existing) throw notFound("Goal not found");
      assertCompanyAccess(req, existing.companyId);
      return existing.companyId;
    }),
    validate(updateGoalSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      const goal = await svc.update(id, req.body);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: goal.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "goal.updated",
        entityType: "goal",
        entityId: goal.id,
        details: req.body,
      });

      res.json(goal);
    },
  );

  router.delete(
    "/goals/:id",
    companyScope(rawDb, async (req) => {
      const existing = await rawSvc.getById(req.params.id as string);
      if (!existing) throw notFound("Goal not found");
      assertCompanyAccess(req, existing.companyId);
      return existing.companyId;
    }),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      const goal = await svc.remove(id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: goal.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "goal.deleted",
        entityType: "goal",
        entityId: goal.id,
      });

      res.json(goal);
    },
  );

  return router;
}
