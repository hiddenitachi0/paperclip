import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { ackMorningReportOutboxSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { morningReportService, type MorningReportServiceDeps } from "../services/morning-report.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Morning report: the one call the host-side Telegram bridge makes to
 * deliver the daily briefing (settings themselves are on the agent row —
 * see the QUICK_AGENT_FIELDS guard in routes/agents.ts).
 *
 * The outbox and its acknowledgement are board-only, the same as the
 * watcher outbox: the Telegram bridge signs in with the operator's board
 * credential through the on-box CLI. Agents are refused.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

export function morningReportRoutes(rawDb: Db, deps: MorningReportServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = morningReportService(db, deps);

  function memberScope() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  router.get("/companies/:companyId/morning-report-outbox", memberScope(), async (req, res) => {
    res.json({ reports: await svc.outbox(req.params.companyId as string) });
  });

  router.post(
    "/companies/:companyId/morning-report-outbox/:reportId/ack",
    memberScope(),
    validate(ackMorningReportOutboxSchema),
    async (req, res) => {
      res.json(await svc.ack(req.params.companyId as string, idParam(req, "reportId", "report"), req.body));
    },
  );

  return router;
}
