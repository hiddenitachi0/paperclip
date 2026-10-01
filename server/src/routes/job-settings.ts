import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";
import { companyJobSettingsService } from "../services/company-job-settings.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4182: the company-level Jobs feature flag. Same owner/admin bar as
 * payment-settings.ts's booking kill switch -- any board member can see
 * whether Jobs is on, only an owner/admin can flip it.
 */
export function jobSettingsRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const settings = companyJobSettingsService(db);

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
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
        const role = membership?.status === "active" ? membership.membershipRole : null;
        if (role !== "owner" && role !== "admin") {
          throw forbidden("Only a company owner or admin can change Jobs settings. You can see them, but not change them.");
        }
      }
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  router.get("/companies/:companyId/job-settings", memberScope(), async (req, res) => {
    res.json(await settings.get(req.params.companyId as string));
  });

  router.put("/companies/:companyId/job-settings/jobs-enabled", ownerOrAdminScope(), async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") throw badRequest("Body must be { enabled: boolean }");
    const companyId = req.params.companyId as string;
    const result = await settings.setJobsEnabled(companyId, enabled);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.job_settings_updated",
      entityType: "company_job_settings",
      entityId: companyId,
      details: { jobsEnabled: enabled },
    });
    res.json(result);
  });

  return router;
}
