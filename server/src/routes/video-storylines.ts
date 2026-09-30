import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createVideoSceneSchema,
  createVideoShotSchema,
  createVideoStorylineSchema,
  startVideoStorylineRenderSchema,
  updateVideoSceneSchema,
  updateVideoShotSchema,
  updateVideoStorylineSchema,
  updateVideoStorylineSettingsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrAgent, assertBoardOrgAccess, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.js";
import { videoStorylineRenderService } from "../services/video-storyline-render.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.js";

/**
 * DUR-4127: company-scoped CRUD + render orchestration for video
 * storylines. Agent-writable (like the rest of Media Studio's generation
 * surface) as well as board-writable, gated the same way as
 * plugins.ts#/plugins/tools/execute: assertBoardOrAgent + assertCompanyAccess.
 * The one exception is the on/off settings toggle, which is board-only (an
 * owner/admin decision, same bar as plugins.ts's other company-settings
 * mutations) -- see video-storyline-settings.ts.
 */

function actorOf(req: Request): VideoStorylineActor {
  if (req.actor.type === "agent") {
    return { actorType: "agent", actorId: req.actor.agentId ?? "unknown", agentId: req.actor.agentId ?? null };
  }
  return { actorType: "user", actorId: req.actor.userId ?? "board", agentId: null };
}

export function videoStorylineRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const storylines = videoStorylineService(db);
  const render = videoStorylineRenderService(db);
  const settings = videoStorylineSettingsService(db);

  function scope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrAgent(req);
      assertCompanyAccess(req, companyId);
    });
  }

  /**
   * Every storyline/scene/shot route (everything except the settings toggle
   * itself) additionally requires the feature to be switched on -- the
   * ticket's ground rule that this ships default-off. Checked here, not
   * buried in one service call, so a disabled company gets a consistent
   * 422 across list/create/render/etc rather than only at render time.
   */
  function gatedScope() {
    return companyScopeFromParam(rawDb, async (req, companyId) => {
      assertBoardOrAgent(req);
      assertCompanyAccess(req, companyId);
      await settings.assertEnabled(companyId);
    });
  }

  // ─── Settings (feature flag, ships default off) ──────────────────────

  router.get("/companies/:companyId/video-storylines/settings", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json({ enabled: await settings.isEnabled(companyId) });
  });

  router.patch(
    "/companies/:companyId/video-storylines/settings",
    validate(updateVideoStorylineSettingsSchema),
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const enabled = await settings.setEnabled(companyId, req.body.enabled);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "video_storylines.settings_updated",
        entityType: "company",
        entityId: companyId,
        details: { enabled },
      });
      res.json({ enabled });
    },
  );

  // ─── Storylines ────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines", gatedScope(), async (req, res) => {
    res.json(await storylines.listStorylines(req.params.companyId as string));
  });

  router.post(
    "/companies/:companyId/video-storylines",
    validate(createVideoStorylineSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const row = await storylines.createStoryline(companyId, req.body, actorOf(req));
      res.status(201).json(row);
    },
  );

  router.get("/companies/:companyId/video-storylines/:storylineId", gatedScope(), async (req, res) => {
    res.json(await storylines.getStoryline(req.params.companyId as string, req.params.storylineId as string));
  });

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId",
    validate(updateVideoStorylineSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await storylines.updateStoryline(companyId, storylineId, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    await storylines.deleteStoryline(companyId, storylineId, actorOf(req));
    res.status(204).end();
  });

  router.get("/companies/:companyId/video-storylines/:storylineId/progress", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.getProgress(companyId, storylineId));
  });

  router.post("/companies/:companyId/video-storylines/:storylineId/estimate", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await render.estimate(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/render/start",
    validate(startVideoStorylineRenderSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await render.startRender(companyId, storylineId, actorOf(req), req.body));
    },
  );

  // ─── Scenes ──────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines/:storylineId/scenes", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.listScenes(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/scenes",
    validate(createVideoSceneSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const row = await storylines.createScene(companyId, storylineId, req.body, actorOf(req));
      res.status(201).json(row);
    },
  );

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId/scenes/:sceneId",
    validate(updateVideoSceneSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const sceneId = req.params.sceneId as string;
      res.json(await storylines.updateScene(companyId, storylineId, sceneId, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId/scenes/:sceneId", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    const sceneId = req.params.sceneId as string;
    await storylines.deleteScene(companyId, storylineId, sceneId, actorOf(req));
    res.status(204).end();
  });

  // ─── Shots ───────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines/:storylineId/shots", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.listShots(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots",
    validate(createVideoShotSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const row = await storylines.createShot(companyId, storylineId, req.body, actorOf(req));
      res.status(201).json(row);
    },
  );

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId",
    validate(updateVideoShotSchema),
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await storylines.updateShot(companyId, storylineId, shotId, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId/shots/:shotId", gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    const shotId = req.params.shotId as string;
    await storylines.deleteShot(companyId, storylineId, shotId, actorOf(req));
    res.status(204).end();
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/rerender",
    gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await render.reRenderShot(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  return router;
}
