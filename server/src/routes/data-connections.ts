import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  DATA_DATASETS,
  createDataConnectionSchema,
  dataTrialCalculationSchema,
  setDatasetSourceSchema,
  updateDataConnectionSchema,
  type DataDataset,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyOwnerOrInstanceAdmin } from "./authz.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "../services/data-connections.js";
import { runTrialCalculation } from "../services/data-trial.js";

/**
 * DUR-3972 slice S1: "Data sources" -- connecting a company to its own business
 * data (Shopify, and since DUR-3997 also WooCommerce, Fiken and SFTP files as
 * stored-but-not-yet-readable kinds), from company settings. Nothing here is
 * about one kind: the service asks the source-kind registry.
 *
 * Owner-or-instance-admin only (slice S2 tightened this from "any board
 * member"): agents, service tokens and delegate tokens are refused, a board
 * user of another company is refused, and so is a member of this company who
 * is not its owner. Every query is filtered on the company in the URL, so
 * another company's connection is "not found".
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
  const instanceSettings = instanceSettingsService(rawDb);

  function boardScope() {
    // DUR-3972 S2: owner of the company or instance admin only. A plain board
    // member (admin, operator, viewer) is refused, as are agents and tokens.
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerOrInstanceAdmin(req, companyId, "data sources");
    });
  }

  async function requireFeatureOn(_req: Request, _res: Response, next: NextFunction) {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableBusinessData) {
      throw new HttpError(
        404,
        "Data sources are not switched on for this Paperclip instance. An administrator can switch them on under Instance settings → Experimental.",
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
      throw notFound('Unknown dataset. Use "sales" (Sales), "finance" (Accounting) or "custom" (Files).');
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
      details: { name: created.name, kind: created.kind, target: created.target, shopDomain: created.shopDomain },
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
      details: { name: existing.name, kind: existing.kind, target: existing.target, shopDomain: existing.shopDomain },
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
   * DUR-3997 (files on a server): forget an SFTP connection's pinned host
   * key, so the next Test accepts the key the server presents then. The
   * only way a changed host key is ever accepted.
   */
  router.post(
    "/companies/:companyId/data-connections/:connectionId/forget-host-key",
    boardScope(),
    requireFeatureOn,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const result = await svc.forgetHostKey(companyId, connectionId);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "data_connection.host_key_forgotten",
        entityType: "data_connection",
        entityId: connectionId,
        details: { name: result.name, kind: result.kind, target: result.target, status: result.status },
      });
      res.json(result);
    },
  );

  /**
   * DUR-3972 S2: "Trial calculation". Counts units sold in one or two months
   * through this connection, exactly as an agent answer would, so the numbers
   * can be compared with Shopify Analytics before "Sales" is ticked. A refusal
   * is a 200 with ok:false and a plain sentence, like Test.
   */
  router.post(
    "/companies/:companyId/data-connections/:connectionId/trial",
    boardScope(),
    requireFeatureOn,
    validate(dataTrialCalculationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const connectionId = req.params.connectionId as string;
      const result = await runTrialCalculation(
        db,
        svc,
        {
          companyId,
          connectionId,
          userId: actorUserId(req),
          periods: req.body.periods,
          groupBy: req.body.groupBy,
        },
        { now: deps.now, sleep: deps.sleep },
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "data_connection.trial_calculated",
        entityType: "data_connection",
        entityId: connectionId,
        details: { ok: result.ok, periods: req.body.periods, lookupId: result.lookupId },
      });
      res.json(result);
    },
  );

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
