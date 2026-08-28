import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

// DUR-312: read-only "what shipped" list for the operator -- separate from
// the approval queue on purpose (nothing here needs a decision). One row per
// fixed bug/small change, not per commit; see issueService.listChangeLog for
// the query and the changeLogVisible/changeLogSummary fields on the issues
// table for how a row gets in here.
export function changeLogRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);

  router.get("/companies/:companyId/change-log", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectIdRaw = req.query.projectId;
    if (projectIdRaw !== undefined && typeof projectIdRaw !== "string") {
      res.status(400).json({ error: "projectId must be a string" });
      return;
    }

    const daysRaw = req.query.days;
    let days: number | undefined;
    if (daysRaw !== undefined) {
      if (typeof daysRaw !== "string" || !/^\d+$/.test(daysRaw)) {
        res.status(400).json({ error: "days must be a positive integer" });
        return;
      }
      days = Number.parseInt(daysRaw, 10);
    }

    const limitRaw = req.query.limit;
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (typeof limitRaw !== "string" || !/^\d+$/.test(limitRaw)) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Number.parseInt(limitRaw, 10);
    }

    const entries = await svc.listChangeLog(companyId, {
      projectId: projectIdRaw ?? null,
      days,
      limit,
    });
    res.json(entries);
  });

  return router;
}
