import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { readDeployRunnerStatus } from "../services/deploy-runner-status.js";
import { readProjectDeployHistory } from "../services/deploy-history.js";

// Read-only view of scripts/deploy-runner.sh's activity feed (DUR-44), so an
// agent or operator without host/docker access can tell whether a deploy
// approval was ever processed without reading deploy-runner.log by hand.
export function deployRunnerRoutes(db: Db) {
  const router = Router();
  // DUR-277 pattern: every DB read on this router goes through the request's
  // company scope (companyScopeFromParam below), never the raw pooled db.
  const scopedDb = createRequestScopedDb(db);

  router.get("/companies/:companyId/deploy-runner/status", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitParam = Number.parseInt(String(req.query.limit ?? ""), 10);
    const entries = readDeployRunnerStatus(companyId, Number.isFinite(limitParam) ? limitParam : undefined);
    res.json({ entries });
  });

  // DUR-3952 follow-up: the last two versions the runner actually put live for
  // a project -- what the project page's "Roll back to previous version"
  // button needs to file a rollback card for the right commit.
  router.get(
    "/companies/:companyId/projects/:projectId/deploy-history",
    companyScopeFromParam(db, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;

      const history = await readProjectDeployHistory(scopedDb, companyId, projectId);
      res.json(history);
    },
  );

  return router;
}
