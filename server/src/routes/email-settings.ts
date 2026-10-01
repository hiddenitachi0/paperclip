import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { updateEmailSettingsSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { emailSettingsService } from "../services/email/settings.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Email UI settings (DUR-4277): the per-company on/off switch that gates the
 * email frontend (DUR-4195).
 *
 * Who may do what, same shape as product-grabber.ts:
 *   * any active member of the company (board) can read the setting;
 *   * only the company's owner or admin (or an instance admin, or the local
 *     single-user board) can turn the feature on/off.
 * Agents are refused on both routes -- this is an operator-facing switch.
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

export function emailSettingsRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = emailSettingsService(db);

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

  router.get("/companies/:companyId/email/settings", memberScope(), async (req, res) => {
    res.json(await svc.get(req.params.companyId as string));
  });

  router.patch(
    "/companies/:companyId/email/settings",
    ownerOrAdminScope(),
    validate(updateEmailSettingsSchema),
    async (req, res) => {
      res.json(await svc.setEnabled(req.params.companyId as string, req.body.enabled));
    },
  );

  return router;
}
