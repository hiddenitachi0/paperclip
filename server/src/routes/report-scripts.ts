import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  approveReportScriptVersionSchema,
  createReportFixtureSchema,
  createReportScriptSchema,
  createReportScriptVersionSchema,
  runReportScriptFixtureSchema,
} from "@paperclipai/shared";
import { HttpError, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyAccess, assertCompanyOwnerOrInstanceAdmin, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { reportScriptsService, type ReportScriptsServiceDeps } from "../services/report-scripts.js";

/**
 * DUR-4072 PR1: report calculation scripts.
 *
 * Who may do what (least privilege):
 *   * an agent of the company, or a board member of it, can see scripts and
 *     can draft: create a script, add a version, add a fixture, run a
 *     fixture. A draft can never feed a report -- nothing runs outside a
 *     fixture test until a version is approved.
 *   * only the company owner or an instance admin can approve a version, and
 *     only after every fixture of it passed. Agents and tokens are refused;
 *     this is the "never live without Filip's approval" step.
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
      assertCompanyOwnerOrInstanceAdmin(req, companyId, "report scripts");
    });

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

  const base = "/companies/:companyId/report-scripts";

  router.get(base, draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listScripts(req.params.companyId as string));
  });

  router.post(base, validate(createReportScriptSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createScript(companyId, req.body, actorOf(req));
    await audit(req, companyId, "report_script.created", created.id, { key: created.key, name: created.name });
    res.status(201).json(created);
  });

  router.get(`${base}/:scriptId/versions`, draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listVersions(req.params.companyId as string, req.params.scriptId as string));
  });

  router.post(`${base}/:scriptId/versions`, validate(createReportScriptVersionSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createVersion(companyId, req.params.scriptId as string, req.body, actorOf(req));
    await audit(req, companyId, "report_script.version_created", created.scriptId, {
      versionId: created.id,
      versionNo: created.versionNo,
      sha256: created.sha256,
    });
    res.status(201).json(created);
  });

  router.get(`${base}/versions/:versionId/fixtures`, draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listFixtures(req.params.companyId as string, req.params.versionId as string));
  });

  router.post(`${base}/versions/:versionId/fixtures`, validate(createReportFixtureSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const created = await svc.createFixture(req.params.companyId as string, req.params.versionId as string, req.body);
    res.status(201).json(created);
  });

  router.post(`${base}/versions/:versionId/run-fixture`, validate(runReportScriptFixtureSchema), draftScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const versionId = req.params.versionId as string;
    const run = await svc.runFixture(companyId, versionId, req.body.fixtureId, actorOf(req));
    await audit(req, companyId, "report_script.fixture_run", versionId, { runId: run.id, status: run.status });
    res.json(run);
  });

  router.get(`${base}/versions/:versionId/runs`, draftScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listRuns(req.params.companyId as string, req.params.versionId as string));
  });

  router.post(`${base}/versions/:versionId/approve`, validate(approveReportScriptVersionSchema), approveScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const info = getActorInfo(req);
    if (info.actorType !== "user") throw forbidden("Only a person can approve a script version.");
    const approved = await svc.approveVersion(companyId, req.params.versionId as string, { userId: info.actorId });
    await audit(req, companyId, "report_script.version_approved", approved.scriptId, {
      versionId: approved.id,
      versionNo: approved.versionNo,
      sha256: approved.sha256,
    });
    res.json(approved);
  });

  return router;
}
