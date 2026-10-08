import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  addModelDirectoryStartersSchema,
  createModelDirectoryEntrySchema,
  duplicateModelDirectoryEntrySchema,
  importModelDirectoryCatalogueSchema,
  syncLocalModelsSchema,
  updateModelDirectorySettingsSchema,
  updateModelDirectoryEntrySchema,
  type ImportModelDirectoryCatalogue,
} from "@paperclipai/shared";
import { HttpError, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { logActivity } from "../services/activity-log.js";
import { LOCAL_SYNC_UNREADABLE_CODE, modelDirectoryService } from "../services/model-directory.js";
import { modelHealthService } from "../services/model-health.js";
import { modelSetupReviewerService } from "../services/model-setup-reviewer.js";
import { openRouterHostsForModel } from "../services/openrouter-hosts.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4379: the company model directory. Every route is board-only and
 * limited to the company's owner or admin (an instance admin and the local
 * single-user board pass): an agent can never read or edit the directory, so
 * it cannot re-point itself or another agent at a different model. Every
 * mutation writes an activity row. Bodies never carry a key.
 */

export function assertCompanyOwnerOrAdmin(req: Request, companyId: string, what = "use the model directory") {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden(`Only a company owner or admin can ${what}.`);
    }
  }
  assertCompanyAccess(req, companyId);
}

export function modelDirectoryRoutes(rawDb: Db, deps: { fetchImpl?: typeof fetch } = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = modelDirectoryService(db);
  const health = modelHealthService(db);
  const reviewer = modelSetupReviewerService(db);

  const scope = () =>
    companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId);
      return companyId;
    });

  const actorUser = (req: Request) => ({ userId: req.actor.type === "board" ? req.actor.userId ?? null : null });

  async function audit(req: Request, companyId: string, action: string, entry: { id: string; name: string; provider: string; model: string }, extra: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "model_directory_entry",
      entityId: entry.id,
      details: { name: entry.name, provider: entry.provider, model: entry.model, ...extra },
    });
  }

  // Archived setups are left out unless ?includeArchived=true (or 1).
  router.get("/companies/:companyId/model-directory", scope(), async (req, res) => {
    const flag = req.query.includeArchived;
    const includeArchived = flag === "true" || flag === "1";
    res.json(await svc.list(req.params.companyId as string, { includeArchived }));
  });

  router.post("/companies/:companyId/model-directory", scope(), validate(createModelDirectoryEntrySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.create(companyId, req.body, actorUser(req));
    await audit(req, companyId, "model_directory_entry.created", created);
    res.status(201).json(created);
  });

  // The catalogue as a file (archived setups included, backups by name, never
  // a key or id). Same access as the list. Registered before /:entryId.
  router.get("/companies/:companyId/model-directory/export", scope(), async (req, res) => {
    res.json(await svc.exportCatalogue(req.params.companyId as string));
  });

  // Imports a catalogue file into this company in one transaction. Same access
  // as saving a setup; one activity row per setup created or updated.
  router.post("/companies/:companyId/model-directory/import", scope(), validate(importModelDirectoryCatalogueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = req.body as ImportModelDirectoryCatalogue;
    const outcome = await svc.importCatalogue(companyId, body, actorUser(req));
    const extra = { source: "catalogue_import", onExisting: body.onExisting ?? "skip" };
    for (const entry of outcome.createdEntries) await audit(req, companyId, "model_directory_entry.created", entry, extra);
    for (const entry of outcome.updatedEntries) await audit(req, companyId, "model_directory_entry.updated", entry, extra);
    res.json(outcome.result);
  });

  // Catalogue v2: per-company settings (graphics card memory of the computer
  // that runs local models, and the company's local model server address).
  // Same access as the list; saving is gated like saving a setup.
  router.get("/companies/:companyId/model-directory/settings", scope(), async (req, res) => {
    res.json(await svc.getSettings(req.params.companyId as string));
  });

  router.put("/companies/:companyId/model-directory/settings", scope(), validate(updateModelDirectorySettingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const updated = await svc.updateSettings(companyId, req.body, actorUser(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "model_directory.settings_updated",
      entityType: "model_directory_settings",
      entityId: companyId,
      details: {
        localGpuVramGb: updated.localGpuVramGb,
        localBaseUrl: updated.localBaseUrl,
        openrouterPreferredHosts: updated.openrouterPreferredHosts,
        openrouterBlockedHosts: updated.openrouterBlockedHosts,
      },
    });
    res.json(updated);
  });

  // OpenRouter hosts: which hosts run one OpenRouter model and what each
  // supports, read live from OpenRouter's public endpoint list (no key sent,
  // openrouter.ai only, cached ~10 minutes). ?refresh=true skips the cache.
  // Same access as the list. Registered before /:entryId.
  router.get("/companies/:companyId/model-directory/openrouter-hosts", scope(), async (req, res) => {
    const model = typeof req.query.model === "string" ? req.query.model : "";
    const refresh = req.query.refresh === "true" || req.query.refresh === "1";
    res.json(await openRouterHostsForModel(model, { refresh, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }));
  });

  // Catalogue v2: ask the local Ollama which models are installed and mark the
  // saved local setups at that address. Only an address this company already
  // uses is called (422 otherwise).
  router.post("/companies/:companyId/model-directory/local-sync", scope(), validate(syncLocalModelsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const baseUrl = (req.body as { baseUrl: string }).baseUrl;
    let result: Awaited<ReturnType<typeof svc.syncLocalModels>>;
    try {
      result = await svc.syncLocalModels(companyId, baseUrl);
    } catch (err) {
      // The server could not be read: the models there are now "Offline".
      // (An address the company does not use records nothing.)
      if (err instanceof HttpError && (err.details as { code?: string } | undefined)?.code === LOCAL_SYNC_UNREADABLE_CODE) {
        await health.recordLocalSync(companyId, baseUrl, null).catch(() => undefined);
      }
      throw err;
    }
    await health.recordLocalSync(companyId, result.baseUrl, result.installed.map((m) => m.name));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "model_directory.local_synced",
      entityType: "model_directory_settings",
      entityId: companyId,
      details: {
        baseUrl: result.baseUrl,
        installedCount: result.installed.length,
        markedInstalledEntryIds: result.markedInstalledEntryIds,
        missingEntryIds: result.missingEntryIds,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/model-directory/starters", scope(), async (req, res) => {
    res.json(await svc.listStarters(req.params.companyId as string));
  });

  router.post("/companies/:companyId/model-directory/starters", scope(), validate(addModelDirectoryStartersSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await svc.addStarters(companyId, (req.body as { starterIds?: string[] }).starterIds, actorUser(req));
    for (const entry of result.created) await audit(req, companyId, "model_directory_entry.created", entry, { source: "starter" });
    // { created, skipped }: local ready-made models are skipped (with a plain reason) while no model server address is set.
    res.status(201).json(result);
  });

  router.post("/companies/:companyId/model-directory/import-agent-settings", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await svc.importAgentSettings(companyId, actorUser(req));
    for (const entry of result.created) await audit(req, companyId, "model_directory_entry.created", entry, { source: "agent_settings_import" });
    res.json(result);
  });

  // DUR-4419: stored health of every entry, plus the agents on a local model
  // (the agent-page banner reads `agents[].showBanner`). Reads only.
  router.get("/companies/:companyId/model-directory/health", scope(), async (req, res) => {
    res.json(await health.overview(req.params.companyId as string));
  });

  router.post("/companies/:companyId/model-directory/:entryId/check", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    const result = await health.checkEntry(companyId, entryId);
    const entry = await svc.get(companyId, entryId);
    await audit(req, companyId, "model_directory_entry.checked", entry, { status: result.status });
    res.json(result);
  });

  router.post("/companies/:companyId/model-directory/:entryId/test", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    const result = await health.testEntry(companyId, entryId);
    const entry = await svc.get(companyId, entryId);
    await audit(req, companyId, "model_directory_entry.tested", entry, { ran: result.ran, ok: result.runs.map((r) => r.ok) });
    res.json(result);
  });

  router.post("/companies/:companyId/model-directory/:entryId/probes", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    const result = await health.probeEntry(companyId, entryId);
    const entry = await svc.get(companyId, entryId);
    await audit(req, companyId, "model_directory_entry.probed", entry, { ran: result.ran, callsUsed: result.callsUsed, ok: result.probes.map((p) => p.ok) });
    res.json(result);
  });

  // DUR-4558: the model setup reviewer. Runs the probe set, applies passing allow-listed fixes, proposes the rest.
  router.post("/companies/:companyId/model-directory/:entryId/reviews", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await reviewer.review(companyId, req.params.entryId as string, { trigger: "manual", ...actorUser(req) });
    const entry = await svc.get(companyId, req.params.entryId as string);
    await audit(req, companyId, "model_directory_entry.reviewed", entry, {
      reviewId: result.id,
      applied: result.changes.filter((c) => c.status === "applied").map((c) => c.code),
      proposed: result.changes.filter((c) => c.status === "proposed").map((c) => c.code),
    });
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/model-directory/:entryId/reviews", scope(), async (req, res) => {
    res.json(await reviewer.list(req.params.companyId as string, req.params.entryId as string));
  });

  const reviewChangeHandler = (action: "apply" | "decline" | "undo") =>
    async (req: Request, res: import("express").Response) => {
      const companyId = req.params.companyId as string;
      const reviewId = req.params.reviewId as string;
      const changeId = req.params.changeId as string;
      const user = actorUser(req).userId;
      const entry = await svc.get(companyId, req.params.entryId as string);
      const before = (await reviewer.list(companyId, entry.id)).find((r) => r.id === reviewId);
      if (!before) throw notFound("Review not found");
      const result =
        action === "apply" ? await reviewer.applyProposed(companyId, reviewId, changeId, user)
        : action === "decline" ? await reviewer.decline(companyId, reviewId, changeId)
        : await reviewer.undo(companyId, reviewId, changeId, user);
      await audit(req, companyId, `model_directory_entry.review_change_${action}`, entry, {
        reviewId,
        changeId,
        code: result.changes.find((c) => c.id === changeId)?.code,
      });
      res.json(result);
    };
  router.post("/companies/:companyId/model-directory/:entryId/reviews/:reviewId/changes/:changeId/apply", scope(), reviewChangeHandler("apply"));
  router.post("/companies/:companyId/model-directory/:entryId/reviews/:reviewId/changes/:changeId/decline", scope(), reviewChangeHandler("decline"));
  router.post("/companies/:companyId/model-directory/:entryId/reviews/:reviewId/changes/:changeId/undo", scope(), reviewChangeHandler("undo"));

  router.get("/companies/:companyId/model-directory/:entryId/capabilities", scope(), async (req, res) => {
    res.json(await health.capabilitiesForEntry(req.params.companyId as string, req.params.entryId as string));
  });

  router.get("/companies/:companyId/model-directory/:entryId", scope(), async (req, res) => {
    res.json(await svc.get(req.params.companyId as string, req.params.entryId as string));
  });

  router.patch("/companies/:companyId/model-directory/:entryId", scope(), validate(updateModelDirectoryEntrySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const updated = await svc.update(companyId, req.params.entryId as string, req.body, actorUser(req));
    await audit(req, companyId, "model_directory_entry.updated", updated, { changedFields: Object.keys(req.body) });
    res.json(updated);
  });

  router.delete("/companies/:companyId/model-directory/:entryId", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const removed = await svc.remove(companyId, req.params.entryId as string);
    await audit(req, companyId, "model_directory_entry.deleted", removed);
    res.status(204).send();
  });

  router.post("/companies/:companyId/model-directory/:entryId/duplicate", scope(), validate(duplicateModelDirectoryEntrySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.duplicate(companyId, req.params.entryId as string, (req.body as { name?: string }).name, actorUser(req));
    await audit(req, companyId, "model_directory_entry.duplicated", created, { sourceEntryId: req.params.entryId });
    res.status(201).json(created);
  });

  return router;
}
