import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createMediaStudioDirectAudioSchema,
  createMediaStudioDirectPictureSchema,
  createMediaStudioDirectVideoSchema,
  estimateMediaStudioDirectCostCents,
  mediaStudioDirectEstimateSchema,
  mediaStudioDirectRewritePromptSchema,
  type CreateMediaStudioDirectAudioInput,
  type CreateMediaStudioDirectPictureInput,
  type CreateMediaStudioDirectVideoInput,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess, isCompanyOwnerOrAdmin } from "./authz.js";
import { mediaStudioDirectService, type MediaStudioDirectActor } from "../services/media-studio-direct.js";
import type { Request } from "express";

/**
 * DUR-4329: Media Studio's Create tab direct generation. Board-only
 * (assertBoard refuses an agent key outright) and, for the write routes,
 * non-viewer by construction: assertCompanyAccess already rejects a
 * viewer's non-GET request (authz.ts's membershipRole === "viewer" check),
 * so owner/admin/operator falls out of the existing framework with no new
 * role plumbing. See the DUR-4329 issue thread for the full
 * request/response contract.
 */

function actorOf(req: Request, companyId: string): MediaStudioDirectActor {
  return { userId: req.actor.userId ?? "unknown", isCompanyAdmin: isCompanyOwnerOrAdmin(req, companyId) };
}

export function mediaStudioDirectRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const direct = mediaStudioDirectService(db);

  function scope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });
  }

  router.post(
    "/companies/:companyId/media-studio/direct/estimate",
    scope(),
    validate(mediaStudioDirectEstimateSchema),
    async (req, res) => {
      const { kind, provider, durationSeconds } = req.body as { kind: "picture" | "video" | "audio"; provider: "fal"; durationSeconds?: number };
      res.json(estimateMediaStudioDirectCostCents({ kind, provider, durationSeconds }));
    },
  );

  router.post(
    "/companies/:companyId/media-studio/direct/picture",
    scope(),
    validate(createMediaStudioDirectPictureSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const result = await direct.createPicture(companyId, actorOf(req, companyId), req.body as CreateMediaStudioDirectPictureInput);
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/media-studio/direct/video",
    scope(),
    validate(createMediaStudioDirectVideoSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const result = await direct.createVideo(companyId, actorOf(req, companyId), req.body as CreateMediaStudioDirectVideoInput);
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/media-studio/direct/audio",
    scope(),
    validate(createMediaStudioDirectAudioSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const result = await direct.createAudio(companyId, actorOf(req, companyId), req.body as CreateMediaStudioDirectAudioInput);
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/media-studio/direct/rewrite-prompt",
    scope(),
    validate(mediaStudioDirectRewritePromptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const result = await direct.rewritePrompt(companyId, actorOf(req, companyId), req.body as { prompt: string; kind?: "picture" | "video" | "audio" });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/media-studio/direct/history", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : undefined;
    const entries = await direct.history(companyId, actorOf(req, companyId), limit);
    res.json(entries);
  });

  return router;
}
