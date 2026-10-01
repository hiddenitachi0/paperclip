import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { readDeployRunnerStatus } from "../services/deploy-runner-status.js";
import {
  parseDateBoundary,
  readProjectDeployHistory,
  readProjectDeployHistoryList,
  type ProjectDeployHistoryStatus,
} from "../services/deploy-history.js";

const DEFAULT_LIST_LIMIT = 20;

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
  //
  // DUR-4271: `current`/`previous`/`releases` stay exactly as they were (the
  // existing rollback card depends on that shape and ignores every filter),
  // and the new `status`/`from`/`to`/`limit`/`offset` query params drive two
  // additive fields, `entries`/`pagination`, for the history page -- pass AND
  // fail attempts, paged, still bounded by the project's release-retention
  // count as a hard ceiling.
  router.get(
    "/companies/:companyId/projects/:projectId/deploy-history",
    companyScopeFromParam(db, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;

      const statusParam = req.query.status;
      let status: ProjectDeployHistoryStatus | undefined;
      if (statusParam !== undefined) {
        if (statusParam !== "pass" && statusParam !== "fail") {
          res.status(400).json({ error: "status must be \"pass\" or \"fail\"." });
          return;
        }
        status = statusParam;
      }

      let fromMs: number | undefined;
      if (typeof req.query.from === "string" && req.query.from.length > 0) {
        const parsed = parseDateBoundary(req.query.from, false);
        if (parsed === null) {
          res.status(400).json({ error: "from must be a valid date or ISO timestamp." });
          return;
        }
        fromMs = parsed;
      }

      let toMs: number | undefined;
      if (typeof req.query.to === "string" && req.query.to.length > 0) {
        const parsed = parseDateBoundary(req.query.to, true);
        if (parsed === null) {
          res.status(400).json({ error: "to must be a valid date or ISO timestamp." });
          return;
        }
        toMs = parsed;
      }

      const limitParam = Number.parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIST_LIMIT;

      const offsetParam = Number.parseInt(String(req.query.offset ?? ""), 10);
      const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

      const [history, list] = await Promise.all([
        readProjectDeployHistory(scopedDb, companyId, projectId),
        readProjectDeployHistoryList(scopedDb, companyId, projectId, { status, fromMs, toMs }, { limit, offset }),
      ]);

      res.json({
        ...history,
        entries: list.items,
        pagination: { limit: list.limit, offset: list.offset, total: list.total, hasMore: list.hasMore },
      });
    },
  );

  return router;
}
