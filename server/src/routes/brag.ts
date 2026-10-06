import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { bragEstimateSchema, createBragJobSchema, updateBragSceneSchema, type CreateBragJobInput, type UpdateBragSceneInput } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { bragService, type BragActor } from "../services/brag.js";

/**
 * DUR-4520: Brag video pipeline routes. Board-only (assertBoard refuses an
 * agent key); a viewer's non-GET request is already rejected by
 * assertCompanyAccess. Every job lookup is company-scoped in the service.
 */
function actorOf(req: Request): BragActor {
  return { userId: req.actor.userId ?? "unknown" };
}

export function bragRoutes(rawDb: Db) {
  const router = Router();
  const brag = bragService(createRequestScopedDb(rawDb));
  const scope = () =>
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });

  router.post("/companies/:companyId/brag/estimate", scope(), validate(bragEstimateSchema), (req, res) => {
    res.json(brag.estimate(req.body as { lengthSeconds: number; music: boolean }));
  });

  router.post("/companies/:companyId/brag/jobs", scope(), validate(createBragJobSchema), async (req, res) => {
    res.status(201).json(await brag.createJob(req.params.companyId as string, actorOf(req), req.body as CreateBragJobInput));
  });

  router.get("/companies/:companyId/projects/:projectId/brag/jobs", scope(), async (req, res) => {
    res.json(await brag.listJobs(req.params.companyId as string, req.params.projectId as string));
  });

  router.get("/companies/:companyId/brag/jobs/:jobId", scope(), async (req, res) => {
    res.json(await brag.getJob(req.params.companyId as string, req.params.jobId as string));
  });

  router.post("/companies/:companyId/brag/jobs/:jobId/plan", scope(), async (req, res) => {
    res.json(await brag.planJob(req.params.companyId as string, req.params.jobId as string, actorOf(req)));
  });

  router.patch("/companies/:companyId/brag/jobs/:jobId/scenes/:sceneId", scope(), validate(updateBragSceneSchema), async (req, res) => {
    const { companyId, jobId, sceneId } = req.params as Record<string, string>;
    res.json(await brag.updateScene(companyId!, jobId!, sceneId!, req.body as UpdateBragSceneInput));
  });

  router.post("/companies/:companyId/brag/jobs/:jobId/render", scope(), async (req, res) => {
    res.json(await brag.render(req.params.companyId as string, req.params.jobId as string, actorOf(req)));
  });

  router.post("/companies/:companyId/brag/jobs/:jobId/cancel", scope(), async (req, res) => {
    res.json(await brag.cancel(req.params.companyId as string, req.params.jobId as string));
  });

  return router;
}
