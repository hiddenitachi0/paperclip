import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  // DUR-277: first route family wired through the request-scoped company
  // AsyncLocalStorage context (see middleware/company-scope.ts). `db` here
  // stays the raw pooled instance passed in from app.ts, unchanged; only
  // this route file's own service instance uses the scoped proxy.
  const svc = dashboardService(createRequestScopedDb(db));

  router.get("/companies/:companyId/dashboard", companyScopeFromParam(db), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  return router;
}
