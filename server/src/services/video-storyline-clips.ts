import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@paperclipai/db";
import { assets, issueAttachments, videoMediaSpend, videoScenes, videoShots, videoStorylines, videoTransitionTakes, videoTransitions, videoUploads, withCompanyScope } from "@paperclipai/db";
import {
  VIDEO_CLIP_MAX_SECONDS,
  VIDEO_CLIP_MIN_MS,
  VIDEO_CREDITS_MAX_CHARS,
  VIDEO_PHOTO_DEFAULT_SECONDS,
  VIDEO_STORYLINE_MAX_SHOTS,
  VIDEO_TITLE_MAX_CHARS,
  VIDEO_UPLOAD_PHOTO_TYPES,
  VIDEO_UPLOAD_VIDEO_TYPES,
  cleanVideoTitleText,
  readVideoExportSettings,
  videoExportPreset,
  videoExportPresetForAspect,
  type AnimateVideoClipInput,
  type CreateVideoClipInput,
  type ExportVideoStorylineInput,
  type ReorderVideoShotsInput,
  type SplitVideoClipInput,
  type UpdateVideoClipInput,
  type UpdateVideoExportSettingsInput,
  type UpdateVideoMusicLaneInput,
  type UpdateVideoUploadConsentInput,
  type VideoMusicChoice,
  type VideoStorylineAspect,
  type VideoStorylineExportSettings,
  type VideoUploadSummary,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { runMediaJob } from "./media-job-queue.js";
import { processUploadedVideo, renderStillClip, prepareTrimmedClip, sniffAudioContainer, UploadProcessingError } from "./video-ffmpeg.js";
import {
  companyMonthlyMediaSpendCents,
  companyStorageUsedBytes,
  STORYLINE_MUSIC_NAMESPACE,
  toUploadSummary,
  uploadByteSize,
  videoStorylineFootageService,
} from "./video-storyline-footage.js";
import { refreshStorylineMediaSpend, reserveStorylineMediaSpend, storylineAnimateSpendCode } from "./storyline-media-ledger.js";
import { estimateShotRenderCents, shotClipTiming, videoStorylineRenderService } from "./video-storyline-render.js";
import { videoStorylineSettingsService } from "./video-storyline-settings.js";
import { videoStorylineStitchService } from "./video-storyline-stitch.js";
import { applyShotOrder, assertStorylineEditable, lockStorylineRow, videoStorylineService, type ScopedTx, type VideoStorylineActor } from "./video-storylines.js";
import type { HelperServiceOptions } from "./helper.js";

/**
 * Storyline Simple editor, Phase 2 (design 2.5-2.7): the company's own
 * videos and photos as clips, drag-to-reorder, the picture shape, export
 * settings ("Export again" without re-rendering), the music lane, and
 * "animate this photo" (the one new paid step).
 *
 * Heavy work (converting an upload, cutting a clip, turning a photo into a
 * clip) never runs in the request: rows are queued and the scheduler tick
 * does it through the media job queue (at most a couple of ffmpeg jobs at
 * once on the shared box), with execFile and argument arrays only.
 */

type StorylineRow = typeof videoStorylines.$inferSelect;
type ShotRow = typeof videoShots.$inferSelect;
type UploadRow = typeof videoUploads.$inferSelect;

const PHOTO_MAX_EDGE = 2048;
const PHOTO_PREVIEW_EDGE = 480;
const MUSIC_MAX_BYTES = 50 * 1024 * 1024;
const PREPARE_TICK_BATCH = 3;
const UPLOAD_TICK_BATCH = 1;
const PREPARE_STALE_MS = 30 * 60_000;
const CLEANUP_EVERY_MS = 60 * 60_000;
const CLEANUP_BATCH = 200;

export interface IncomingFile {
  buffer: Buffer;
  originalName: string | null;
  contentType: string;
  size: number;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function mb(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Which kind of upload a file is, from its type (or its name when the browser sent none). */
export function uploadKindFor(contentType: string, fileName: string | null): "video" | "photo" | null {
  const type = contentType.toLowerCase().split(";")[0]!.trim();
  if ((VIDEO_UPLOAD_VIDEO_TYPES as readonly string[]).includes(type)) return "video";
  if ((VIDEO_UPLOAD_PHOTO_TYPES as readonly string[]).includes(type)) return "photo";
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  if (["mp4", "mov", "m4v", "webm", "3gp"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext)) return "photo";
  return null;
}

/**
 * Scenes stay in one block each, in scene order: a shot dragged among
 * another scene's shots joins that scene (the scene of the shot before it,
 * or the next one when it is first). Pure; returns the scene per shot.
 */
export function sceneBlocksFor(order: ReadonlyArray<{ id: string; sceneId: string }>, sceneOrder: ReadonlyMap<string, number>): Map<string, string> {
  const out = new Map<string, string>();
  let previousScene: string | null = null;
  for (const [index, shot] of order.entries()) {
    let scene = shot.sceneId;
    if (previousScene === null) {
      // First shot: if a later shot's scene comes earlier, take the earliest scene that follows.
      const next = order[index + 1];
      if (next && (sceneOrder.get(next.sceneId) ?? 0) < (sceneOrder.get(scene) ?? 0)) scene = next.sceneId;
    } else if ((sceneOrder.get(scene) ?? 0) < (sceneOrder.get(previousScene) ?? 0)) {
      scene = previousScene;
    }
    out.set(shot.id, scene);
    previousScene = scene;
  }
  return out;
}

/** A clip's trim checked against the video's length: at least half a second, at most 60 seconds. */
export function checkTrim(durationMs: number, trimInMs: number, trimOutMs: number): string | null {
  if (trimInMs < 0 || trimInMs >= durationMs) return "The start of the clip must be inside the video.";
  if (trimOutMs > durationMs + 50) return "The end of the clip is after the end of the video.";
  if (trimOutMs - trimInMs < VIDEO_CLIP_MIN_MS) return "A clip must be at least half a second long.";
  if (trimOutMs - trimInMs > VIDEO_CLIP_MAX_SECONDS * 1000) return `A clip can be at most ${VIDEO_CLIP_MAX_SECONDS} seconds. Shorten it, or add the video again for the next part.`;
  return null;
}

/**
 * Consent is a person's word: only a signed-in person (never an agent) can
 * tick "everyone agreed to their likeness being used" or "everyone shown is
 * an adult". An agent may still upload or change an upload with both boxes
 * unticked -- which also clears ticks a person made earlier, so the footage
 * cannot leave the server until a person ticks them again.
 */
export function assertConsentByPerson(actor: Pick<VideoStorylineActor, "actorType">, consent: { consentLikeness: boolean; consentAdults: boolean }): void {
  if (actor.actorType !== "user" && (consent.consentLikeness || consent.consentAdults)) {
    throw forbidden("Only a person can tick the consent boxes (likeness and adults). Upload it with the boxes unticked; a person in the company can tick them on the clip.");
  }
}

export interface VideoStorylineClipsDeps {
  now?: () => Date;
  modelOptions?: HelperServiceOptions;
}

export function videoStorylineClipsService(db: Db, deps: VideoStorylineClipsDeps = {}) {
  const storylines = videoStorylineService(db);
  const settings = videoStorylineSettingsService(db);
  const render = videoStorylineRenderService(db, { now: deps.now });
  const stitch = videoStorylineStitchService(db, { now: deps.now });
  const footage = videoStorylineFootageService(db, { now: deps.now, modelOptions: deps.modelOptions });
  const nowOf = () => deps.now?.() ?? new Date();
  let lastCleanupAt = 0;

  function assertStripEditable(storyline: Pick<StorylineRow, "status">): void {
    if (storyline.status === "stitching") throw conflict("The film is being combined right now. Wait for it to finish, then try again.");
    if (storyline.status === "rendering") throw conflict("Shots are being made right now. Wait for them to finish (or pause the render), then try again.");
  }

  async function download(companyId: string, objectKey: string): Promise<Buffer> {
    const object = await getStorageService().getObject(companyId, objectKey);
    return streamToBuffer(object.stream);
  }

  async function deleteObjects(companyId: string, keys: Array<string | null | undefined>): Promise<void> {
    const storage = getStorageService();
    for (const key of keys) {
      if (!key) continue;
      await storage.deleteObject(companyId, key).catch((err: unknown) => logger.warn({ err, key }, "video-storyline-clips: could not delete a stored file"));
    }
  }

  function actorFields(actor: VideoStorylineActor) {
    return { createdByUserId: actor.actorType === "user" ? actor.actorId : null, createdByAgentId: actor.agentId };
  }

  async function log(companyId: string, actor: VideoStorylineActor, action: string, storylineId: string, details: Record<string, unknown>) {
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action, entityType: "video_storyline", entityId: storylineId, details });
  }

  // ─── Uploads ───

  /**
   * Stores an upload for a storyline. The size limit and the company's
   * storage quota are checked first (the quota under a per-company lock, so
   * two uploads at once cannot both squeeze past it). Photos are made ready
   * here (quick); videos are converted by the tick.
   */
  async function createUpload(
    companyId: string,
    storylineId: string,
    file: IncomingFile,
    consent: UpdateVideoUploadConsentInput,
    actor: VideoStorylineActor,
  ): Promise<VideoUploadSummary> {
    await settings.assertAdvancedEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    const kind = uploadKindFor(file.contentType, file.originalName);
    if (!kind) throw new HttpError(415, "That file type can't be used. Upload a video (MP4, MOV, WebM) or a photo (JPEG, PNG, WebP, HEIC).");
    assertConsentByPerson(actor, consent);
    // A person marking "shows people" ticks both boxes now; an agent leaves them for a person to tick later.
    if (consent.showsPeople && !(consent.consentLikeness && consent.consentAdults) && actor.actorType === "user") {
      throw unprocessable("This upload shows people, so tick both boxes first: everyone shown agreed to their likeness being used, and everyone shown is an adult.");
    }
    const limits = await footage.getSettings(companyId);
    const maxBytes = (kind === "video" ? limits.maxVideoMb : limits.maxPhotoMb) * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new HttpError(413, `This ${kind} is ${mb(file.size)}; this company allows ${kind === "video" ? "videos" : "photos"} up to ${mb(maxBytes)}. Make it smaller (shorter, or a lower resolution) and upload it again.`);
    }
    const storage = getStorageService();
    const namespace = `video-storylines/${storyline.id}/uploads`;
    const stored: string[] = [];
    let values: Partial<typeof videoUploads.$inferInsert>;
    if (kind === "photo") {
      const processed = await runMediaJob("upload photo", async () => {
        try {
          // rotate() applies the phone's orientation; metadata (GPS, camera) is not kept.
          const base = sharp(file.buffer, { failOn: "error" }).rotate();
          const working = await base.clone().resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
          const preview = await sharp(working.data).resize(PHOTO_PREVIEW_EDGE, PHOTO_PREVIEW_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
          return { working, preview };
        } catch {
          throw unprocessable("This photo could not be read. Save it as a JPEG or PNG and upload it again.");
        }
      });
      const workingStored = await storage.putFile({ companyId, namespace, originalFilename: "photo.jpg", contentType: "image/jpeg", body: processed.working.data });
      stored.push(workingStored.objectKey);
      const previewStored = await storage.putFile({ companyId, namespace, originalFilename: "photo-preview.jpg", contentType: "image/jpeg", body: processed.preview });
      stored.push(previewStored.objectKey);
      values = {
        status: "ready",
        objectKey: workingStored.objectKey,
        contentType: "image/jpeg",
        workingByteSize: workingStored.byteSize,
        sha256: workingStored.sha256,
        previewObjectKey: previewStored.objectKey,
        previewContentType: "image/jpeg",
        previewByteSize: previewStored.byteSize,
        posterObjectKey: previewStored.objectKey,
        width: processed.working.info.width,
        height: processed.working.info.height,
      };
    } else {
      const raw = await storage.putFile({ companyId, namespace, originalFilename: "raw-upload", contentType: file.contentType || "application/octet-stream", body: file.buffer });
      stored.push(raw.objectKey);
      values = { status: "processing", rawObjectKey: raw.objectKey, rawByteSize: raw.byteSize };
    }
    const incoming = Number(values.rawByteSize ?? 0) + Number(values.workingByteSize ?? 0) + Number(values.previewByteSize ?? 0);
    let row: UploadRow;
    try {
      row = await withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video_upload_quota:${companyId}`}, 0))`);
        const usedBytes = await companyStorageUsedBytes(tx, companyId);
        if (usedBytes + incoming > limits.storageQuotaBytes) {
          throw new HttpError(
            413,
            `This company's uploads would take ${gb(usedBytes + incoming)}, over its ${gb(limits.storageQuotaBytes)} storage limit. Remove uploads you no longer use, or ask an owner or admin to raise the limit.`,
          );
        }
        const [inserted] = await tx
          .insert(videoUploads)
          .values({
            companyId,
            storylineId,
            kind,
            originalFilename: file.originalName?.slice(0, 255) ?? null,
            sourceContentType: file.contentType.slice(0, 100) || "application/octet-stream",
            showsPeople: consent.showsPeople,
            consentLikeness: consent.consentLikeness,
            consentAdults: consent.consentAdults,
            consentByUserId: actor.actorType === "user" ? actor.actorId : null,
            consentAt: nowOf(),
            ...values,
            ...actorFields(actor),
            createdAt: nowOf(),
            updatedAt: nowOf(),
          })
          .returning();
        return inserted!;
      });
    } catch (err) {
      await deleteObjects(companyId, stored);
      throw err;
    }
    await log(companyId, actor, "video_storyline.upload_added", storylineId, { uploadId: row.id, kind, byteSize: incoming, showsPeople: consent.showsPeople });
    return toUploadSummary(row, false);
  }

  async function uploadOf(companyId: string, storylineId: string, uploadId: string): Promise<UploadRow> {
    const upload = await footage.getUpload(companyId, uploadId);
    if (upload.storylineId !== storylineId) throw notFound("That upload is not part of this storyline.");
    return upload;
  }

  async function inUse(uploadId: string): Promise<boolean> {
    const [row] = await db.select({ id: videoShots.id }).from(videoShots).where(eq(videoShots.sourceUploadId, uploadId)).limit(1);
    return Boolean(row);
  }

  async function updateConsent(companyId: string, storylineId: string, uploadId: string, input: UpdateVideoUploadConsentInput, actor: VideoStorylineActor): Promise<VideoUploadSummary> {
    await settings.assertAdvancedEnabled(companyId);
    const upload = await uploadOf(companyId, storylineId, uploadId);
    assertConsentByPerson(actor, input);
    if (input.showsPeople && !(input.consentLikeness && input.consentAdults) && actor.actorType === "user") {
      throw unprocessable("This upload shows people, so tick both boxes: everyone shown agreed to their likeness being used, and everyone shown is an adult.");
    }
    const [row] = await db
      .update(videoUploads)
      .set({ ...input, consentByUserId: actor.actorType === "user" ? actor.actorId : null, consentAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(videoUploads.id, upload.id), eq(videoUploads.companyId, companyId)))
      .returning();
    await log(companyId, actor, "video_storyline.upload_consent_updated", storylineId, { uploadId, ...input });
    return toUploadSummary(row!, await inUse(upload.id));
  }

  async function deleteUpload(companyId: string, storylineId: string, uploadId: string, actor: VideoStorylineActor): Promise<void> {
    await settings.assertAdvancedEnabled(companyId);
    const upload = await uploadOf(companyId, storylineId, uploadId);
    if (await inUse(upload.id)) throw conflict("This upload is used by a clip in the film. Remove the clip first.");
    await db.delete(videoUploads).where(and(eq(videoUploads.id, upload.id), eq(videoUploads.companyId, companyId)));
    await deleteObjects(companyId, [upload.rawObjectKey, upload.objectKey, upload.previewObjectKey, upload.posterObjectKey !== upload.previewObjectKey ? upload.posterObjectKey : null]);
    await log(companyId, actor, "video_storyline.upload_deleted", storylineId, { uploadId });
  }

  /** Tick: converts uploaded videos (HDR fix, constant frame rate, preview, poster), one at a time. */
  async function processUploads(): Promise<{ processed: number; failed: number }> {
    const pending = await db
      .select()
      .from(videoUploads)
      .where(and(eq(videoUploads.status, "processing"), isNotNull(videoUploads.rawObjectKey)))
      .orderBy(asc(videoUploads.createdAt))
      .limit(UPLOAD_TICK_BATCH);
    let processed = 0;
    let failed = 0;
    for (const upload of pending) {
      const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, upload.storylineId));
      const limits = await footage.getSettings(upload.companyId);
      try {
        const raw = await download(upload.companyId, upload.rawObjectKey!);
        const fps = readVideoExportSettings(storyline?.exportSettings ?? {}, storyline?.aspect ?? "16:9").fps;
        const result = await runMediaJob(`upload ${upload.id}`, () => processUploadedVideo(raw, { fps, maxSeconds: limits.maxVideoSeconds }));
        const storage = getStorageService();
        const namespace = `video-storylines/${upload.storylineId}/uploads`;
        const working = await storage.putFile({ companyId: upload.companyId, namespace, originalFilename: "video.mp4", contentType: "video/mp4", body: result.working });
        const preview = await storage.putFile({ companyId: upload.companyId, namespace, originalFilename: "video-preview.mp4", contentType: "video/mp4", body: result.preview });
        const poster = await storage.putFile({ companyId: upload.companyId, namespace, originalFilename: "video-poster.jpg", contentType: "image/jpeg", body: result.poster });
        await db
          .update(videoUploads)
          .set({
            status: "ready",
            rawObjectKey: null,
            rawByteSize: 0,
            objectKey: working.objectKey,
            contentType: "video/mp4",
            workingByteSize: working.byteSize,
            sha256: working.sha256,
            previewObjectKey: preview.objectKey,
            previewContentType: "video/mp4",
            previewByteSize: preview.byteSize,
            posterObjectKey: poster.objectKey,
            posterByteSize: poster.byteSize,
            durationMs: Math.round(result.output.durationSeconds * 1000),
            width: result.output.width,
            height: result.output.height,
            sourceFpsMilli: result.media.averageFps ? Math.round(result.media.averageFps * 1000) : null,
            wasHdr: result.wasHdr,
            wasVariableFrameRate: result.wasVariableFrameRate,
            hasAudio: result.media.hasAudio,
            error: result.note,
            updatedAt: nowOf(),
          })
          .where(eq(videoUploads.id, upload.id));
        await deleteObjects(upload.companyId, [upload.rawObjectKey]);
        processed += 1;
      } catch (err) {
        const message =
          err instanceof UploadProcessingError || err instanceof HttpError
            ? err.message
            : "This video could not be converted. Try saving it as an MP4 and upload it again.";
        logger.warn({ err, uploadId: upload.id }, "video-storyline-clips: upload could not be processed");
        await db.update(videoUploads).set({ status: "failed", error: message, rawObjectKey: null, rawByteSize: 0, updatedAt: nowOf() }).where(eq(videoUploads.id, upload.id));
        await deleteObjects(upload.companyId, [upload.rawObjectKey]);
        failed += 1;
      }
    }
    return { processed, failed };
  }

  // ─── Clips ───

  async function orderedShots(executor: Db | ScopedTx, storylineId: string) {
    return executor
      .select({ id: videoShots.id, sceneId: videoShots.sceneId, orderIndex: videoShots.orderIndex })
      .from(videoShots)
      .where(eq(videoShots.storylineId, storylineId))
      .orderBy(asc(videoShots.orderIndex));
  }

  /** Writes a full play order, moving shots between scenes only where needed to keep each scene in one block. */
  async function writeOrder(tx: ScopedTx, storylineId: string, order: Array<{ id: string; sceneId: string }>): Promise<void> {
    const scenes = await tx.select({ id: videoScenes.id, orderIndex: videoScenes.orderIndex }).from(videoScenes).where(eq(videoScenes.storylineId, storylineId));
    const sceneOrder = new Map(scenes.map((s) => [s.id, s.orderIndex]));
    const sceneFor = sceneBlocksFor(order, sceneOrder);
    for (const shot of order) {
      const scene = sceneFor.get(shot.id)!;
      if (scene !== shot.sceneId) await tx.update(videoShots).set({ sceneId: scene, updatedAt: nowOf() }).where(eq(videoShots.id, shot.id));
    }
    await applyShotOrder(tx, storylineId, order.map((s) => s.id));
  }

  async function createClip(companyId: string, storylineId: string, input: CreateVideoClipInput, actor: VideoStorylineActor): Promise<{ shotId: string }> {
    await settings.assertAdvancedEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStripEditable(storyline);
    const upload = await uploadOf(companyId, storylineId, input.uploadId);
    if (upload.status !== "ready") throw conflict(upload.status === "failed" ? upload.error ?? "This upload could not be used." : "This upload is still being prepared. Try again in a moment.");
    let clip: Partial<typeof videoShots.$inferInsert>;
    const name = upload.originalFilename ? `"${upload.originalFilename.slice(0, 80)}"` : "";
    if (upload.kind === "video") {
      const durationMs = upload.durationMs ?? 0;
      const trimInMs = input.trimInMs ?? 0;
      const trimOutMs = input.trimOutMs ?? Math.min(durationMs, trimInMs + VIDEO_CLIP_MAX_SECONDS * 1000);
      const problem = checkTrim(durationMs, trimInMs, trimOutMs);
      if (problem) throw unprocessable(problem);
      clip = {
        clipKind: "uploaded_video",
        prompt: `Your video ${name}`.trim(),
        sourceTrimInMs: trimInMs,
        sourceTrimOutMs: trimOutMs,
        durationSeconds: Math.max(1, Math.min(VIDEO_CLIP_MAX_SECONDS, Math.round((trimOutMs - trimInMs) / 1000))),
      };
    } else {
      const seconds = input.holdSeconds ?? VIDEO_PHOTO_DEFAULT_SECONDS;
      clip = {
        clipKind: "still",
        prompt: `Your photo ${name}`.trim(),
        stillMotion: input.stillMotion ?? "hold",
        durationSeconds: seconds,
        // The photo is this clip's picture (poster, transition end picture, and the start picture if animated).
        stillProvider: getStorageService().provider,
        stillObjectKey: upload.objectKey,
        stillContentType: "image/jpeg",
        stillByteSize: upload.workingByteSize,
        stillSha256: upload.sha256,
        stillGeneratedAt: nowOf(),
      };
    }
    const shotId = await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      const order = await orderedShots(tx, storylineId);
      if (order.length >= VIDEO_STORYLINE_MAX_SHOTS) throw unprocessable(`A storyline may have at most ${VIDEO_STORYLINE_MAX_SHOTS} clips.`);
      const afterIndex = input.afterShotId ? order.findIndex((s) => s.id === input.afterShotId) : order.length - 1;
      if (input.afterShotId && afterIndex < 0) throw notFound("The clip to put it after is not in this storyline.");
      let sceneId = afterIndex >= 0 ? order[afterIndex]!.sceneId : null;
      if (!sceneId) {
        const [lastScene] = await tx.select().from(videoScenes).where(eq(videoScenes.storylineId, storylineId)).orderBy(desc(videoScenes.orderIndex)).limit(1);
        sceneId =
          lastScene?.id ??
          (await tx
            .insert(videoScenes)
            .values({ companyId, storylineId, orderIndex: 0, title: "Your clips", createdAt: nowOf(), updatedAt: nowOf() })
            .returning()
            .then((rows) => rows[0]!.id));
      }
      const [inserted] = await tx
        .insert(videoShots)
        .values({
          companyId,
          storylineId,
          sceneId,
          orderIndex: 2_000_000 + order.length,
          prompt: clip.prompt!,
          durationSeconds: clip.durationSeconds!,
          sourceUploadId: upload.id,
          storyboardStatus: "approved",
          status: "queued",
          ...clip,
          createdAt: nowOf(),
          updatedAt: nowOf(),
        })
        .returning();
      const next = [...order.slice(0, afterIndex + 1), { id: inserted!.id, sceneId, orderIndex: 0 }, ...order.slice(afterIndex + 1)];
      await writeOrder(tx, storylineId, next);
      return inserted!.id;
    });
    await log(companyId, actor, "video_storyline.clip_added", storylineId, { shotId, uploadId: upload.id, kind: clip.clipKind });
    return { shotId };
  }

  async function updateClip(companyId: string, storylineId: string, shotId: string, input: UpdateVideoClipInput, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStripEditable(storyline);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    const changes: Partial<typeof videoShots.$inferInsert> = {};
    if (input.muted !== undefined) changes.clipMuted = input.muted;
    if (input.volumeDb !== undefined) changes.clipVolumeDb = input.volumeDb;
    const reshapes = input.trimInMs !== undefined || input.trimOutMs !== undefined || input.stillMotion !== undefined || input.holdSeconds !== undefined;
    if (reshapes && shot.clipKind === "generated") {
      // Timeline editor: a made AI clip can be trimmed inside its own length (applied when the film is combined; nothing is re-made).
      if (input.stillMotion !== undefined || input.holdSeconds !== undefined) throw unprocessable("Photo motion and length are for photos. Change an AI shot's length in the storyboard or on the timeline.");
      if (shot.status !== "done" || !shot.resultObjectKey) {
        throw unprocessable("This AI shot isn't made yet, so there is nothing to trim. Change its length instead; it is trimmed after it is made.");
      }
      const fullMs = shotClipTiming(storyline, shot).sourceLengthMs ?? shot.durationSeconds * 1000;
      const trimInMs = input.trimInMs ?? shot.sourceTrimInMs ?? 0;
      const trimOutMs = input.trimOutMs === null ? fullMs : input.trimOutMs ?? shot.sourceTrimOutMs ?? fullMs;
      const problem = checkTrim(fullMs, trimInMs, trimOutMs);
      if (problem) throw unprocessable(problem.replace("the video", "the clip"));
      // Back to "no trim" when it covers the whole clip, so nothing changes for an untouched clip.
      Object.assign(changes, {
        sourceTrimInMs: trimInMs > 0 ? trimInMs : null,
        sourceTrimOutMs: trimOutMs < fullMs ? trimOutMs : null,
      });
    } else if (reshapes) {
      if (shot.status === "rendering") throw conflict("This clip is being prepared right now. Try again in a moment.");
      const upload = shot.sourceUploadId ? await footage.getUpload(companyId, shot.sourceUploadId) : null;
      if (!upload) throw conflict("This clip's upload is gone. Remove the clip and add the file again.");
      if (shot.clipKind === "uploaded_video") {
        if (input.stillMotion !== undefined || input.holdSeconds !== undefined) throw unprocessable("Photo motion and length are for photos; use the trim for a video.");
        const trimInMs = input.trimInMs ?? shot.sourceTrimInMs ?? 0;
        const trimOutMs = input.trimOutMs ?? shot.sourceTrimOutMs ?? Math.min(upload.durationMs ?? 0, trimInMs + VIDEO_CLIP_MAX_SECONDS * 1000);
        const problem = checkTrim(upload.durationMs ?? 0, trimInMs, trimOutMs);
        if (problem) throw unprocessable(problem);
        Object.assign(changes, {
          sourceTrimInMs: trimInMs,
          sourceTrimOutMs: trimOutMs,
          durationSeconds: Math.max(1, Math.min(VIDEO_CLIP_MAX_SECONDS, Math.round((trimOutMs - trimInMs) / 1000))),
        });
      } else {
        if (input.trimInMs !== undefined || input.trimOutMs !== undefined) throw unprocessable("A photo has no trim; set how long it shows instead.");
        if (input.stillMotion !== undefined) changes.stillMotion = input.stillMotion;
        if (input.holdSeconds !== undefined) changes.durationSeconds = input.holdSeconds;
      }
      Object.assign(changes, { status: "queued", errorMessage: null, resultProvider: null, resultObjectKey: null, resultContentType: null, resultByteSize: null, resultSha256: null });
    }
    if (Object.keys(changes).length === 0) return;
    await db
      .update(videoShots)
      .set({ ...changes, updatedAt: nowOf() })
      .where(and(eq(videoShots.id, shot.id), eq(videoShots.companyId, companyId)));
    await log(companyId, actor, "video_storyline.clip_updated", storylineId, { shotId, fields: Object.keys(input) });
  }

  async function removeClip(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    // Timeline editor: any clip can be removed from the film, an AI shot too (the page asks first, with what remaking it would cost).
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      if (shot.status === "rendering" && shot.clipKind === "generated") throw conflict("This clip is being animated right now. Wait for it to finish.");
      await tx.delete(videoShots).where(and(eq(videoShots.id, shot.id), eq(videoShots.companyId, companyId)));
      const order = await orderedShots(tx, storylineId);
      await applyShotOrder(tx, storylineId, order.map((s) => s.id));
    });
    await log(companyId, actor, "video_storyline.clip_removed", storylineId, { shotId });
  }

  /**
   * Timeline editor: cut one clip into two at `atMs` (measured from the start
   * of what is shown of it). Nothing is re-made or paid for:
   *  - a made AI clip becomes two trims of the same clip;
   *  - an AI shot not made yet becomes two shorter shots (whole seconds) with
   *    the same description and approved picture (each is made on its own);
   *  - your video becomes two trims of the same upload (cut again, free);
   *  - a photo becomes two photo clips (whole seconds).
   * The join after the original clip moves to the new second part.
   */
  async function splitClip(companyId: string, storylineId: string, shotId: string, input: SplitVideoClipInput, actor: VideoStorylineActor): Promise<{ shotId: string }> {
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStripEditable(storyline);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.status === "queued" || shot.status === "rendering") throw conflict("This clip is being made right now. Split it once it is ready.");
    const upload = shot.sourceUploadId ? await footage.getUpload(companyId, shot.sourceUploadId).catch(() => null) : null;
    const timing = shotClipTiming(storyline, shot, upload?.durationMs ?? null);
    const at = input.atMs;
    const made = shot.clipKind === "generated" && shot.status === "done" && Boolean(shot.resultObjectKey);
    const wholeSeconds = shot.clipKind === "still" || (shot.clipKind === "generated" && !made);
    if (wholeSeconds) {
      const firstSeconds = Math.round(at / 1000);
      if (firstSeconds < 1 || shot.durationSeconds - firstSeconds < 1) {
        throw unprocessable(
          shot.clipKind === "still"
            ? "A photo is split in whole seconds, and each part needs at least 1 second. Move the playhead and try again."
            : "An AI shot that isn't made yet is split in whole seconds, and each part needs at least 1 second. Move the playhead and try again.",
        );
      }
    } else if (at < VIDEO_CLIP_MIN_MS || timing.playMs - at < VIDEO_CLIP_MIN_MS) {
      throw unprocessable("Split a little further from the clip's edges: each part must be at least half a second long.");
    }
    if (shot.clipKind === "generated" && !made) assertStorylineEditable(storyline);

    let firstChanges: Partial<typeof videoShots.$inferInsert>;
    let secondFields: Partial<typeof videoShots.$inferInsert>;
    const cleared = { resultProvider: null, resultObjectKey: null, resultContentType: null, resultByteSize: null, resultSha256: null, errorMessage: null };
    if (made) {
      const inMs = shot.sourceTrimInMs ?? 0;
      const cut = inMs + at;
      firstChanges = { sourceTrimInMs: inMs > 0 ? inMs : null, sourceTrimOutMs: cut };
      // The second part shares the clip (already paid for once: counted on the first part only).
      secondFields = { sourceTrimInMs: cut, sourceTrimOutMs: shot.sourceTrimOutMs, actualCostCents: 0 };
    } else if (shot.clipKind === "generated") {
      const firstSeconds = Math.round(at / 1000);
      firstChanges = { durationSeconds: firstSeconds };
      secondFields = { durationSeconds: shot.durationSeconds - firstSeconds, status: "draft", ...cleared, actualCostCents: null };
    } else if (shot.clipKind === "uploaded_video") {
      if (!upload) throw conflict("This clip's upload is gone. Remove the clip and add the file again.");
      const inMs = shot.sourceTrimInMs ?? 0;
      const outMs = shot.sourceTrimOutMs ?? upload.durationMs ?? inMs + timing.playMs;
      const cut = inMs + at;
      const secondsOf = (ms: number) => Math.max(1, Math.min(VIDEO_CLIP_MAX_SECONDS, Math.round(ms / 1000)));
      firstChanges = { sourceTrimInMs: inMs, sourceTrimOutMs: cut, durationSeconds: secondsOf(cut - inMs), status: "queued", ...cleared };
      secondFields = { sourceTrimInMs: cut, sourceTrimOutMs: outMs, durationSeconds: secondsOf(outMs - cut), status: "queued", ...cleared, actualCostCents: 0 };
    } else {
      const firstSeconds = Math.round(at / 1000);
      firstChanges = { durationSeconds: firstSeconds, status: "queued", ...cleared };
      secondFields = { durationSeconds: shot.durationSeconds - firstSeconds, status: "queued", ...cleared, actualCostCents: 0 };
    }

    const newId = await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, shot.id), eq(videoShots.storylineId, storylineId)));
      if (!current || current.status !== shot.status || current.updatedAt.getTime() !== shot.updatedAt.getTime()) {
        throw conflict("This clip changed while you were splitting it. Look at it again and split once more.");
      }
      const order = await orderedShots(tx, storylineId);
      if (order.length >= VIDEO_STORYLINE_MAX_SHOTS) throw unprocessable(`A storyline may have at most ${VIDEO_STORYLINE_MAX_SHOTS} clips.`);
      const {
        id: _id,
        orderIndex: _orderIndex,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        proposedPrompt: _pp,
        proposedCameraNotes: _pc,
        proposedDurationSeconds: _pd,
        proposedTransitionIn: _pt,
        proposalStatus: _ps,
        proposalConversationId: _pcid,
        ...copy
      } = current;
      const [inserted] = await tx
        .insert(videoShots)
        .values({ ...copy, promptHistory: [], transitionIn: null, orderIndex: 2_000_000 + order.length, ...secondFields, createdAt: nowOf(), updatedAt: nowOf() })
        .returning({ id: videoShots.id });
      await tx.update(videoShots).set({ ...firstChanges, updatedAt: nowOf() }).where(eq(videoShots.id, shot.id));
      const at = order.findIndex((o) => o.id === shot.id);
      const next = order[at + 1] ?? null;
      const withNew = [...order.slice(0, at + 1), { id: inserted!.id, sceneId: current.sceneId, orderIndex: 0 }, ...order.slice(at + 1)];
      await writeOrder(tx, storylineId, withNew);
      // The join after the original clip now sits after its second part (an AI bridge is made for two pictures, so it stays and goes out of date).
      if (next) {
        await tx
          .update(videoTransitions)
          .set({ fromShotId: inserted!.id, updatedAt: nowOf() })
          .where(and(eq(videoTransitions.storylineId, storylineId), eq(videoTransitions.fromShotId, shot.id), eq(videoTransitions.toShotId, next.id), ne(videoTransitions.kind, "ai")));
      }
      // The same people are in both parts.
      const settingsJson = (locked.pictureSettings ?? {}) as Record<string, unknown>;
      const shotCast = settingsJson.shotCast as Record<string, string[]> | undefined;
      if (shotCast?.[shot.id]) {
        await tx
          .update(videoStorylines)
          .set({ pictureSettings: { ...settingsJson, shotCast: { ...shotCast, [inserted!.id]: [...shotCast[shot.id]!] } } as StorylineRow["pictureSettings"], updatedAt: nowOf() })
          .where(eq(videoStorylines.id, storylineId));
      }
      return inserted!.id;
    });
    if (shot.clipKind === "generated" && !made) await storylines.recomputeEstimate(companyId, storylineId);
    await log(companyId, actor, "video_storyline.clip_split", storylineId, { shotId, newShotId: newId, atMs: at });
    return { shotId: newId };
  }

  /** Drag to reorder: the whole new order at once. Gaps between new neighbours start as the default join (AI bridges are keyed by the pair of clips). */
  async function reorder(companyId: string, storylineId: string, input: ReorderVideoShotsInput, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      const current = await orderedShots(tx, storylineId);
      const ids = new Set(input.shotIds);
      if (ids.size !== input.shotIds.length || current.length !== input.shotIds.length || current.some((s) => !ids.has(s.id))) {
        throw conflict("The clips changed while you were moving them. Refresh the strip and try again.");
      }
      const byId = new Map(current.map((s) => [s.id, s]));
      await writeOrder(tx, storylineId, input.shotIds.map((id) => byId.get(id)!));
    });
    await log(companyId, actor, "video_storyline.clips_reordered", storylineId, { count: input.shotIds.length });
  }

  /** Tick: cuts uploaded videos to their trim and turns photos into clips (free, ffmpeg). */
  async function prepareClips(): Promise<{ prepared: number; failed: number }> {
    // A clip left half-prepared by a restart goes back in the queue.
    await db
      .update(videoShots)
      .set({ status: "queued", updatedAt: nowOf() })
      .where(and(ne(videoShots.clipKind, "generated"), eq(videoShots.status, "rendering"), lt(videoShots.updatedAt, new Date(nowOf().getTime() - PREPARE_STALE_MS))));
    const queued = await db
      .select()
      .from(videoShots)
      .where(and(ne(videoShots.clipKind, "generated"), eq(videoShots.status, "queued")))
      .orderBy(asc(videoShots.updatedAt))
      .limit(PREPARE_TICK_BATCH);
    let prepared = 0;
    let failed = 0;
    for (const candidate of queued) {
      const [shot] = await db
        .update(videoShots)
        .set({ status: "rendering", updatedAt: nowOf() })
        .where(and(eq(videoShots.id, candidate.id), eq(videoShots.status, "queued")))
        .returning();
      if (!shot) continue;
      try {
        const upload = shot.sourceUploadId ? (await db.select().from(videoUploads).where(and(eq(videoUploads.id, shot.sourceUploadId), eq(videoUploads.companyId, shot.companyId))))[0] : undefined;
        if (!upload?.objectKey) throw new UploadProcessingError("This clip's upload is gone. Remove the clip and add the file again.");
        const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, shot.storylineId));
        const exportSettings = readVideoExportSettings(storyline?.exportSettings ?? {}, storyline?.aspect ?? "16:9");
        const preset = videoExportPreset(exportSettings.preset);
        const source = await download(shot.companyId, upload.objectKey);
        const clip = await runMediaJob(`prepare clip ${shot.id}`, () =>
          shot.clipKind === "uploaded_video"
            ? prepareTrimmedClip(source, shot.sourceTrimInMs ?? 0, (shot.sourceTrimOutMs ?? upload.durationMs ?? 1000) - (shot.sourceTrimInMs ?? 0))
            : renderStillClip(source, {
                seconds: shot.durationSeconds,
                motion: shot.stillMotion === "slow_zoom" ? "slow_zoom" : "hold",
                source: { width: upload.width ?? preset.width, height: upload.height ?? preset.height },
                target: { width: preset.width, height: preset.height, fps: exportSettings.fps, fit: exportSettings.fit },
              }),
        );
        const stored = await getStorageService().putFile({
          companyId: shot.companyId,
          namespace: `video-storylines/${shot.storylineId}/clips`,
          originalFilename: `clip-${String(shot.orderIndex).padStart(6, "0")}.mp4`,
          contentType: "video/mp4",
          body: clip,
        });
        const [still] = await db.select({ status: videoShots.status }).from(videoShots).where(eq(videoShots.id, shot.id));
        if (still?.status !== "rendering") {
          // Changed again while it was being made: this result is already old.
          await deleteObjects(shot.companyId, [stored.objectKey]);
          continue;
        }
        await db
          .update(videoShots)
          .set({
            status: "done",
            resultProvider: stored.provider,
            resultObjectKey: stored.objectKey,
            resultContentType: stored.contentType,
            resultByteSize: stored.byteSize,
            resultSha256: stored.sha256,
            actualCostCents: 0,
            errorMessage: null,
            updatedAt: nowOf(),
          })
          .where(eq(videoShots.id, shot.id));
        prepared += 1;
      } catch (err) {
        logger.warn({ err, shotId: shot.id }, "video-storyline-clips: a clip could not be prepared");
        const message = err instanceof UploadProcessingError ? err.message : "This clip could not be prepared. Try a different trim, or remove it and add the file again.";
        await db.update(videoShots).set({ status: "failed", errorMessage: message, updatedAt: nowOf() }).where(eq(videoShots.id, shot.id));
        failed += 1;
      }
    }
    return { prepared, failed };
  }

  // ─── Picture shape and export ───

  async function setAspect(companyId: string, storylineId: string, aspect: VideoStorylineAspect, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      const shots = await tx.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
      const made = shots.find((s) => s.clipKind === "generated" && !s.sourceUploadId && (s.status !== "draft" || s.resultObjectKey || s.stillObjectKey));
      if (made && locked.aspect !== aspect) {
        throw conflict(
          "The picture shape is chosen before anything is made, and this film already has AI pictures or clips in its current shape. Start a new storyline for another shape, or export this one with a different preset.",
        );
      }
      const current = readVideoExportSettings(locked.exportSettings, locked.aspect);
      const exportSettings = { ...(locked.exportSettings as Record<string, unknown>), preset: videoExportPresetForAspect(aspect).id, ...(current.preset !== videoExportPresetForAspect(locked.aspect).id ? { preset: current.preset } : {}) };
      await tx.update(videoStorylines).set({ aspect, exportSettings, updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
    });
    await log(companyId, actor, "video_storyline.aspect_set", storylineId, { aspect });
  }

  async function updateExportSettings(companyId: string, storylineId: string, patch: UpdateVideoExportSettingsInput, actor: VideoStorylineActor): Promise<VideoStorylineExportSettings> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    if (storyline.status === "stitching") throw conflict("The film is being combined right now. Wait for it to finish, then change the export.");
    const next: Record<string, unknown> = { ...(storyline.exportSettings as Record<string, unknown>) };
    for (const key of ["preset", "fps", "fit", "endFrame", "quality"] as const) if (patch[key] !== undefined) next[key] = patch[key];
    if (patch.opening !== undefined) {
      next.opening = patch.opening ? { text: cleanVideoTitleText(patch.opening.text, false, VIDEO_TITLE_MAX_CHARS), seconds: patch.opening.seconds } : null;
    }
    if (patch.credits !== undefined) {
      next.credits = patch.credits ? { text: cleanVideoTitleText(patch.credits.text, true, VIDEO_CREDITS_MAX_CHARS), seconds: patch.credits.seconds } : null;
    }
    const clean = readVideoExportSettings(next, storyline.aspect);
    await db.update(videoStorylines).set({ exportSettings: clean as unknown as Record<string, unknown>, updatedAt: nowOf() }).where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    // Photo clips are drawn at the export's size and frame rate: make them again.
    if (patch.preset !== undefined || patch.fps !== undefined || patch.fit !== undefined) {
      await db
        .update(videoShots)
        .set({ status: "queued", updatedAt: nowOf() })
        .where(and(eq(videoShots.storylineId, storylineId), eq(videoShots.companyId, companyId), eq(videoShots.clipKind, "still"), eq(videoShots.status, "done")));
    }
    await log(companyId, actor, "video_storyline.export_settings_updated", storylineId, { fields: Object.keys(patch) });
    return clean;
  }

  /** "Export again": new settings (optional), then the film is combined again from the finished clips -- nothing is re-rendered or paid for. */
  async function exportAgain(companyId: string, storylineId: string, input: ExportVideoStorylineInput, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    if (input.settings) await updateExportSettings(companyId, storylineId, input.settings, actor);
    await stitch.retryStitch(companyId, storylineId);
    await log(companyId, actor, "video_storyline.export_requested", storylineId, {});
  }

  // ─── Music lane ───

  async function updateMusicLane(companyId: string, storylineId: string, input: UpdateVideoMusicLaneInput, actor: VideoStorylineActor): Promise<void> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    if (storyline.status === "stitching") throw conflict("The film is being combined right now. Wait for it to finish, then change the music.");
    const changes: Partial<typeof videoStorylines.$inferInsert> = {};
    if (input.musicFileId !== undefined) {
      if (input.musicFileId === null) changes.musicAssetId = null;
      else {
        const asset = await footage.resolveMusicAsset(companyId, input.musicFileId);
        changes.musicAssetId = asset.id;
        changes.musicSourceKey = null;
      }
    }
    if (input.trimInMs !== undefined) changes.musicTrimInMs = input.trimInMs;
    if (input.trimOutMs !== undefined) changes.musicTrimOutMs = input.trimOutMs;
    if (input.offsetMs !== undefined) changes.musicOffsetMs = input.offsetMs;
    if (input.fadeInMs !== undefined) changes.musicFadeInMs = input.fadeInMs;
    if (input.fadeOutMs !== undefined) changes.musicFadeOutMs = input.fadeOutMs;
    if (input.volumeDb !== undefined) changes.musicVolumeDb = input.volumeDb;
    if (input.audioMode !== undefined) changes.musicAudioMode = input.audioMode;
    const trimIn = changes.musicTrimInMs ?? storyline.musicTrimInMs;
    const trimOut = changes.musicTrimOutMs !== undefined ? changes.musicTrimOutMs : storyline.musicTrimOutMs;
    if (trimOut !== null && trimOut !== undefined && trimOut <= trimIn) throw unprocessable("The music's end must be after its start.");
    if (Object.keys(changes).length === 0) return;
    await db.update(videoStorylines).set({ ...changes, updatedAt: nowOf() }).where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    await log(companyId, actor, "video_storyline.music_updated", storylineId, { fields: Object.keys(input) });
  }

  /** Sound files this company can put under a film: music made in Media Studio (company files) and music uploaded here. */
  async function musicChoices(companyId: string): Promise<VideoMusicChoice[]> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const rows = await db
      .select({ asset: assets, fileId: issueAttachments.id })
      .from(assets)
      .leftJoin(issueAttachments, and(eq(issueAttachments.assetId, assets.id), eq(issueAttachments.companyId, companyId)))
      .where(and(eq(assets.companyId, companyId), sql`lower(${assets.contentType}) like 'audio/%'`))
      .orderBy(desc(assets.createdAt))
      .limit(80);
    const seen = new Set<string>();
    const out: VideoMusicChoice[] = [];
    for (const row of rows) {
      if (seen.has(row.asset.id)) continue;
      seen.add(row.asset.id);
      out.push({
        id: row.fileId ?? row.asset.id,
        name: row.asset.originalFilename ?? "Music",
        contentType: row.asset.contentType,
        byteSize: row.asset.byteSize,
        createdAt: row.asset.createdAt.toISOString(),
        source: row.fileId ? "media_studio" : "upload",
      });
    }
    return out.slice(0, 50);
  }

  async function uploadMusic(companyId: string, file: IncomingFile, actor: VideoStorylineActor): Promise<VideoMusicChoice> {
    // Timeline editor: free editing, available without Advanced features.
    await settings.assertEnabled(companyId);
    const type = file.contentType.toLowerCase().split(";")[0]!.trim();
    if (!type.startsWith("audio/")) throw new HttpError(415, "That is not a sound file. Upload an MP3, WAV, M4A or similar.");
    if (file.size > MUSIC_MAX_BYTES) throw new HttpError(413, `Music files can be up to ${mb(MUSIC_MAX_BYTES)}.`);
    // The real type from its first bytes, not the name (security review DUR-4745).
    if (!sniffAudioContainer(file.buffer)) throw new HttpError(415, "That file is not a sound file this server can use. Upload an MP3, WAV, M4A, Ogg or FLAC file.");
    const quota = (await footage.getSettings(companyId)).storageQuotaBytes;
    const stored = await getStorageService().putFile({ companyId, namespace: STORYLINE_MUSIC_NAMESPACE, originalFilename: file.originalName ?? "music", contentType: type, body: file.buffer });
    const row = await withCompanyScope(db, companyId, async (tx) => {
      // Music counts in the same storage limit as photos and videos, under the same lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video_upload_quota:${companyId}`}, 0))`);
      const used = await companyStorageUsedBytes(tx, companyId);
      if (used + stored.byteSize > quota) {
        throw new HttpError(413, `This company's uploads would take ${gb(used + stored.byteSize)}, over its ${gb(quota)} storage limit. Remove files you no longer use, or ask an owner or admin to raise the limit.`);
      }
      const [inserted] = await tx
        .insert(assets)
        .values({
          companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: file.originalName?.slice(0, 255) ?? null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: actor.agentId,
        })
        .returning();
      return inserted;
    }).catch(async (err: unknown) => {
      await deleteObjects(companyId, [stored.objectKey]);
      throw err;
    });
    return { id: row!.id, name: row!.originalFilename ?? "Music", contentType: row!.contentType, byteSize: row!.byteSize, createdAt: row!.createdAt.toISOString(), source: "upload" };
  }

  // ─── Animate a photo (the new paid step) ───

  /**
   * Turns a photo clip into an AI shot with the photo as its start picture.
   * Cost first: the caller sends the price it showed; the estimate is held
   * against the storyline budget AND the company's monthly media cap (same
   * lock as AI transitions) before the video service is called, settled when
   * the clip arrives and given back if it fails. The photo must pass the
   * footage rules (Sogni setting, age check, consent) and the company's own
   * key is used.
   */
  async function animate(companyId: string, storylineId: string, shotId: string, input: AnimateVideoClipInput, actor: VideoStorylineActor): Promise<{ reservedCents: number }> {
    await settings.assertAdvancedEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStripEditable(storyline);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.clipKind !== "still" || !shot.sourceUploadId) throw unprocessable("Only a photo clip can be animated.");
    const upload = await footage.getUpload(companyId, shot.sourceUploadId);
    if (upload.kind !== "photo" || upload.status !== "ready" || !upload.objectKey) throw conflict("This photo is not ready yet.");
    const quote = estimateShotRenderCents(storyline, [{ providerId: null, model: null, durationSeconds: shot.durationSeconds }]).estimatedTotalCents;
    if (quote > input.confirmCostCents) {
      throw conflict(`This now costs about ${dollars(quote)}, more than the ${dollars(input.confirmCostCents)} you saw. Check it and press again.`);
    }
    const threshold = await settings.getApprovalThresholdCents(companyId);
    if (threshold !== null && quote > threshold) {
      throw unprocessable(`Animating this photo costs about ${dollars(quote)}, over this company's approval limit of ${dollars(threshold)}. Make it shorter, or ask the owner to raise the limit.`);
    }
    const providerId = storyline.providerId === "sogni" ? "sogni" : "fal";
    const actorId = actor.agentId ?? actor.actorId;
    // The company's own key, before anything is held (decision 15).
    await render.resolveProviderApiKey(companyId, providerId, actorId, { companyKeyOnly: true });
    // The photo itself must pass the footage rules before anything is held.
    await footage.assertMaySend(companyId, shot, providerId, await download(companyId, upload.objectKey), actor);
    const monthlyCap = await settings.getMediaMonthlyCapCents(companyId);

    const held = await withCompanyScope(db, companyId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video_transition_spend:${companyId}`}, 0))`);
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStripEditable(locked);
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, shot.id), eq(videoShots.storylineId, storylineId)));
      if (!current || current.clipKind !== "still") throw conflict("This clip changed. Refresh the strip and try again.");
      if (locked.budgetCapCents === null) throw unprocessable("Set a budget for this film first (step 5, Render & export), so spending stops at a limit you chose.");
      if (locked.spentCents + quote > locked.budgetCapCents) {
        throw unprocessable(
          `Animating this photo costs about ${dollars(quote)}, and ${dollars(locked.spentCents)} of this film's ${dollars(locked.budgetCapCents)} budget is already spent. Raise the budget to at least ${dollars(locked.spentCents + quote)} to go ahead.`,
        );
      }
      const spentThisMonth = await companyMonthlyMediaSpendCents(tx, companyId, nowOf());
      if (spentThisMonth + quote > monthlyCap) {
        throw unprocessable(
          `Animating this photo costs about ${dollars(quote)}, and ${dollars(spentThisMonth)} of this company's ${dollars(monthlyCap)} monthly limit for AI media is already used. An owner or admin can raise the monthly limit.`,
        );
      }
      await tx.update(videoStorylines).set({ spentCents: sql`${videoStorylines.spentCents} + ${quote}`, updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
      const [hold] = await tx
        .insert(videoMediaSpend)
        .values({ companyId, storylineId, shotId: shot.id, kind: "animate_photo", status: "reserved", reservedCents: quote, createdByUserId: actor.actorType === "user" ? actor.actorId : null, createdAt: nowOf(), updatedAt: nowOf() })
        .returning({ id: videoMediaSpend.id });
      // The durable ledger row the monthly limit counts (DUR-4807): it survives
      // deleting the film or removing this clip.
      const spend = await reserveStorylineMediaSpend(tx, {
        companyId,
        billingCode: storylineAnimateSpendCode(hold!.id),
        provider: providerId,
        model: locked.model ?? "animate-photo",
        cents: quote,
        agentId: locked.createdByAgentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : locked.createdByAgentId ? null : locked.createdByUserId,
        occurredAt: nowOf(),
      });
      await tx
        .update(videoShots)
        .set({
          clipKind: "generated",
          prompt: input.prompt,
          stillMotion: null,
          storyboardStatus: "approved",
          status: "queued",
          providerId: null,
          model: null,
          errorMessage: null,
          resultProvider: null,
          resultObjectKey: null,
          resultContentType: null,
          resultByteSize: null,
          resultSha256: null,
          actualCostCents: null,
          updatedAt: nowOf(),
        })
        .where(eq(videoShots.id, shot.id));
      return spend;
    });
    await refreshStorylineMediaSpend(db, held);
    try {
      const fresh = await storylines.getStorylineRow(companyId, storylineId);
      const freshShot = await storylines.getShotRow(companyId, storylineId, shot.id);
      await render.beginShotRender(companyId, fresh, freshShot, actorId, { companyKeyOnly: true });
    } catch (err) {
      await render.releaseShotReservation(companyId, storylineId, shot.id);
      const message = err instanceof HttpError ? err.message : `The video service did not start: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
      // Back to a photo clip (prepared again, free), with the reason shown on it.
      await db
        .update(videoShots)
        .set({ clipKind: "still", stillMotion: shot.stillMotion ?? "hold", prompt: shot.prompt, status: "queued", errorMessage: message, updatedAt: nowOf() })
        .where(eq(videoShots.id, shot.id));
      throw err instanceof HttpError ? err : unprocessable(message);
    }
    await log(companyId, actor, "video_storyline.photo_animation_started", storylineId, { shotId, reservedCents: quote });
    return { reservedCents: quote };
  }

  // ─── Clean-up of unchosen versions ───

  /**
   * Hourly: uploads no clip uses, and AI transition versions nobody picked,
   * are deleted once they are older than the company's clean-up days. Rows
   * of transition versions stay (they carry the month's spend); only their
   * video is removed.
   */
  async function cleanup(force = false): Promise<{ uploads: number; takes: number }> {
    const now = nowOf();
    if (!force && now.getTime() - lastCleanupAt < CLEANUP_EVERY_MS) return { uploads: 0, takes: 0 };
    lastCleanupAt = now.getTime();
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const daysFor = new Map<string, number>();
    const days = async (companyId: string) => {
      if (!daysFor.has(companyId)) daysFor.set(companyId, (await footage.getSettings(companyId)).cleanupDays);
      return daysFor.get(companyId)!;
    };
    let uploadsRemoved = 0;
    const unused = await db
      .select()
      .from(videoUploads)
      .where(and(lt(videoUploads.updatedAt, dayAgo), sql`not exists (select 1 from ${videoShots} where ${videoShots.sourceUploadId} = ${videoUploads.id})`))
      .limit(CLEANUP_BATCH);
    for (const upload of unused) {
      if (upload.status === "processing") continue;
      const cutoff = now.getTime() - (await days(upload.companyId)) * 24 * 3600_000;
      if (upload.updatedAt.getTime() > cutoff) continue;
      await db.delete(videoUploads).where(and(eq(videoUploads.id, upload.id), sql`not exists (select 1 from ${videoShots} where ${videoShots.sourceUploadId} = ${videoUploads.id})`));
      await deleteObjects(upload.companyId, [upload.rawObjectKey, upload.objectKey, upload.previewObjectKey, upload.posterObjectKey !== upload.previewObjectKey ? upload.posterObjectKey : null]);
      uploadsRemoved += 1;
    }
    let takesRemoved = 0;
    const takes = await db
      .select({ take: videoTransitionTakes, chosen: videoTransitions.chosenTakeId })
      .from(videoTransitionTakes)
      .innerJoin(videoTransitions, eq(videoTransitions.id, videoTransitionTakes.transitionId))
      .where(
        and(
          isNotNull(videoTransitionTakes.resultObjectKey),
          inArray(videoTransitionTakes.status, ["ready", "failed"]),
          lt(videoTransitionTakes.updatedAt, dayAgo),
          sql`${videoTransitions.chosenTakeId} is distinct from ${videoTransitionTakes.id}`,
        ),
      )
      .limit(CLEANUP_BATCH);
    for (const { take } of takes) {
      const keep = await days(take.companyId);
      if (take.updatedAt.getTime() > now.getTime() - keep * 24 * 3600_000) continue;
      await db
        .update(videoTransitionTakes)
        .set({ resultObjectKey: null, resultByteSize: null, error: `Removed after ${keep} days because nobody picked it.`, updatedAt: now })
        .where(eq(videoTransitionTakes.id, take.id));
      await deleteObjects(take.companyId, [take.resultObjectKey]);
      takesRemoved += 1;
    }
    return { uploads: uploadsRemoved, takes: takesRemoved };
  }

  async function tick(): Promise<{ uploadsProcessed: number; uploadsFailed: number; clipsPrepared: number; clipsFailed: number; cleanedUploads: number; cleanedTakes: number }> {
    const uploads = await processUploads().catch((err: unknown) => {
      logger.error({ err }, "video-storyline-clips: upload tick failed");
      return { processed: 0, failed: 0 };
    });
    const clips = await prepareClips().catch((err: unknown) => {
      logger.error({ err }, "video-storyline-clips: clip tick failed");
      return { prepared: 0, failed: 0 };
    });
    const cleaned = await cleanup().catch((err: unknown) => {
      logger.error({ err }, "video-storyline-clips: clean-up failed");
      return { uploads: 0, takes: 0 };
    });
    return {
      uploadsProcessed: uploads.processed,
      uploadsFailed: uploads.failed,
      clipsPrepared: clips.prepared,
      clipsFailed: clips.failed,
      cleanedUploads: cleaned.uploads,
      cleanedTakes: cleaned.takes,
    };
  }

  return {
    createUpload,
    updateConsent,
    deleteUpload,
    processUploads,
    createClip,
    updateClip,
    removeClip,
    splitClip,
    reorder,
    prepareClips,
    setAspect,
    updateExportSettings,
    exportAgain,
    updateMusicLane,
    musicChoices,
    uploadMusic,
    animate,
    cleanup,
    tick,
    getUpload: uploadOf,
    uploadByteSize,
  };
}
