import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { readDeployRunnerStatus } from "../services/deploy-runner-status.js";

// Read-only view of scripts/deploy-runner.sh's activity feed (DUR-44), so an
// agent or operator without host/docker access can tell whether a deploy
// approval was ever processed without reading deploy-runner.log by hand.
export function deployRunnerRoutes(_db: Db) {
  const router = Router();

  router.get("/companies/:companyId/deploy-runner/status", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitParam = Number.parseInt(String(req.query.limit ?? ""), 10);
    const entries = readDeployRunnerStatus(companyId, Number.isFinite(limitParam) ? limitParam : undefined);
    res.json({ entries });
  });

  return router;
}
