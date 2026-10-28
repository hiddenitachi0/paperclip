import { rm } from "node:fs/promises";
import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
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
  MEDIA_FOOTAGE_EXPLANATIONS,
  MEDIA_FOOTAGE_HARD_LIMITS,
  animateVideoClipSchema,
  createVideoClipSchema,
  exportVideoStorylineSchema,
  reorderVideoShotsSchema,
  splitVideoClipSchema,
  updateMediaFootageSettingsSchema,
  updateVideoClipSchema,
  updateVideoExportSettingsSchema,
  updateVideoMusicLaneSchema,
  updateVideoStorylineAspectSchema,
  updateVideoUploadConsentSchema,
  createVideoStorylineDirectorSchema,
  updateVideoStorylineDirectorSchema,
  setVideoStorylineDirectorSchema,
  writeVideoStorylineSchema,
  answerVideoStorylineWriterSchema,
  improveVideoStorylineSchema,
  acceptVideoStorylineChangesSchema,
  estimateVideoStorylineWriterSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrAgent, assertBoardOrgAccess, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin } from "./authz.js";
import { HttpError, badRequest, notFound, unprocessable } from "../errors.js";

/** The largest clip the poster route reads into memory to cut a picture from. */
const POSTER_MAX_CLIP_BYTES = 100 * 1024 * 1024;
import { logActivity } from "../services/activity-log.js";
import { getStorageService } from "../storage/index.js";
import { contentDispositionHeader, sendStoredObject } from "../http/byte-range.js";
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
import { videoStorylineClipsService, type IncomingFile } from "../services/video-storyline-clips.js";
import { videoStorylineFootageService } from "../services/video-storyline-footage.js";
import { mediaFootageHardLimits, mediaWorkDir } from "../services/media-video-limits.js";
import { videoStorylineDirectorsService } from "../services/video-storyline-directors.js";
import { videoStorylineWriterService } from "../services/video-storyline-writer.js";
import { extractPosterJpeg } from "../services/video-ffmpeg.js";
import { runMediaJob } from "../services/media-job-queue.js";
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

/**
 * The file multer received, as the service takes it, without reading it. A
 * file multer wrote to disk is handed over by its path whatever its type or
 * name claim -- a mislabelled 1.8 GB upload must not be read into memory
 * just to be refused (D18). The service reads a photo's bytes only after its
 * kind and the photo limit are checked; music uses memory storage with its
 * own small multer limit, so it arrives as a buffer.
 */
export function incomingFileFromMulter(file: Express.Multer.File): IncomingFile {
  const incoming = { originalName: file.originalname || null, contentType: file.mimetype || "application/octet-stream", size: file.size };
  return file.path ? { ...incoming, path: file.path } : { ...incoming, buffer: file.buffer };
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
  const clips = videoStorylineClipsService(db);
  const footage = videoStorylineFootageService(db);
  const directors = videoStorylineDirectorsService(db);
  const writer = videoStorylineWriterService(db);

  /** Owners and admins (and instance admins) edit directors; everyone with access may pick and use them. */
  function canEditDirectors(req: Request, companyId: string): boolean {
    try {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the storyline directors");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Phase 2 uploads: written to a temp file first (never held whole in
   * memory before the company's own limit is checked), capped at the hard
   * upper limit here; the company's smaller limits are checked by the service.
   */
  /** Multer for one footage upload, capped at THIS company's own largest file (security review DUR-4745), never above the hard limit. */
  function footageUploadFor(maxBytes: number) {
    return multer({
      // D18: videos up to the company's limit (2 GB by default) land in the media work folder, never in memory.
      storage: multer.diskStorage({ destination: (_req, _file, cb) => void mediaWorkDir().then((dir) => cb(null, dir), (err: Error) => cb(err, "")) }),
      limits: { fileSize: Math.min(maxBytes, MEDIA_FOOTAGE_HARD_LIMITS.maxVideoMb * 1024 * 1024), files: 1, fields: 10 },
    });
  }
  /**
   * Uploads in flight per company: photos and music are read into memory to
   * be stored, and every upload takes disk and a slot in the media queue, so
   * a burst of large uploads could exhaust the server (security review
   * DUR-4745). A third one at the same time is asked to wait. (D18: videos
   * are streamed from their temp file into storage, never read into memory.)
   */
  const UPLOADS_IN_FLIGHT_PER_COMPANY = 2;
  const uploadsInFlight = new Map<string, number>();
  async function withUploadSlot<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const current = uploadsInFlight.get(companyId) ?? 0;
    if (current >= UPLOADS_IN_FLIGHT_PER_COMPANY) {
      throw new HttpError(429, "Other uploads for this company are still going. Wait for them to finish, then try again.");
    }
    uploadsInFlight.set(companyId, current + 1);
    try {
      return await fn();
    } finally {
      const left = (uploadsInFlight.get(companyId) ?? 1) - 1;
      if (left <= 0) uploadsInFlight.delete(companyId);
      else uploadsInFlight.set(companyId, left);
    }
  }
  const musicUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 5 } });

  /**
   * Runs multer for one "file" field and hands the file to `use`, in
   * plain-English errors. D18: a file multer wrote to a temp file stays on
   * disk whatever it claims to be -- the service checks its kind and its own
   * limit before reading any bytes -- and the temp file is removed once `use`
   * is done.
   */
  async function receiveFile<T>(upload: ReturnType<typeof multer>, req: Request, res: Response, maxBytesForRead: number, use: (file: IncomingFile) => Promise<T>): Promise<T> {
    try {
      await new Promise<void>((resolve, reject) => upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve())));
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") throw new HttpError(413, "This file is larger than this server accepts. Make it smaller and upload it again.");
        throw badRequest("The upload could not be read. Try again.");
      }
      throw err;
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) throw badRequest("Choose a file to upload.");
    try {
      if (file.size > maxBytesForRead) throw new HttpError(413, "This file is larger than this company allows. Make it smaller and upload it again.");
      return await use(incomingFileFromMulter(file));
    } finally {
      if (file.path) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  function bodyFlag(value: unknown): boolean {
    return value === true || value === "true" || value === "1" || value === "on";
  }

  /**
   * Streams one stored object of THIS company (the key always comes from a
   * stored row, never the request), with byte ranges so a clip can be
   * seeked in the player without downloading it whole (D18).
   */
  async function streamStored(req: Request, res: Response, next: NextFunction, companyId: string, objectKey: string, contentType: string, byteSize: number | null) {
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    await sendStoredObject(req, res, next, getStorageService(), { companyId, objectKey, byteSize, contentType, fallbackContentType: "application/octet-stream" });
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
      // A spend control: owners and admins only (security review DUR-4711).
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the advanced storyline features (they can spend money)");
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
      // A spend control: owners and admins only (security review DUR-4711).
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the approval limit for video renders");
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
      // A spend control: owners and admins only (security review DUR-4711).
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the monthly limit for AI transitions");
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

  /**
   * Phase 2: the company's settings for its own photos and videos (storage
   * limit, upload limits, clean-up days, "Never send uploaded footage to
   * Sogni"). Anyone in the company sees them; only an owner/admin changes them.
   */
  router.get("/companies/:companyId/video-storylines/settings/footage", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json({ settings: await footage.getSettings(companyId), usedBytes: await footage.storageUsedBytes(companyId), explanations: MEDIA_FOOTAGE_EXPLANATIONS, hardLimits: mediaFootageHardLimits() });
  });

  router.patch(
    "/companies/:companyId/video-storylines/settings/footage",
    validate(updateMediaFootageSettingsSchema),
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the settings for uploaded photos and videos");
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const saved = await footage.setSettings(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "video_storylines.footage_settings_updated",
        entityType: "company",
        entityId: companyId,
        details: { fields: Object.keys(req.body) },
      });
      res.json({ settings: saved, usedBytes: await footage.storageUsedBytes(companyId), explanations: MEDIA_FOOTAGE_EXPLANATIONS, hardLimits: mediaFootageHardLimits() });
    },
  );

  // ─── Music (Phase 2): files to choose from, and uploading one ─────────
  // Registered before GET .../:storylineId so these names are never read as a storyline id.

  router.get("/companies/:companyId/video-storylines/music-choices", ...gatedScope(), async (req, res) => {
    res.json(await clips.musicChoices(req.params.companyId as string));
  });

  router.post("/companies/:companyId/video-storylines/music-files", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const choice = await withUploadSlot(companyId, () =>
      receiveFile(musicUpload, req, res, 50 * 1024 * 1024, (file) => clips.uploadMusic(companyId, file, actorOf(req))),
    );
    res.status(201).json(choice);
  });

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
      await streamStored(req, res, next, companyId, take.resultObjectKey, take.resultContentType || "video/mp4", take.resultByteSize);
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
      await streamStored(req, res, next, companyId, shot.resultObjectKey, shot.resultContentType || "video/mp4", shot.resultByteSize);
    },
  );

  /** A shot's poster picture: its approved still, else its preview, else the first frame of its clip. */
  router.get(
    "/companies/:companyId/video-storylines/:storylineId/shots/:shotId/poster",
    ...gatedScope(),
    async (req, res, next) => {
      const companyId = req.params.companyId as string;
      const shot = await storylines.getShotRow(companyId, req.params.storylineId as string, req.params.shotId as string);
      if (shot.sourceUploadId && !shot.stillObjectKey) {
        // Your own video: its upload's ready-made poster (no ffmpeg in the request).
        const upload = await clips.getUpload(companyId, shot.storylineId, shot.sourceUploadId).catch(() => null);
        if (upload?.posterObjectKey) {
          await streamStored(req, res, next, companyId, upload.posterObjectKey, "image/jpeg", upload.posterByteSize || null);
          return;
        }
      }
      if (shot.stillObjectKey) {
        await streamStored(req, res, next, companyId, shot.stillObjectKey, shot.stillContentType || "image/png", shot.stillByteSize);
        return;
      }
      if (shot.previewObjectKey) {
        await streamStored(req, res, next, companyId, shot.previewObjectKey, shot.previewContentType || "image/jpeg", shot.previewByteSize);
        return;
      }
      if (!shot.resultObjectKey) throw notFound("This shot has no picture yet.");
      // The clip is read into memory to cut a poster from it: refuse very large clips (security review DUR-4711).
      const tooLarge = () => new HttpError(413, "This shot's clip is too large to make a picture from on the server. Play the clip instead.");
      if ((shot.resultByteSize ?? 0) > POSTER_MAX_CLIP_BYTES) throw tooLarge();
      const object = await getStorageService().getObject(companyId, shot.resultObjectKey);
      if ((object.contentLength ?? 0) > POSTER_MAX_CLIP_BYTES) {
        object.stream.resume();
        throw tooLarge();
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of object.stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > POSTER_MAX_CLIP_BYTES) throw tooLarge();
        chunks.push(buf);
      }
      const clip = Buffer.concat(chunks);
      const poster = await runMediaJob("poster", () => extractPosterJpeg(clip));
      if (!poster) throw notFound("This shot's picture could not be made (ffmpeg is not available on this server).");
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(poster.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(poster);
    },
  );

  // ─── Phase 2: your own videos and photos, order, shape, export, music ───

  router.post("/companies/:companyId/video-storylines/:storylineId/uploads", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const limits = await footage.getSettings(companyId);
    const maxBytes = Math.max(limits.maxVideoMb, limits.maxPhotoMb) * 1024 * 1024;
    const created = await withUploadSlot(companyId, () =>
      receiveFile(footageUploadFor(maxBytes), req, res, maxBytes, (file) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const consent = { showsPeople: bodyFlag(body.showsPeople), consentLikeness: bodyFlag(body.consentLikeness), consentAdults: bodyFlag(body.consentAdults) };
        return clips.createUpload(companyId, req.params.storylineId as string, file, consent, actorOf(req));
      }),
    );
    res.status(201).json(created);
  });

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId/uploads/:uploadId/consent",
    validate(updateVideoUploadConsentSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await clips.updateConsent(req.params.companyId as string, req.params.storylineId as string, req.params.uploadId as string, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/:storylineId/uploads/:uploadId", ...gatedScope(), async (req, res) => {
    await clips.deleteUpload(req.params.companyId as string, req.params.storylineId as string, req.params.uploadId as string, actorOf(req));
    res.status(204).end();
  });

  /** The light preview copy (videos) or small picture (photos) of an upload, for the strip. */
  router.get("/companies/:companyId/video-storylines/:storylineId/uploads/:uploadId/preview", ...gatedScope(), async (req, res, next) => {
    const companyId = req.params.companyId as string;
    const upload = await clips.getUpload(companyId, req.params.storylineId as string, req.params.uploadId as string);
    if (!upload.previewObjectKey) throw notFound("This upload has no preview yet.");
    await streamStored(req, res, next, companyId, upload.previewObjectKey, upload.previewContentType || "application/octet-stream", upload.previewByteSize || null);
  });

  router.get("/companies/:companyId/video-storylines/:storylineId/uploads/:uploadId/poster", ...gatedScope(), async (req, res, next) => {
    const companyId = req.params.companyId as string;
    const upload = await clips.getUpload(companyId, req.params.storylineId as string, req.params.uploadId as string);
    if (!upload.posterObjectKey) throw notFound("This upload has no picture yet.");
    await streamStored(req, res, next, companyId, upload.posterObjectKey, "image/jpeg", (upload.posterObjectKey === upload.previewObjectKey ? upload.previewByteSize : upload.posterByteSize) || null);
  });

  router.post("/companies/:companyId/video-storylines/:storylineId/clips", validate(createVideoClipSchema), ...gatedScope(), async (req, res) => {
    res.status(201).json(await clips.createClip(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
  });

  router.patch("/companies/:companyId/video-storylines/:storylineId/clips/:shotId", validate(updateVideoClipSchema), ...gatedScope(), async (req, res) => {
    await clips.updateClip(req.params.companyId as string, req.params.storylineId as string, req.params.shotId as string, req.body, actorOf(req));
    res.json({ ok: true });
  });

  router.delete("/companies/:companyId/video-storylines/:storylineId/clips/:shotId", ...gatedScope(), async (req, res) => {
    await clips.removeClip(req.params.companyId as string, req.params.storylineId as string, req.params.shotId as string, actorOf(req));
    res.status(204).end();
  });

  /** Timeline editor: cut a clip in two at a point (free; nothing is re-made). */
  router.post("/companies/:companyId/video-storylines/:storylineId/clips/:shotId/split", validate(splitVideoClipSchema), ...gatedScope(), async (req, res) => {
    res.status(201).json(await clips.splitClip(req.params.companyId as string, req.params.storylineId as string, req.params.shotId as string, req.body, actorOf(req)));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/clips/:shotId/animate",
    validate(animateVideoClipSchema),
    ...gatedScope(),
    async (req, res) => {
      res.status(202).json(await clips.animate(req.params.companyId as string, req.params.storylineId as string, req.params.shotId as string, req.body, actorOf(req)));
    },
  );

  router.put("/companies/:companyId/video-storylines/:storylineId/order", validate(reorderVideoShotsSchema), ...gatedScope(), async (req, res) => {
    await clips.reorder(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req));
    res.json({ ok: true });
  });

  router.put("/companies/:companyId/video-storylines/:storylineId/aspect", validate(updateVideoStorylineAspectSchema), ...gatedScope(), async (req, res) => {
    await clips.setAspect(req.params.companyId as string, req.params.storylineId as string, req.body.aspect, actorOf(req));
    res.json({ ok: true });
  });

  router.patch(
    "/companies/:companyId/video-storylines/:storylineId/export-settings",
    validate(updateVideoExportSettingsSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await clips.updateExportSettings(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post("/companies/:companyId/video-storylines/:storylineId/export", validate(exportVideoStorylineSchema), ...gatedScope(), async (req, res) => {
    await clips.exportAgain(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req));
    res.status(202).json({ ok: true });
  });

  router.patch("/companies/:companyId/video-storylines/:storylineId/music", validate(updateVideoMusicLaneSchema), ...gatedScope(), async (req, res) => {
    await clips.updateMusicLane(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req));
    res.json({ ok: true });
  });

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

  // ─── Directors (registered before .../:storylineId so "directors" is never read as an id) ───

  router.get("/companies/:companyId/video-storylines/directors", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await directors.list(companyId, { canEdit: canEditDirectors(req, companyId) }));
  });

  router.post(
    "/companies/:companyId/video-storylines/directors",
    validate(createVideoStorylineDirectorSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the storyline directors");
      res.status(201).json(await directors.create(companyId, req.body, actorOf(req)));
    },
  );

  router.patch(
    "/companies/:companyId/video-storylines/directors/:directorId",
    validate(updateVideoStorylineDirectorSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the storyline directors");
      res.json(await directors.update(companyId, req.params.directorId as string, req.body, actorOf(req)));
    },
  );

  router.delete("/companies/:companyId/video-storylines/directors/:directorId", ...gatedScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the storyline directors");
    await directors.remove(companyId, req.params.directorId as string, actorOf(req));
    res.status(204).end();
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
   * "Accept warnings and finish": a film parked on "needs_attention" whose
   * findings are all warnings becomes "done" as it is (no new export).
   * Refused when any finding is a real problem.
   */
  router.post(
    "/companies/:companyId/video-storylines/:storylineId/stitch/accept-warnings",
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const storylineId = req.params.storylineId as string;
      await stitch.acceptWarnings(companyId, storylineId, actorOf(req));
      res.json(await storylines.getStoryline(companyId, storylineId));
    },
  );

  /**
   * DUR-4170: streams the finished stitched film, same pattern as
   * assets.ts's GET /assets/:assetId/content -- content-type/length off the
   * stored row, inline disposition, company-scoped access via gatedScope().
   * D18: long films (up to 2 GB) are streamed from the server's disk with
   * byte ranges, so the player can seek and a download can resume without
   * the whole file ever being read into memory. `?download=1` asks the
   * browser to save it instead of playing it.
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

      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const disposition = bodyFlag(req.query.download) ? "attachment" : "inline";
      res.setHeader("Content-Disposition", contentDispositionHeader(disposition, `${storyline.title || "video-storyline"}.mp4`));
      await sendStoredObject(req, res, next, getStorageService(), {
        companyId,
        objectKey: storyline.finalObjectKey,
        byteSize: storyline.finalByteSize,
        contentType: storyline.finalContentType,
        fallbackContentType: "video/mp4",
      });
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

  // ─── AI story writer (step 1): director pick, write, questions, improvements ───

  router.put(
    "/companies/:companyId/video-storylines/:storylineId/director",
    validate(setVideoStorylineDirectorSchema),
    ...gatedScope(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.json(await directors.setStorylineDirector(companyId, req.params.storylineId as string, req.body.directorId, actorOf(req)));
    },
  );

  router.get("/companies/:companyId/video-storylines/:storylineId/writer", ...gatedScope(), async (req, res) => {
    res.json(await writer.getSession(req.params.companyId as string, req.params.storylineId as string));
  });

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/estimate",
    validate(estimateVideoStorylineWriterSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await writer.estimate(req.params.companyId as string, req.params.storylineId as string, req.body));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/write",
    validate(writeVideoStorylineSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await writer.write(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/answer",
    validate(answerVideoStorylineWriterSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await writer.answer(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/improve",
    validate(improveVideoStorylineSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(await writer.improve(req.params.companyId as string, req.params.storylineId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/changes/:messageId/accept",
    validate(acceptVideoStorylineChangesSchema),
    ...gatedScope(),
    async (req, res) => {
      res.json(
        await writer.acceptChanges(req.params.companyId as string, req.params.storylineId as string, req.params.messageId as string, req.body, actorOf(req)),
      );
    },
  );

  router.post(
    "/companies/:companyId/video-storylines/:storylineId/writer/changes/:messageId/discard",
    ...gatedScope(),
    async (req, res) => {
      res.json(await writer.discardChanges(req.params.companyId as string, req.params.storylineId as string, req.params.messageId as string, actorOf(req)));
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
