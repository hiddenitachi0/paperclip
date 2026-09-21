import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  DATA_DATASETS,
  createDataConnectionSchema,
  setDatasetSourceSchema,
  updateDataConnectionSchema,
  type DataDataset,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "../services/data-connections.js";
import { businessDataService } from "../services/business-data.js";

/**
 * DUR-3972 slice S1: "Datakilder" -- connecting a company to its own business
 * data (Shopify first), from company settings.
 *
 * Board-only, exactly like the Telegram-bot routes next door: assertBoard
 * refuses every agent, service token and delegate token; assertCompanyAccess
 * refuses a board user of another company; every query is filtered on the
 * company in the URL, so another company's connection is "not found".
 *
 * Switched off by default. Until an instance admin turns on
 * `enableBusinessData` in the experimental settings, every route here answers
 * 404 with a plain sentence -- after the actor checks, so an agent is refused
 * the same way whether the feature is on or off. Two exceptions, so a key can
 * always be revoked: switching a connection off, and removing it.
 *
 * None of these routes ever returns the key. The activity log gets names and
 * ids only, never the key and never its hint.
 */
export function dataConnectionRoutes(rawDb: Db, deps: DataConnectionServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = dataConnectionService(db, deps);
  const businessData = businessDataService(db, deps);
  const instanceSettings = instanceSettingsService(rawDb);

  function boardScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });
  }

  async function requireFeatureOn(_req: Request, _res: Response, next: NextFunction) {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableBusinessData) {
      throw new HttpError(
        404,
        "Datakilder er ikke slått på for denne Paperclip-installasjonen. En administrator kan slå det på under Instansinnstillinger → Eksperimentelt.",
        { code: "business_data_disabled" },
      );
    }
    next();
  }

  /**
   * Switching a connection off and removing it (and its key) must always be
   * possible -- an operator who turned the whole feature off during an
   * incident still has to be able to revoke a key. Everything else stays
   * behind the switch.
   */
  async function requireFeatureOnUnlessRevoking(req: Request, res: Response, next: NextFunction) {
    const body = req.body as Record<string, unknown> | undefined;
    const onlyDisabling =
      req.method === "PATCH" &&
      body !== null &&
      typeof body === "object" &&
      Object.keys(body).length === 1 &&
      body.status === "disabled";
    if (req.method === "DELETE" || onlyDisabling) {
      next();
      return;
    }
    await requireFeatureOn(req, res, next);
  }

  function actorUserId(req: Request): string {
    return req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
  }

  function datasetParam(req: Request): DataDataset {
    const value = req.params.dataset as string;
    if (!(DATA_DATASETS as readonly string[]).includes(value)) {
      throw notFound("Ukjent datasett. Bare «sales» (Salg) finnes foreløpig.");
    }
    return value as DataDataset;
  }

  router.get("/companies/:companyId/data-connections", boardScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.list(req.params.companyId as string));
  });

  router.post("/companies/:companyId/data-connections", boardScope(), requireFeatureOn, validate(createDataConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.create(companyId, req.body, { userId: actorUserId(req) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "data_connection.connected",
      entityType: "data_connection",
      entityId: created.id,
      details: { name: created.name, kind: created.kind, shopDomain: created.shopDomain },
    });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/data-connections/:connectionId", boardScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.get(req.params.companyId as string, req.params.connectionId as string));
  });

  router.patch(
    "/companies/:companyId/data-connections/:connectionId",
    boardScope(),
    requireFeatureOnUnlessRevoking,
    validate(updateDataConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.update(companyId, req.params.connectionId as string, req.body, {
        userId: actorUserId(req),
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: req.body.credential ? "data_connection.credential_rotated" : "data_connection.updated",
        entityType: "data_connection",
        entityId: updated.id,
        details: {
          name: updated.name,
          status: updated.status,
          dailyLookupCap: updated.dailyLookupCap,
          changed: Object.keys(req.body).sort(),
        },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/data-connections/:connectionId", boardScope(), requireFeatureOnUnlessRevoking, async (req, res) => {
    const companyId = req.params.companyId as string;
    const connectionId = req.params.connectionId as string;
    const existing = await svc.get(companyId, connectionId);
    await svc.remove(companyId, connectionId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "data_connection.removed",
      entityType: "data_connection",
      entityId: connectionId,
      details: { name: existing.name, shopDomain: existing.shopDomain },
    });
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/data-connections/:connectionId/test", boardScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await svc.test(companyId, req.params.connectionId as string, { userId: actorUserId(req) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "data_connection.tested",
      entityType: "data_connection",
      entityId: req.params.connectionId as string,
      details: { ok: result.ok, canActivate: result.canActivate, status: result.status },
    });
    res.json(result);
  });

  /**
   * DUR-3972 S4: "Prøveberegning". Runs the same lookup an agent would, for the
   * two last closed months grouped by product type, through this connection
   * (which need not be ticked for "Salg" yet), so the operator can compare it
   * with Shopify Analytics before any agent sees a number. Audited with
   * channel settings_test and counted against the same limits.
   */
  router.post("/companies/:companyId/data-connections/:connectionId/trial", boardScope(), requireFeatureOn, async (req, res) => {
    const companyId = req.params.companyId as string;
    const connectionId = req.params.connectionId as string;
    const answer = await businessData.trial(companyId, connectionId, actorUserId(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "data_connection.trial_run",
      entityType: "data_connection",
      entityId: connectionId,
      details: { outcome: answer.outcome, refusalCode: answer.refusalCode, lookupId: answer.lookupId },
    });
    res.json({
      ok: answer.ok,
      outcome: answer.outcome,
      refusalCode: answer.refusalCode,
      lookupId: answer.lookupId,
      text: answer.text,
    });
  });

  router.get("/companies/:companyId/dataset-sources", boardScope(), requireFeatureOn, async (req, res) => {
    res.json(await svc.listDatasetSources(req.params.companyId as string));
  });

  router.put(
    "/companies/:companyId/dataset-sources/:dataset",
    boardScope(),
    requireFeatureOn,
    validate(setDatasetSourceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const dataset = datasetParam(req);
      const saved = await svc.setDatasetSource(companyId, dataset, req.body.connectionId, {
        userId: actorUserId(req),
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: saved ? "data_dataset_source.granted" : "data_dataset_source.removed",
        entityType: "data_dataset_source",
        entityId: dataset,
        details: { dataset, connectionId: saved?.connectionId ?? null },
      });
      res.json({ dataset, source: saved });
    },
  );

  router.get("/companies/:companyId/data-reads", boardScope(), requireFeatureOn, async (req, res) => {
    const rawLimit = Number.parseInt(String(req.query.limit ?? "20"), 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    res.json(await svc.listReadEvents(req.params.companyId as string, limit));
  });

  return router;
}
