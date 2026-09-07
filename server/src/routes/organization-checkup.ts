import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { organizationCheckupService } from "../services/organization-checkup.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * DUR-62: "Run a check-up now".
 *
 * Board-only. Works even when the scheduled check-up is switched off, so the
 * operator can preview what it would say on one company before turning it on
 * anywhere. `dryRun: true` returns the rendered report without writing it.
 *
 * It skips the interval check but still respects "one open check-up per
 * company": if one is already open, it hands that one back and says so.
 */

const runCheckupSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

function describeOutcome(result: { outcome: string; existingReportCreatedAt: Date | null; findings: unknown[] }) {
  if (result.outcome === "dry_run") {
    return result.findings.length === 0
      ? "Nothing needs your attention. This was a preview; no report was written."
      : `Found ${result.findings.length === 1 ? "one thing" : `${result.findings.length} things`} to look at. This was a preview; no report was written.`;
  }
  if (result.outcome === "existing") {
    const when = result.existingReportCreatedAt ? result.existingReportCreatedAt.toISOString().slice(0, 10) : "earlier";
    return `This is the check-up from ${when}; nothing new is written while it is still open. Close it to get a fresh one.`;
  }
  return result.findings.length === 0
    ? "Nothing needs your attention. The check-up has been filed as a record."
    : `Found ${result.findings.length === 1 ? "one thing" : `${result.findings.length} things`} to look at.`;
}

export function organizationCheckupRoutes(db: Db, opts: { intervalDays?: number } = {}) {
  const router = Router();
  const svc = organizationCheckupService(createRequestScopedDb(db));

  router.post(
    "/companies/:companyId/checkups/run",
    companyScopeFromParam(db),
    validate(runCheckupSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const result = await svc.runCheckup({
        companyId,
        dryRun: req.body.dryRun === true,
        intervalDays: opts.intervalDays,
      });
      res.status(result.outcome === "created" ? 201 : 200).json({
        outcome: result.outcome,
        dryRun: result.dryRun,
        reportIssueId: result.reportIssueId,
        reportIdentifier: result.reportIdentifier,
        message: describeOutcome(result),
        title: result.title,
        body: result.body,
        findingCount: result.findings.length,
        findings: result.findings.map((finding) => ({
          fingerprint: finding.fingerprint,
          severity: finding.severity,
          headline: finding.headline,
          suggestion: finding.suggestion,
        })),
      });
    },
  );

  router.get("/companies/:companyId/checkups/latest", companyScopeFromParam(db), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const open = await svc.findOpenCheckup(companyId);
    if (!open) {
      res.json({ report: null });
      return;
    }
    res.json({
      report: {
        id: open.id,
        identifier: open.identifier,
        title: open.title,
        status: open.status,
        createdAt: open.createdAt,
      },
    });
  });

  return router;
}
