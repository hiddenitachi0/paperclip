import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  answerVideoDirectorConversationSchema,
  approveStoryboardShotSchema,
  approveVideoDirectorRunSchema,
  createVideoSceneSchema,
  createVideoShotSchema,
  createVideoStorylineFromScriptSchema,
  createVideoStorylineSchema,
  draftVideoDirectorShotsSchema,
  importVideoStorylineScriptSchema,
  validateVideoStorylineScript,
  VIDEO_CLIP_LENGTH_NOTE,
  VIDEO_STORYLINE_SCRIPT_EXAMPLE,
  VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS,
  type ParsedVideoStorylineScript,
  editVideoDirectorProposalSchema,
  dropStoryboardShotSchema,
  generateStoryboardStillSchema,
  startVideoStorylineRenderSchema,
  updateVideoSceneSchema,
  updateVideoShotSchema,
  updateVideoShotCastSchema,
  updateVideoStorylineCastSchema,
  updateVideoStorylineApprovalThresholdSchema,
  updateVideoStorylineSchema,
  updateVideoStorylineSettingsSchema,
  upsertVideoTransitionSchema,
  suggestVideoTransitionSchema,
  generateVideoTransitionSchema,
  updateMediaMonthlyCapSchema,
  MEDIA_MONTHLY_CAP_EXPLANATION,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrAgent, assertBoardOrgAccess, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { getStorageService } from "../storage/index.js";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.js";
import { videoStorylineRenderService } from "../services/video-storyline-render.js";
import { videoStorylineStitchService } from "../services/video-storyline-stitch.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.js";
import { checkFfmpegAvailable } from "../services/video-ffmpeg.js";
import { videoStorylineStillsService } from "../services/video-storyline-stills.js";
import { videoStorylineDirectorService } from "../services/video-storyline-director.js";
import { videoStorylineDirectorConversationStore } from "../services/video-storyline-director-conversation.js";
import { videoStorylineDirectorReviewService } from "../services/video-storyline-director-review.js";
import { videoStorylineDirectorDialogueService } from "../services/video-storyline-director-dialogue.js";
import { videoStorylineDirectorProposalsService } from "../services/video-storyline-director-proposals.js";
import { videoStorylineTransitionsService } from "../services/video-storyline-transitions.js";
import { extractPosterJpeg } from "../services/video-ffmpeg.js";
import { runMediaJob } from "../services/media-job-queue.js";
import { buffer as streamToBuffer } from "node:stream/consumers";
import type { NextFunction, Response } from "express";

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
  const stitch = videoStorylineStitchService(db);
  const settings = videoStorylineSettingsService(db);
  const director = videoStorylineDirectorService(db);
  const directorConversations = videoStorylineDirectorConversationStore(db);
  const directorReview = videoStorylineDirectorReviewService(db);
  const directorDialogue = videoStorylineDirectorDialogueService(db);
  const directorProposals = videoStorylineDirectorProposalsService(db);
  const stills = videoStorylineStillsService(db);
  const transitions = videoStorylineTransitionsService(db);

  /** Streams one stored object of THIS company (the key always comes from a stored row, never the request). */
  async function streamStored(res: Response, next: NextFunction, companyId: string, objectKey: string, contentType: string, byteSize: number | null) {
    const object = await getStorageService().getObject(companyId, objectKey);
    res.setHeader("Content-Type", contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  }

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
   *
   * This is two middlewares, not one: `companyScopeFromParam`'s `checkAccess`
   * callback runs from inside its company-id resolver -- i.e. BEFORE
   * `runInCompanyScope` ever establishes the request's AsyncLocalStorage
   * scope (see that function's doc comment) -- so it must stay limited to
   * actor-only checks (assertBoardOrAgent/assertCompanyAccess, which only
   * read `req.actor`). `settings.assertEnabled` does a real `db.select()`
   * through the request-scoped proxy, which throws "outside any
   * AsyncLocalStorage-tracked scope" if run pre-scope; it has to run as its
   * own middleware placed after `companyScopeFromParam` in the route's
   * handler chain, once scope is live.
   */
  const assertVideoStorylinesEnabled: RequestHandler = (req, res, next) => {
    settings.assertEnabled(req.params.companyId as string).then(() => next(), next);
  };

  function gatedScope(): RequestHandler[] {
    return [
      companyScopeFromParam(rawDb, (req, companyId) => {
        assertBoardOrAgent(req);
        assertCompanyAccess(req, companyId);
      }),
      assertVideoStorylinesEnabled,
    ];
  }

  /**
   * DUR-4196: round-2 fields (transitions/music on a storyline, transitionIn
   * on a shot) ride the same PATCH/POST routes round 1 already has, rather
   * than new endpoints -- so gating by route alone would either block round-1
   * edits for a company without round 2, or let round-2 fields through
   * ungated. Checked by VALUE against the round-1-equivalent default, not by
   * key presence: createVideoStorylineSchema/createVideoShotSchema fill in
   * defaults ("cut"/null) for any field the caller omits, so by the time this
   * runs every key is already present on a create request -- presence alone
   * would wrongly gate every single storyline/shot creation.
   */
  function hasAdvancedStorylineValues(body: Record<string, unknown>): boolean {
    return (
      (typeof body.defaultTransition === "string" && body.defaultTransition !== "cut") ||
      body.musicAssetId != null ||
      body.musicSourceKey != null
    );
  }

  function hasAdvancedShotValues(body: Record<string, unknown>): boolean {
    return body.transitionIn != null;
  }

  function assertAdvancedIfValuesPresent(touches: (body: Record<string, unknown>) => boolean): RequestHandler {
    return (req, res, next) => {
      if (!touches((req.body ?? {}) as Record<string, unknown>)) {
        next();
        return;
      }
      settings.assertAdvancedEnabled(req.params.companyId as string).then(() => next(), next);
    };
  }

  // ─── Settings (feature flag, ships default off) ──────────────────────

  router.get("/companies/:companyId/video-storylines/settings", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    // ffmpegAvailable lets the editor warn up front: without ffmpeg on the
    // server, finished clips cannot be combined into one film and shots do
    // not continue from the previous shot's last frame.
    res.json({ enabled: await settings.isEnabled(companyId), ffmpegAvailable: await checkFfmpegAvailable() });
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

  /**
   * DUR-4196: the round-2 flag (director AI, still-frame preview,
   * transitions/music) -- deliberately separate from the round-1 toggle
   * above so an existing on company keeps exactly its round-1 behavior until
   * it opts into round 2 too. Same board-only bar as the round-1 toggle.
   */
  router.get("/companies/:companyId/video-storylines/settings/advanced", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json({ enabled: await settings.isAdvancedEnabled(companyId) });
  });

  router.patch(
    "/companies/:companyId/video-storylines/settings/advanced",
    validate(updateVideoStorylineSettingsSchema),
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const enabled = await settings.setAdvancedEnabled(companyId, req.body.enabled);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "video_storylines.advanced_settings_updated",
        entityType: "company",
        entityId: companyId,
        details: { enabled },
      });
      res.json({ enabled });
    },
  );

  /**
   * DUR-4317/DUR-4320: the per-company kind:"video_render" approval
   * threshold (see video-storyline-settings.ts's getApprovalThresholdCents)
   * -- board-only, same bar as the two feature-flag toggles above, since
   * this is an owner/admin spend-policy decision, not something an agent
   * should set for itself.
   */
  router.get("/companies/:companyId/video-storylines/settings/approval-threshold", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json({ thresholdCents: await settings.getApprovalThresholdCents(companyId) });
  });

  router.patch(
    "/companies/:companyId/video-storylines/settings/approval-threshold",
    validate(updateVideoStorylineApprovalThresholdSchema),
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const thresholdCents = await settings.setApprovalThresholdCents(companyId, req.body.thresholdCents);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "video_storylines.approval_threshold_updated",
        entityType: "company",
        entityId: companyId,
        details: { thresholdCents },
      });
      res.json({ thresholdCents });
    },
  );

  /**
   * Storyline strip: the company's monthly limit for AI transitions (design
   * 2.11). Anyone in the company sees it; only an owner/admin changes it.
   */
  router.get("/companies/:companyId/video-storylines/settings/media-cap", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json({ capCents: await settings.getMediaMonthlyCapCents(companyId), spentCents: await transitions.monthlySpentCents(companyId), explanation: MEDIA_MONTHLY_CAP_EXPLANATION });
  });

  router.patch(
    "/companies/:companyId/video-storylines/settings/media-cap",
    validate(updateMediaMonthlyCapSchema),
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const capCents = await settings.setMediaMonthlyCapCents(companyId, req.body.capCents);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "video_storylines.media_cap_updated",
        entityType: "company",
        entityId: companyId,
        details: { capCents },
      });
      res.json({ capCents, spentCents: await transitions.monthlySpentCents(companyId), explanation: MEDIA_MONTHLY_CAP_EXPLANATION });
    },
  );

  // ─── Strip (Simple editor): clips, transitions, versions ─────────────

  router.get("/companies/:companyId/video-storylines/:storylineId/strip", ...gatedScope(), async (req, res) => {
    res.json(await transitions.strip(req.params.companyId as string, req.params.storylineId as string));
  });

  router.put(
    "/companies/:companyId/video-storylines/:storylineId/transitions",
    validate(upsertVideoTransitionSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await transitions.upsert(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/transitions/suggest",
    validate(suggestVideoTransitionSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await transitions.suggest(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/transitions/:transitionId/generate",
    validate(generateVideoTransitionSchema),
    ...gatedScope(),
    async (req, res) => {
      res.status(202).json(
        await transitions.generate(req.params.companyId as string, req.params.storylineId as string, req.params.transitionId as string, req.body, actorOf(req)),
      );
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/transitions/:transitionId/takes/:takeId/use",
    ...gatedScope(),
    async (req, res) => {
      res.json(
        await transitions.useTake(
          req.params.companyId as string,
          req.params.storylineId as string,
          req.params.transitionId as string,
          req.params.takeId as string,
          actorOf(req),
        ),
      );
    },
  );

  router.get(
    "/companies/:companyId/video-storylines/:storylineId/transitions/:transitionId/takes/:takeId/content",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const take = await transitions.getTake(companyId, req.params.storylineId as string, req.params.transitionId as string, req.params.takeId as string);
      if (!take.resultObjectKey) throw notFound("This version has no video yet.");
      await streamStored(res, next, companyId, take.resultObjectKey, take.resultContentType || "video/mp4", take.resultByteSize);
    },
  );

  /** A shot's own rendered clip, for the strip's play button. Company-scoped like final/content. */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/clip",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const shot = await storylines.getShotRow(companyId, req.params.storylineId as string, req.params.shotId as string);
      if (!shot.resultObjectKey) throw notFound("This shot has no rendered clip yet.");
      await streamStored(res, next, companyId, shot.resultObjectKey, shot.resultContentType || "video/mp4", shot.resultByteSize);
    },
  );

  /** A shot's poster picture: its approved still, else its preview, else the first frame of its clip. */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/poster",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const shot = await storylines.getShotRow(companyId, req.params.storylineId as string, req.params.shotId as string);
      if (shot.stillObjectKey) {
        await streamStored(res, next, companyId, shot.stillObjectKey, shot.stillContentType || "image/png", shot.stillByteSize);
        return;
      }
      if (shot.previewObjectKey) {
        await streamStored(res, next, companyId, shot.previewObjectKey, shot.previewContentType || "image/jpeg", shot.previewByteSize);
        return;
      }
      if (!shot.resultObjectKey) throw notFound("This shot has no picture yet.");
      const object = await getStorageService().getObject(companyId, shot.resultObjectKey);
      const clip = await streamToBuffer(object.stream);
      const poster = await runMediaJob("poster", () => extractPosterJpeg(clip));
      if (!poster) throw notFound("This shot's picture could not be made (ffmpeg is not available on this server).");
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(poster.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(poster);
    },
  );

  /** A script that fails validation is refused with every problem listed in plain words (details.errors), never a raw schema dump. */
  function parseScriptOrThrow(script: unknown): ParsedVideoStorylineScript {
    const result = validateVideoStorylineScript(script);
    if (!result.ok) {
      const count = result.errors.length;
      throw unprocessable(
        count === 1 ? `The script has a problem: ${result.errors[0]}` : `The script has ${count} problems. First: ${result.errors[0]}`,
        { errors: result.errors },
      );
    }
    return result.script;
  }

  /**
   * Security review: a script's transition_in lands on shot.transitionIn --
   * the same round-2 ("advanced") field shot create/PATCH gate through
   * assertAdvancedIfValuesPresent(hasAdvancedShotValues). Without this, an
   * import (dry run included) was a way around that gate.
   */
  async function assertAdvancedIfScriptHasTransitions(companyId: string, script: ParsedVideoStorylineScript): Promise<void> {
    const usesTransitions = script.scenes.some((scene) => scene.shots.some((shot) => hasAdvancedShotValues({ transitionIn: shot.transitionIn })));
    if (usesTransitions) await settings.assertAdvancedEnabled(companyId);
  }

  // ─── Script-writer instructions + JSON import ─────────────────────────

  /**
   * The ready-made instructions to hand an AI script writer -- the same
   * shared constant the editor's "Script-writer instructions" button shows
   * (it fetches this route), so the two can never drift apart. Registered
   * before GET .../:storylineId so "script-instructions" is never read as a
   * storyline id.
   */
  router.get("/companies/:companyId/video-storylines/script-instructions", ...gatedScope(), async (_req, res) => {
    res.json({
      markdown: VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS,
      example: VIDEO_STORYLINE_SCRIPT_EXAMPLE,
      clipLengthNote: VIDEO_CLIP_LENGTH_NOTE,
    });
  });

  /** A brand-new storyline (plus all its scenes and shots, in one transaction) from a script. dryRun: true only checks it and returns the summary. */
  router.post(
    "/companies/:companyId/video-storylines/import",
    validate(createVideoStorylineFromScriptSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const script = parseScriptOrThrow(req.body.script);
      await assertAdvancedIfScriptHasTransitions(companyId, script);
      const title = (req.body.title as string | undefined) ?? script.title;
      if (!title) {
        throw badRequest("Give the storyline a title (or add a \"title\" to the script).");
      }
      const result = await storylines.createStorylineFromScript(
        companyId,
        { title, providerId: req.body.providerId, model: req.body.model, budgetCapCents: req.body.budgetCapCents },
        script,
        actorOf(req),
        { dryRun: req.body.dryRun },
      );
      res.status(req.body.dryRun ? 200 : 201).json(result);
    },
  );

  // ─── Storylines ────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines", ...gatedScope(), async (req, res) => {
    res.json(await storylines.listStorylines(req.params.companyId as string));
  });

  router.post(
    "/companies/:companyId/video-storylines",
    validate(createVideoStorylineSchema),
    ...gatedScope(),
    assertAdvancedIfValuesPresent(hasAdvancedStorylineValues),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const row = await storylines.createStoryline(companyId, req.body, actorOf(req));
      res.status(201).json(row);
    },
  );

  router.get("/companies/:companyId/video-storylines/:storylineId", ...gatedScope(), async (req, res) => {
    res.json(await storylines.getStoryline(req.params.companyId as string, req.params.storylineId as string));
  });

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId",
    validate(updateVideoStorylineSchema),
    ...gatedScope(),
    assertAdvancedIfValuesPresent(hasAdvancedStorylineValues),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await storylines.updateStoryline(companyId, storylineId, req.body, actorOf(req)));
    },
  );

  // The storyline's Cast: the script's characters, each optionally linked to one of the company's saved people (Media Studio identities).
  router.put(
    "/companies/:companyId/video-storylines/:storylineId/cast",
    validate(updateVideoStorylineCastSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await storylines.setCast(companyId, storylineId, req.body, actorOf(req)));
    },
  );

  router.put(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/cast",
    validate(updateVideoShotCastSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await storylines.setShotCast(companyId, storylineId, shotId, req.body.castIds, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    await storylines.deleteStoryline(companyId, storylineId, actorOf(req));
    res.status(204).end();
  });

  router.get("/companies/:companyId/video-storylines/:storylineId/progress", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.getProgress(companyId, storylineId));
  });

  router.post("/companies/:companyId/video-storylines/:storylineId/estimate", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await render.estimate(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/render/start",
    validate(startVideoStorylineRenderSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await render.startRender(companyId, storylineId, actorOf(req), req.body));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/render/cancel",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await render.cancelRender(companyId, storylineId, actorOf(req)));
    },
  );

  /**
   * DUR-4318: the recovery action off "needs_attention" -- the shots are
   * already done, only the stitched file failed its quality check, so this
   * re-queues for stitching (and a fresh quality check) instead of
   * re-rendering every shot via render/start.
   */
  router.post(
    "/companies/:companyId/video-storylines/:storylineId/stitch/retry",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      await stitch.retryStitch(companyId, storylineId);
      res.json({ ok: true });
    },
  );

  /**
   * DUR-4170: streams the finished stitched film, same pattern as
   * assets.ts's GET /assets/:assetId/content -- content-type/length off the
   * stored row, inline disposition, company-scoped access via gatedScope().
   */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/final/content",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const storyline = await storylines.getStorylineRow(companyId, storylineId);
      if (!storyline.finalObjectKey) {
        throw notFound("This storyline has no finished video yet.");
      }

      const storage = getStorageService();
      const object = await storage.getObject(companyId, storyline.finalObjectKey);
      const responseContentType = storyline.finalContentType || object.contentType || "video/mp4";
      res.setHeader("Content-Type", responseContentType);
      res.setHeader("Content-Length", String(storyline.finalByteSize || object.contentLength || 0));
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const filename = `${(storyline.title || "video-storyline").replaceAll('"', "")}.mp4`;
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

      object.stream.on("error", (err) => {
        next(err);
      });
      object.stream.pipe(res);
    },
  );

  /**
   * DUR-4425: streams a shot's storyboard still so the approval screen can
   * show it before approval. The object key comes only from the stored shot
   * row (never the request); the shot must belong to this company's storyline.
   */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/still/content",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      const shot = await storylines.getShotRow(companyId, storylineId, shotId);
      if (!shot.stillObjectKey) {
        throw notFound("This shot has no still picture yet.");
      }

      const storage = getStorageService();
      const object = await storage.getObject(companyId, shot.stillObjectKey);
      res.setHeader("Content-Type", shot.stillContentType || object.contentType || "image/png");
      res.setHeader("Content-Length", String(shot.stillByteSize || object.contentLength || 0));
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");

      object.stream.on("error", (err) => {
        next(err);
      });
      object.stream.pipe(res);
    },
  );

  /**
   * Imports a script into an existing storyline -- same gate as creating
   * shots (gatedScope: board or agent of this company, feature on). "append"
   * adds after the existing scenes; "replace" swaps the scene/shot tree and
   * is refused once anything was rendered or paid for. All scenes and shots
   * are written in one transaction.
   */
  router.post(
    "/companies/:companyId/video-storylines/:storylineId/import",
    validate(importVideoStorylineScriptSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const script = parseScriptOrThrow(req.body.script);
      await assertAdvancedIfScriptHasTransitions(companyId, script);
      res.json(await storylines.importScript(companyId, storylineId, script, req.body.mode, actorOf(req), { dryRun: req.body.dryRun }));
    },
  );

  // ─── Scenes ──────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines/:storylineId/scenes", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.listScenes(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/scenes",
    validate(createVideoSceneSchema),
    ...gatedScope(),
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
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const sceneId = req.params.sceneId as string;
      res.json(await storylines.updateScene(companyId, storylineId, sceneId, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId/scenes/:sceneId", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    const sceneId = req.params.sceneId as string;
    await storylines.deleteScene(companyId, storylineId, sceneId, actorOf(req));
    res.status(204).end();
  });

  // ─── Shots ───────────────────────────────────────────────────────────

  router.get("/companies/:companyId/video-storylines/:storylineId/shots", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    res.json(await storylines.listShots(companyId, storylineId));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots",
    validate(createVideoShotSchema),
    ...gatedScope(),
    assertAdvancedIfValuesPresent(hasAdvancedShotValues),
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
    ...gatedScope(),
    assertAdvancedIfValuesPresent(hasAdvancedShotValues),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await storylines.updateShot(companyId, storylineId, shotId, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId/shots/:shotId", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const storylineId = req.params.storylineId as string;
    const shotId = req.params.shotId as string;
    await storylines.deleteShot(companyId, storylineId, shotId, actorOf(req));
    res.status(204).end();
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/rerender",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await render.reRenderShot(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  // ─── Storyboard-of-stills approval gate (DUR-4317/DUR-4320) ───────────

  /** Contact-sheet summary: every shot's storyboard status/still + per-shot and total cost -- see VideoStoryboardSummary's doc comment in packages/shared. */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/storyboard",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await stills.getStoryboardSummary(companyId, storylineId));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/still",
    validate(generateStoryboardStillSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await stills.generateStill(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/approve",
    validate(approveStoryboardShotSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await stills.approveShot(companyId, storylineId, shotId, actorOf(req), { withoutStill: req.body.withoutStill === true }));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/drop",
    validate(dropStoryboardShotSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await stills.dropShot(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  /**
   * DUR-4196: one-click still-frame preview render -- a round-2 (advanced)
   * feature, same as the director AI routes below. Gated here only by the
   * round-1 flag (gatedScope()); render.renderPreview itself calls
   * settings.assertAdvancedEnabled, same pattern startRender/reRenderShot
   * use for the round-1 flag.
   */
  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/preview",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await render.renderPreview(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  // ─── Director AI ──────────────────────────────────────────────────────

  router.get(
    "/companies/:companyId/video-storylines/:storylineId/director/runs",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await director.listRuns(companyId, storylineId));
    },
  );

  router.get(
    "/companies/:companyId/video-storylines/:storylineId/director/runs/:runId",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const runId = req.params.runId as string;
      res.json(await director.getRun(companyId, storylineId, runId));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/draft",
    validate(draftVideoDirectorShotsSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const row = await director.draftShots(companyId, storylineId, req.body, actorOf(req));
      res.status(201).json(row);
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/runs/:runId/approve",
    validate(approveVideoDirectorRunSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const runId = req.params.runId as string;
      res.json(await director.approveRun(companyId, storylineId, runId, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/runs/:runId/reject",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const runId = req.params.runId as string;
      res.json(await director.rejectRun(companyId, storylineId, runId, actorOf(req)));
    },
  );

  // ─── Director conversation (DUR-4327): whole-storyline review, ────────
  // ─── turn-by-turn dialogue, per-shot proposals ─────────────────────────

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/review",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.status(201).json(await directorReview.runReview(companyId, storylineId, actorOf(req)));
    },
  );

  router.get(
    "/companies/:companyId/video-storylines/:storylineId/director/conversation",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await directorConversations.getConversationDetail(companyId, storylineId));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/conversation/answer",
    validate(answerVideoDirectorConversationSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await directorDialogue.answer(companyId, storylineId, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/proposals/:shotId/accept",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await directorProposals.acceptProposal(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/proposals/:shotId/edit",
    validate(editVideoDirectorProposalSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await directorProposals.editProposal(companyId, storylineId, shotId, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/proposals/:shotId/reject",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await directorProposals.rejectProposal(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/director/proposals/accept-all",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      res.json(await directorProposals.acceptAll(companyId, storylineId, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/restore-prompt",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      const shotId = req.params.shotId as string;
      res.json(await directorProposals.restorePrompt(companyId, storylineId, shotId, actorOf(req)));
    },
  );

  return router;
}
