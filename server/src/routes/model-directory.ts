import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createModelDirectoryEntrySchema,
  duplicateModelDirectoryEntrySchema,
  updateModelDirectoryEntrySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { logActivity } from "../services/activity-log.js";
import { modelDirectoryService } from "../services/model-directory.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4379: the company model directory. Every route is board-only and
 * limited to the company's owner or admin (an instance admin and the local
 * single-user board pass): an agent can never read or edit the directory, so
 * it cannot re-point itself or another agent at a different model. Every
 * mutation writes an activity row. Bodies never carry a key.
 */

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can use the model directory.");
    }
  }
  assertCompanyAccess(req, companyId);
}

export function modelDirectoryRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = modelDirectoryService(db);

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

  router.get("/companies/:companyId/model-directory", scope(), async (req, res) => {
    res.json(await svc.list(req.params.companyId as string));
  });

  router.post("/companies/:companyId/model-directory", scope(), validate(createModelDirectoryEntrySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.create(companyId, req.body, actorUser(req));
    await audit(req, companyId, "model_directory_entry.created", created);
    res.status(201).json(created);
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
