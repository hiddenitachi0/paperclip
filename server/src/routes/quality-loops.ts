import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { updateCompanyQualityLoopSettingsSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { qualityLoopSettingsService } from "../services/quality-loops.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Agent quality loops settings (Company settings > Quality checks).
 *   GET   /companies/:companyId/quality-loops/settings  any active member
 *   PATCH /companies/:companyId/quality-loops/settings  owner/admin only
 * Agents are refused on both: an agent must not switch off the checks on its own work.
 */

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can change this.");
    }
  }
  assertCompanyAccess(req, companyId);
}

export function qualityLoopRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = qualityLoopSettingsService(db);

  function memberScope() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  function ownerOrAdminScope() {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId);
      return companyId;
    });
  }

  router.get("/companies/:companyId/quality-loops/settings", memberScope(), async (req, res) => {
    res.json(await svc.get(req.params.companyId as string));
  });

  router.patch(
    "/companies/:companyId/quality-loops/settings",
    ownerOrAdminScope(),
    validate(updateCompanyQualityLoopSettingsSchema),
    async (req, res) => {
      res.json(
        await svc.update(req.params.companyId as string, req.body, { userId: req.actor.userId ?? null }),
      );
    },
  );

  return router;
}
