import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { updateSecurityReviewSettingsSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { securityReviewSettingsService } from "../services/security-review-settings.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * DUR-4566: the per-company "which agent is the security reviewer" setting.
 * Same who-may-do-what shape as email-settings.ts -- any active member can
 * read it, only the company's owner/admin (or instance admin, or the local
 * single-user board) can change it. Agents are refused on both routes; this
 * is an operator-facing choice, not something an agent should set for itself.
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

export function securityReviewSettingsRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = securityReviewSettingsService(db);

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

  router.get("/companies/:companyId/security-review/settings", memberScope(), async (req, res) => {
    res.json(await svc.get(req.params.companyId as string));
  });

  router.patch(
    "/companies/:companyId/security-review/settings",
    ownerOrAdminScope(),
    validate(updateSecurityReviewSettingsSchema),
    async (req, res) => {
      res.json(
        await svc.setReviewerAgentId(req.params.companyId as string, req.body.securityReviewerAgentId),
      );
    },
  );

  return router;
}
