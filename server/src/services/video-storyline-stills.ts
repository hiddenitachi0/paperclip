import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoShots } from "@paperclipai/db";
import {
  MEDIA_STUDIO_PLUGIN_KEY,
  estimateStoryboardCostCents,
  type VideoShotStoryboardStatus,
  type VideoStorylineProvider,
  type VideoStoryboardShotSummary,
  type VideoStoryboardSummary,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { FalImageProvider, type ImageFetchImpl, type ImageGenerationProvider, type ImageGenerationResult } from "./image-provider-clients.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { executePinnedHttpRequest, validateAndResolveFetchUrl } from "./safe-outbound-fetch.js";
import { secretService } from "./secrets.js";
import { loadReferenceImages } from "./video-storyline-render.js";
import { recordFalCostEvent } from "./fal-cost-events.js";
import { videoStorylineSettingsService } from "./video-storyline-settings.js";
import { videoStorylineService, type VideoStorylineActor } from "./video-storylines.js";

/**
 * DUR-4317/DUR-4320 (backend half, storyboard-of-stills approval gate):
 * generates, approves and drops the cheap per-shot storyboard still a human
 * reviews before that shot's real, paid video render is allowed to start
 * (the actual gate lives in video-storyline-render.ts's beginShotRender --
 * see its doc comment). Deliberately its own file/service, not folded into
 * video-storylines.ts, so the image-generation-provider plumbing stays
 * separate from the plain CRUD service, same separation
 * video-storyline-render.ts/-director.ts/-stitch.ts already keep from each
 * other.
 */

type ShotRow = typeof videoShots.$inferSelect;

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** SSRF-guarded fetch for the image-generation call and downloading its result, same posture video-storyline-render.ts's safeFetch uses for video. */
const safeImageFetch: ImageFetchImpl = async (url, init) => {
  const target = await validateAndResolveFetchUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const pinned = await executePinnedHttpRequest(target, init, controller.signal, { maxResponseBytes: IMAGE_MAX_BYTES });
    return new Response(new Uint8Array(pinned.bodyBytes), { status: pinned.status, statusText: pinned.statusText, headers: pinned.headers });
  } finally {
    clearTimeout(timeout);
  }
};

function toStoryboardShotSummary(row: ShotRow): VideoStoryboardShotSummary {
  return {
    id: row.id,
    orderIndex: row.orderIndex,
    storyboardStatus: row.storyboardStatus as VideoShotStoryboardStatus,
    stillObjectKey: row.stillObjectKey,
    stillContentType: row.stillContentType,
    stillByteSize: row.stillByteSize,
    stillGeneratedAt: row.stillGeneratedAt ? row.stillGeneratedAt.toISOString() : null,
    stillEstimatedCostCents: row.stillEstimatedCostCents,
    stillActualCostCents: row.stillActualCostCents,
  };
}

async function downloadImageBytes(result: ImageGenerationResult): Promise<{ buffer: Buffer; contentType: string }> {
  if (result.imageDataUrl) {
    const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(result.imageDataUrl);
    if (!match?.[3]) throw new Error("Unrecognized (or non-base64) image data URL from provider");
    return { buffer: Buffer.from(match[3], "base64"), contentType: match[1] || result.contentType };
  }
  if (result.imageUrl) {
    const response = await safeImageFetch(result.imageUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { buffer: bytes, contentType: response.headers.get("content-type") || result.contentType };
  }
  throw new Error("Provider returned neither a url nor a dataUrl");
}

export function videoStorylineStillsService(db: Db) {
  const storylines = videoStorylineService(db);
  const settings = videoStorylineSettingsService(db);
  const registry = pluginRegistryService(db);
  const secrets = secretService(db);

  /**
   * Storyboard pictures are always made with Fal.ai's image models, whatever
   * provider renders the video -- a still is just a picture, and Sogni has
   * no still path here. (Before, a Sogni storyline could never get a still,
   * so it could never be approved, so it could never render.)
   */
  async function resolveImageProvider(companyId: string, actorId: string): Promise<{ provider: ImageGenerationProvider; apiKey: string }> {
    const noKey = "Storyboard pictures are made with Fal.ai, and no Fal.ai API key is set up in Media Studio settings yet. Add one there, or approve this shot without a picture.";
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    if (!plugin) throw unprocessable(noKey);
    const config = await registry.getConfig(plugin.id);
    const cfg = (config?.configJson ?? {}) as Record<string, unknown>;
    const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
    if (!ref) throw unprocessable(noKey);
    const apiKey = await secrets.resolveSecretValueForVideoRender(companyId, ref, { actorId });
    return { provider: new FalImageProvider(apiKey, safeImageFetch), apiKey };
  }

  async function generateStill(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor): Promise<VideoStoryboardShotSummary> {
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.status === "rendering" || shot.status === "queued") {
      throw conflict("This shot is currently rendering. Wait for it to finish before regenerating its still.");
    }

    // Stills are always a Fal image call (see resolveImageProvider), so they are priced as one.
    const estimate = estimateStoryboardCostCents([{ storyboardStatus: shot.storyboardStatus as VideoShotStoryboardStatus }], "fal");
    const { provider, apiKey } = await resolveImageProvider(companyId, actor.agentId ?? actor.actorId);

    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const referenceImages = await loadReferenceImages(db, companyId, referenceAssetIds);

    let imageResult: ImageGenerationResult;
    try {
      imageResult = await provider.generate({
        prompt: shot.prompt,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      });
    } catch (err) {
      throw unprocessable(`Still generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { buffer, contentType } = await downloadImageBytes(imageResult);

    // DUR-4455: the still is a paid Fal call -- record its actual cost as a cost event (agent-made pictures were uncounted before).
    await recordFalCostEvent(db, safeImageFetch, {
      companyId,
      apiKey,
      agentId: actor.agentId,
      createdByUserId: actor.agentId ? null : actor.actorId,
      model: imageResult.model,
      usage: { images: 1, ...(imageResult.megapixels != null ? { megapixels: imageResult.megapixels } : {}) },
      estimateCents: estimate.estimatedTotalCents,
      billingCode: "video-storyline-still",
    });

    const stored = await getStorageService().putFile({
      companyId,
      namespace: `video-storylines/${storyline.id}/stills`,
      originalFilename: `shot-${String(shot.orderIndex).padStart(6, "0")}-still.jpg`,
      contentType,
      body: buffer,
    });

    const now = new Date();
    const [row] = await db
      .update(videoShots)
      .set({
        stillProvider: stored.provider,
        stillObjectKey: stored.objectKey,
        stillContentType: stored.contentType,
        stillByteSize: stored.byteSize,
        stillSha256: stored.sha256,
        stillGeneratedAt: now,
        stillEstimatedCostCents: estimate.estimatedTotalCents,
        stillActualCostCents: estimate.estimatedTotalCents,
        // A fresh still needs a fresh review -- never silently keeps a
        // previous approval (or drop) that was decided against the old one.
        storyboardStatus: "pending",
        updatedAt: now,
      })
      .where(eq(videoShots.id, shotId))
      .returning();
    if (!row) throw new Error("Video shot still update returned no row");

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.still_generated",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex, costCents: estimate.estimatedTotalCents },
    });
    return toStoryboardShotSummary(row);
  }

  async function approveShot(
    companyId: string,
    storylineId: string,
    shotId: string,
    actor: VideoStorylineActor,
    options: { withoutStill?: boolean } = {},
  ): Promise<VideoStoryboardShotSummary> {
    await settings.assertEnabled(companyId);
    await storylines.getStorylineRow(companyId, storylineId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.storyboardStatus === "dropped") {
      throw conflict("This shot has been dropped from the storyboard. Edit it to bring it back before approving it.");
    }
    if (!shot.stillObjectKey && !options.withoutStill) {
      throw unprocessable("Make a storyboard picture for this shot before approving it, or approve it without a picture.");
    }
    const now = new Date();
    const [row] = await db
      .update(videoShots)
      .set({ storyboardStatus: "approved", updatedAt: now })
      .where(eq(videoShots.id, shotId))
      .returning();
    if (!row) throw new Error("Video shot approve update returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.storyboard_approved",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex, withoutStill: !shot.stillObjectKey },
    });
    return toStoryboardShotSummary(row);
  }

  async function dropShot(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor): Promise<VideoStoryboardShotSummary> {
    await settings.assertEnabled(companyId);
    await storylines.getStorylineRow(companyId, storylineId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.status === "rendering" || shot.status === "queued") {
      throw conflict("This shot is currently rendering. Cancel the render before dropping it.");
    }
    const now = new Date();
    const [row] = await db
      .update(videoShots)
      .set({ storyboardStatus: "dropped", updatedAt: now })
      .where(eq(videoShots.id, shotId))
      .returning();
    if (!row) throw new Error("Video shot drop update returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.storyboard_dropped",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex },
    });
    return toStoryboardShotSummary(row);
  }

  async function getStoryboardSummary(companyId: string, storylineId: string): Promise<VideoStoryboardSummary> {
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    const shotRows = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(asc(videoShots.orderIndex));
    const providerId = storyline.providerId as VideoStorylineProvider;
    const nonDropped = shotRows.filter((s) => s.storyboardStatus !== "dropped");
    const stillTotalCents = nonDropped.reduce((sum, s) => sum + (s.stillActualCostCents ?? s.stillEstimatedCostCents ?? 0), 0);
    const allApproved = nonDropped.length > 0 && nonDropped.every((s) => s.storyboardStatus === "approved");
    const approvalThresholdCents = await settings.getApprovalThresholdCents(companyId);
    return {
      storylineId,
      providerId,
      shots: shotRows.map(toStoryboardShotSummary),
      stillTotalCents,
      allApproved,
      videoEstimatedTotalCents: storyline.estimatedTotalCents,
      videoSpentCents: storyline.spentCents,
      approvalThresholdCents,
    };
  }

  return { generateStill, approveShot, dropShot, getStoryboardSummary, toStoryboardShotSummary };
}
