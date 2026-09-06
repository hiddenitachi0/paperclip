import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { companyScope } from "../middleware/company-scope.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function sidebarPreferenceRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): the `/sidebar-preferences/me` pair below has
  // no companyId at all (spans every company the board user belongs to) and
  // deliberately stays unscoped/bypass, per the DUR-277 design doc's §1
  // category-(c) note for this file. Only the `/companies/:companyId/...`
  // group below is scoped.
  const db = createRequestScopedDb(rawDb);
  const bypassSvc = sidebarPreferenceService(rawDb);
  const svc = sidebarPreferenceService(db);

  router.get("/sidebar-preferences/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await bypassSvc.getCompanyOrder(userId));
  });

  router.put("/sidebar-preferences/me", validate(upsertSidebarOrderPreferenceSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await bypassSvc.upsertCompanyOrder(userId, req.body.orderedIds));
  });

  router.get(
    "/companies/:companyId/sidebar-preferences/me",
    companyScope(rawDb, (req) => {
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = requireBoardUserId(req, res);
      if (!userId) return;
      res.json(await svc.getProjectOrder(companyId, userId));
    },
  );

  router.put(
    "/companies/:companyId/sidebar-preferences/me",
    companyScope(rawDb, (req) => {
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    validate(upsertSidebarOrderPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = requireBoardUserId(req, res);
      if (!userId) return;

      const result = await svc.upsertProjectOrder(companyId, userId, req.body.orderedIds);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "sidebar_preferences.project_order_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          userId,
          orderedIds: result.orderedIds,
        },
      });
      res.json(result);
    },
  );

  return router;
}
