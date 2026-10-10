import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createReportRunSchema,
  createReportTemplateSchema,
  draftReportRunCommentarySchema,
  previewReportDataSchema,
  updateReportTemplateSchema,
} from "@paperclipai/shared";
import { HttpError, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyAccess, getActorInfo, isCompanyOwnerOrAdmin } from "./authz.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { reportTemplatesService } from "../services/report-templates.js";
import { reportRunsService, type ReportRunsServiceDeps } from "../services/report-runs.js";
import { reportScriptsService } from "../services/report-scripts.js";
import { reportDataService } from "../services/report-data.js";

/**
 * DUR-4072 PR2: report templates and report runs. Same actor rule as PR1's
 * report-scripts routes -- any agent or board member of the company can
 * draft a template, start a run and draft its commentary; only a company
 * owner/admin (a person) can switch a template ON (drafts start off); nothing here can
 * approve a script version (that stays PR1's board-owner-only route).
 * Switched off behind the same `enableReporting` flag as PR1.
 */
export function reportTemplateRoutes(rawDb: Db, deps: Partial<ReportRunsServiceDeps> = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const templatesSvc = reportTemplatesService(db);
  const scriptsSvc = deps.reportScripts ? undefined : reportScriptsService(db);
  const runsSvc = reportRunsService(db, { reportScripts: deps.reportScripts ?? scriptsSvc!, fetchData: deps.fetchData, dataDeps: deps.dataDeps });
  const dataSvc = reportDataService(db, deps.dataDeps);
  const instanceSettings = instanceSettingsService(rawDb);

  const memberScope = () =>
    companyScopeFromParam(rawDb, (req, companyId) => {
      if (req.actor.type !== "agent" && req.actor.type !== "board") {
        throw forbidden("Only a board member or an agent of this company can use report templates.");
      }
      assertCompanyAccess(req, companyId);
    });

  async function requireFeatureOn(_req: Request, _res: Response, next: NextFunction) {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableReporting) {
      throw new HttpError(404, "Reports are not switched on for this Paperclip instance. An administrator can switch them on under Instance settings → Experimental.", {
        code: "reporting_disabled",
      });
    }
    next();
  }

  /** Switching a template on is for a person who is the company's owner/admin (or an instance admin). */
  function canEnableTemplates(req: Request, companyId: string): boolean {
    return getActorInfo(req).actorType === "user" && isCompanyOwnerOrAdmin(req, companyId);
  }

  /**
   * DUR-4717: a run's `fetchedData` is the company's real ledger (journal
   * entries, balances, invoices). Only a company owner/admin (a person) sees
   * it; everyone else -- agents, viewers, operators -- gets the status, the
   * numbers, the commentary and the snapshot's digest, never the data.
   */
  function forViewer<T extends { fetchedData: unknown }>(req: Request, companyId: string, run: T): T {
    return canEnableTemplates(req, companyId) ? run : { ...run, fetchedData: null };
  }

  function actorOf(req: Request) {
    const info = getActorInfo(req);
    return info.actorType === "agent"
      ? { agentId: info.agentId ?? undefined, runId: info.runId ?? undefined }
      : { userId: info.actorId, runId: info.runId ?? undefined };
  }

  async function audit(req: Request, companyId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    const info = getActorInfo(req);
    await logActivity(db, { companyId, actorType: info.actorType, actorId: info.actorId, agentId: info.agentId, runId: info.runId, action, entityType, entityId, details });
  }

  router.get("/companies/:companyId/report-templates", memberScope(), requireFeatureOn, async (req, res) => {
    res.json(await templatesSvc.listTemplates(req.params.companyId as string));
  });

  router.post("/companies/:companyId/report-templates", validate(createReportTemplateSchema), memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await templatesSvc.createTemplate(companyId, req.body, { ...actorOf(req), canEnable: canEnableTemplates(req, companyId) });
    await audit(req, companyId, "report_template.created", "report_template", created.id, { key: created.key, name: created.name });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/report-templates/:templateId", memberScope(), requireFeatureOn, async (req, res) => {
    res.json(await templatesSvc.getTemplate(req.params.companyId as string, req.params.templateId as string));
  });

  router.patch("/companies/:companyId/report-templates/:templateId", validate(updateReportTemplateSchema), memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const updated = await templatesSvc.updateTemplate(companyId, req.params.templateId as string, req.body, {
      canEnable: canEnableTemplates(req, companyId),
    });
    await audit(req, companyId, "report_template.updated", "report_template", updated.id, { fields: Object.keys(req.body) });
    res.json(updated);
  });

  /**
   * DUR-4072 PR3: "Preview data" on the template page. A company owner/admin
   * (a person) only: it shows real rows from the company's own source. The
   * same audited, capped fetch a run uses (channel 'report_preview'); the
   * key never leaves the server.
   */
  router.post("/companies/:companyId/report-data/preview", validate(previewReportDataSchema), memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!canEnableTemplates(req, companyId)) {
      throw forbidden("Only the company's owner or an admin can preview a report's data.");
    }
    const info = getActorInfo(req);
    const preview = await dataSvc.preview(
      { companyId, channel: "report_preview", userId: info.actorId },
      req.body.dataConnectionId,
      req.body.dataQuery,
      req.body.period ?? null,
    );
    await audit(req, companyId, "report_data.previewed", "data_connection", req.body.dataConnectionId, {
      datasets: preview.items.map((item) => item.dataset),
      period: preview.period.token,
      ok: preview.items.every((item) => item.ok),
    });
    res.json(preview);
  });

  router.get("/companies/:companyId/report-runs", memberScope(), requireFeatureOn, async (req, res) => {
    const templateId = typeof req.query.templateId === "string" ? req.query.templateId : undefined;
    const companyId = req.params.companyId as string;
    res.json((await runsSvc.listRuns(companyId, templateId)).map((run) => forViewer(req, companyId, run)));
  });

  router.post("/companies/:companyId/report-runs", validate(createReportRunSchema), memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const run = await runsSvc.startRun(companyId, req.body.templateId, actorOf(req), { period: req.body.period ?? null });
    await audit(req, companyId, "report_run.started", "report_run", run.id, {
      templateId: run.templateId,
      status: run.status,
      period: req.body.period ?? null,
      inputSha256: run.fetchedDataSha256,
    });
    res.status(201).json(forViewer(req, companyId, run));
  });

  router.get("/companies/:companyId/report-runs/:runId", memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(forViewer(req, companyId, await runsSvc.getRun(companyId, req.params.runId as string)));
  });

  router.post("/companies/:companyId/report-runs/:runId/commentary", validate(draftReportRunCommentarySchema), memberScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const run = forViewer(req, companyId, await runsSvc.draftCommentary(companyId, req.params.runId as string, req.body.commentaryText, actorOf(req)));
    await audit(req, companyId, "report_run.commentary_drafted", "report_run", run.id, { status: run.status, ungroundedCount: run.ungroundedNumbers.length });
    res.json(run);
  });

  return router;
}
