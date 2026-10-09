import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  approveReportScriptVersionSchema,
  createReportFixtureSchema,
  createReportScriptSchema,
  createReportScriptVersionSchema,
  requestReportScriptApprovalSchema,
  runReportScriptFixtureSchema,
} from "@paperclipai/shared";
import { HttpError, forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin, getActorInfo } from "./authz.js";
import { approvalService, logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { reportScriptsService, type ReportScriptsServiceDeps } from "../services/report-scripts.js";

/**
 * DUR-4072 PR1: report calculation scripts.
 *
 * Who may do what (least privilege):
 *   * an agent of the company, or a board member of it, can see scripts and
 *     can DRAFT: create a script, add a version, add saved examples
 *     (fixtures) and ask for approval. Drafting never runs any code -- not
 *     even a fixture test.
 *   * only a person who is the company's owner/admin (or an instance admin)
 *     can approve a version, naming the exact digest shown on its approval
 *     card. The approve action is the first time the code runs: it runs every
 *     fixture and switches the version on only if all of them match.
 *   * fixtures of an APPROVED version can be re-run by agents/members.
 *
 * Approved scripts run with the server's own privileges (see
 * services/report-script-runner.ts) -- approval means trusting the code.
 *
 * Switched off by default: until `enableReporting` is on, every route answers
 * 404 with a plain sentence (after the actor check, so an agent is refused
 * the same way either way).
 */
export function reportScriptRoutes(rawDb: Db, deps: ReportScriptsServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = reportScriptsService(db, deps);
  const instanceSettings = instanceSettingsService(rawDb);

  const draftScope = () =>
    companyScopeFromParam(rawDb, (req, companyId) => {
      if (req.actor.type !== "agent" && req.actor.type !== "board") {
        throw forbidden("Only a board member or an agent of this company can use report scripts.");
      }
      assertCompanyAccess(req, companyId);
    });
  const approveScope = () =>
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "report calculations");
    });
  const approvals = approvalService(db);

  async function requireFeatureOn(_req: Request, _res: Response, next: NextFunction) {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableReporting) {
      throw new HttpError(
        404,
        "Reports are not switched on for this Paperclip instance. An administrator can switch them on under Instance settings → Experimental.",
        { code: "reporting_disabled" },
      );
    }
    next();
  }

  function actorOf(req: Request) {
    const info = getActorInfo(req);
    return info.actorType === "agent"
      ? { agentId: info.agentId ?? undefined, runId: info.runId ?? undefined }
      : { userId: info.actorId, runId: info.runId ?? undefined };
  }

  async function audit(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const info = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: info.actorType,
      actorId: info.actorId,
      agentId: info.agentId,
      runId: info.runId,
      action,
      entityType: "report_script",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/report-scripts", draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listScripts(req.params.companyId as string));
  });

  router.post("/companies/:companyId/report-scripts", validate(createReportScriptSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createScript(companyId, req.body, actorOf(req));
    await audit(req, companyId, "report_script.created", created.id, { key: created.key, name: created.name });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/report-scripts/:scriptId/versions", draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listVersions(req.params.companyId as string, req.params.scriptId as string));
  });

  router.post("/companies/:companyId/report-scripts/:scriptId/versions", validate(createReportScriptVersionSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createVersion(companyId, req.params.scriptId as string, req.body, actorOf(req));
    await audit(req, companyId, "report_script.version_created", created.scriptId, {
      versionId: created.id,
      versionNo: created.versionNo,
      sha256: created.sha256,
    });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/report-scripts/versions/:versionId/fixtures", draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listFixtures(req.params.companyId as string, req.params.versionId as string));
  });

  router.post("/companies/:companyId/report-scripts/versions/:versionId/fixtures", validate(createReportFixtureSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const created = await svc.createFixture(req.params.companyId as string, req.params.versionId as string, req.body);
    res.status(201).json(created);
  });

  router.post("/companies/:companyId/report-scripts/versions/:versionId/run-fixture", validate(runReportScriptFixtureSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const versionId = req.params.versionId as string;
    const run = await svc.runFixture(companyId, versionId, req.body.fixtureId, actorOf(req));
    await audit(req, companyId, "report_script.fixture_run", versionId, { runId: run.id, status: run.status });
    res.json(run);
  });

  router.get("/companies/:companyId/report-scripts/versions/:versionId/runs", draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listRuns(req.params.companyId as string, req.params.versionId as string));
  });

  router.post("/companies/:companyId/report-scripts/versions/:versionId/request-approval",
    validate(requestReportScriptApprovalSchema),
    draftScope(),
    requireFeatureOn,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const versionId = req.params.versionId as string;
      const result = await svc.requestApproval(companyId, versionId, actorOf(req), req.body.note);
      await audit(req, companyId, "report_script.approval_requested", result.version.scriptId, {
        versionId,
        approvalId: result.approvalId,
        sha256: result.version.sha256,
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/report-scripts/versions/:versionId/approve", validate(approveReportScriptVersionSchema), approveScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const versionId = req.params.versionId as string;
    const info = getActorInfo(req);
    if (info.actorType !== "user") throw forbidden("Only a person can approve a report calculation.");
    const outcome = await svc.approveVersion(companyId, versionId, { userId: info.actorId, sha256: req.body.sha256 });
    await audit(req, companyId, outcome.approved ? "report_script.version_approved" : "report_script.approval_checks_failed", outcome.version.scriptId, {
      versionId,
      versionNo: outcome.version.versionNo,
      sha256: outcome.version.sha256,
      fixturesPassed: outcome.fixtureResults.filter((r) => r.ok).length,
      fixturesRun: outcome.fixtureResults.length,
    });
    if (!outcome.approved) {
      throw unprocessable(outcome.message ?? "The saved examples did not all match, so nothing was switched on.", {
        code: "report_script_fixtures_failed",
        fixtureResults: outcome.fixtureResults,
      });
    }
    // Close the card too (the approvals service re-checks that the version
    // is approved with the card's digest before it lets the card close).
    if (outcome.version.approvalId) {
      const card = await approvals.getById(outcome.version.approvalId);
      if (card && (card.status === "pending" || card.status === "revision_requested")) {
        await approvals.approve(card.id, info.actorId, req.body.decisionNote ?? null);
      }
    }
    res.json(outcome);
  });

  return router;
}
