import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, videoShotRenderJobs, videoShots, videoStorylines } from "@paperclipai/db";
import {
  MEDIA_STUDIO_PLUGIN_KEY,
  VIDEO_RENDER_JOB_MAX_AGE_MS,
  VIDEO_RENDER_TICK_BATCH,
  VIDEO_SHOT_MIN_DURATION_SECONDS,
  estimateVideoStorylineCostCents,
  videoRenderRequestPayloadSchema,
  type StartVideoStorylineRenderInput,
  type VideoStorylineProvider,
} from "@paperclipai/shared";
import type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaPollOutcome } from "./video-provider-clients.js";
import { FalVideoProvider, SogniVideoProvider } from "./video-provider-clients.js";
import { badRequest, conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { recordFalCostEvent } from "./fal-cost-events.js";
import { recordSogniCost, SOGNI_CREDIT_PRICE_CONFIG_KEY } from "./sogni-cost.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { approvalService } from "./approvals.js";
import { secretService } from "./secrets.js";
import { extractLastFrameDataUri } from "./video-ffmpeg.js";
import { loadApprovedStillDataUri } from "./video-storyline-still-frame.js";
import { videoStorylineSettingsService } from "./video-storyline-settings.js";
import { videoStorylineService, type VideoStorylineActor } from "./video-storylines.js";
import { executePinnedHttpRequest, validateAndResolveFetchUrl } from "./safe-outbound-fetch.js";
import { mediaStudioKeyRef } from "./media-studio-company-keys.js";

/**
 * DUR-4127: render orchestration for a video storyline. Reuses the Fal/Sogni
 * *provider HTTP clients* (FalVideoProvider/SogniVideoProvider -- plain
 * classes, no ctx dependency) rather than the media-studio plugin's
 * ctx-bound job engine (media-jobs.ts), because this needs first-class
 * DB-table bookkeeping (video_shot_render_jobs) a plugin entity cannot give
 * cross-cutting queries over. See video-provider-clients.ts for why those
 * classes are duplicated there rather than imported from the plugin
 * package.
 *
 * Drives shots strictly in `orderIndex` order: shot N is only started once
 * shot N-1 is `done` (or there is no shot N-1). On a shot failure, the chain
 * stops (storyline -> "paused") rather than cascading -- see reRenderShot
 * for how a single bad shot gets retried without touching the rest.
 */

const RENDER_API_FETCH_TIMEOUT_MS = 30_000;
const CLIP_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
/** Generous per-clip cap; a single shot is a handful of seconds of video, not a feature film. */
const CLIP_MAX_BYTES = 500 * 1024 * 1024;
const CONTENT_TYPE_PREFIX = "video/";
const MAX_REFERENCE_IMAGES = 4;
/** DUR-4196 still-frame preview: the shortest allowed clip, polled synchronously -- see renderPreview's doc comment. */
const PREVIEW_DURATION_SECONDS = VIDEO_SHOT_MIN_DURATION_SECONDS;
const PREVIEW_POLL_INTERVAL_MS = 2_000;
const PREVIEW_POLL_TIMEOUT_MS = 90_000;

/** SSRF-guarded FetchImpl, reused for both provider API calls and downloading finished clips -- see safe-outbound-fetch.ts. */
async function safeFetch(url: string, init?: RequestInit, maxResponseBytes = 8 * 1024 * 1024): Promise<Response> {
  const target = await validateAndResolveFetchUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.method === "GET" || !init?.method ? CLIP_DOWNLOAD_TIMEOUT_MS : RENDER_API_FETCH_TIMEOUT_MS);
  try {
    const pinned = await executePinnedHttpRequest(target, init, controller.signal, { maxResponseBytes });
    return new Response(new Uint8Array(pinned.bodyBytes), { status: pinned.status, statusText: pinned.statusText, headers: pinned.headers });
  } finally {
    clearTimeout(timeout);
  }
}

function buildProvider(providerId: VideoStorylineProvider, apiKey: string, model: string | null): MediaJobProvider {
  if (providerId === "fal") {
    return new FalVideoProvider(apiKey, safeFetch, model ?? undefined);
  }
  return new SogniVideoProvider({ apiKey, apiFetch: safeFetch, transferFetch: safeFetch, defaultModel: model ?? undefined });
}

async function dataUriFromObject(companyId: string, provider: string, objectKey: string, contentType: string): Promise<string> {
  const storage = getStorageService();
  const object = await storage.getObject(companyId, objectKey);
  const bytes = await streamToBuffer(object.stream);
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

/** Reads a small set of already-uploaded reference pictures (assets.id) as data: URIs, oldest-first, bounded by MAX_REFERENCE_IMAGES so a storyline with many reference pictures does not balloon every render call. Exported for video-storyline-stills.ts's generateStill, which feeds a shot's own look references into its storyboard still the same way a real render would. */
export async function loadReferenceImages(db: Db, companyId: string, assetIds: readonly string[]): Promise<string[]> {
  const ids = assetIds.slice(0, MAX_REFERENCE_IMAGES);
  if (ids.length === 0) return [];
  const rows = await db.select().from(assets).where(and(eq(assets.companyId, companyId), inArray(assets.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    try {
      out.push(await dataUriFromObject(companyId, row.provider, row.objectKey, row.contentType));
    } catch (err) {
      logger.warn({ err, assetId: id }, "video-storyline-render: could not load a reference picture, skipping it");
    }
  }
  return out;
}

export interface VideoStorylineRenderDeps {
  now?: () => Date;
}

export function videoStorylineRenderService(db: Db, deps: VideoStorylineRenderDeps = {}) {
  const storylines = videoStorylineService(db);
  const settings = videoStorylineSettingsService(db);
  const registry = pluginRegistryService(db);
  const secrets = secretService(db);
  const approvals = approvalService(db);
  const nowOf = () => deps.now?.() ?? new Date();

  async function resolveProviderApiKey(companyId: string, providerId: VideoStorylineProvider, actorId: string): Promise<string> {
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    if (!plugin) throw unprocessable("The media-studio plugin is not installed, so there is no Fal/Sogni key configured.");
    const config = await registry.getConfig(plugin.id);
    const cfg = (config?.configJson ?? {}) as Record<string, unknown>;
    // The company's own key (Media Studio's Settings tab), else the instance's.
    const ref = await mediaStudioKeyRef(db, plugin.id, companyId, providerId === "fal" ? "fal" : "sogni", cfg);
    if (!ref) {
      throw unprocessable(
        `No ${providerId === "fal" ? "Fal.ai" : "Sogni"} API key is set for this company yet. The company's owner or an admin can pick one in Media Studio's Settings tab.`,
      );
    }
    return secrets.resolveSecretValueForVideoRender(companyId, ref, { actorId });
  }

  async function estimate(companyId: string, storylineId: string) {
    return storylines.recomputeEstimate(companyId, storylineId);
  }

  /** Excludes 'dropped' shots -- dropped shots never render and are never counted toward "is this storyline finished?" (see DUR-4317/DUR-4320's storyboard gate). */
  async function nextPendingShot(storylineId: string) {
    const [row] = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storylineId), ne(videoShots.status, "done"), ne(videoShots.storyboardStatus, "dropped")))
      .orderBy(asc(videoShots.orderIndex))
      .limit(1);
    return row ?? null;
  }

  async function closestPreviousDoneShot(storylineId: string, beforeOrderIndex: number) {
    const rows = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storylineId), eq(videoShots.status, "done"), lt(videoShots.orderIndex, beforeOrderIndex)))
      .orderBy(asc(videoShots.orderIndex));
    return rows.length > 0 ? rows[rows.length - 1]! : null;
  }

  /**
   * DUR-4317/DUR-4320: this is the "no video provider call before approval"
   * enforcement point -- the storyboardStatus check below runs before
   * resolveProviderApiKey/provider.start, i.e. before any real, paid
   * video-provider call is made for this shot. Every render path
   * (startRender's first shot, onShotDone's chain continuation,
   * reRenderShot) funnels through this one function, so there is a single
   * place this gate has to be enforced correctly. 'dropped' shots never
   * reach here (callers filter them out of the render queue first); a
   * 'pending' shot always does, since it has not been reviewed at all.
   */
  async function beginShotRender(companyId: string, storyline: typeof videoStorylines.$inferSelect, shot: typeof videoShots.$inferSelect, actorId: string) {
    if (shot.storyboardStatus !== "approved") {
      throw unprocessable(
        `Shot ${shot.orderIndex}'s storyboard still has not been approved yet. Generate and approve a still for it (or drop it) before rendering.`,
      );
    }
    const providerId = (shot.providerId ?? storyline.providerId) as VideoStorylineProvider;
    const model = shot.model ?? storyline.model;
    const apiKey = await resolveProviderApiKey(companyId, providerId, actorId);
    const provider = buildProvider(providerId, apiKey, model);

    // DUR-4317/DUR-4320: an approved storyboard still wins over the ordinary
    // last-frame continuity image -- the operator explicitly approved this
    // still as what this shot should look like, so it takes the startImage
    // slot the continuity frame would otherwise occupy. Falls back to
    // continuity/reference pictures below only when the still could not be
    // read back (see loadApprovedStillDataUri's doc comment).
    const approvedStillImage = await loadApprovedStillDataUri(companyId, shot);

    let continuityImage: string | undefined;
    const previous = await closestPreviousDoneShot(storyline.id, shot.orderIndex);
    if (previous?.resultObjectKey && previous.resultProvider && previous.resultContentType) {
      const clip = await downloadClipFromStorage(companyId, previous.resultProvider, previous.resultObjectKey);
      if (clip) {
        continuityImage = (await extractLastFrameDataUri(clip)) ?? undefined;
      }
    }
    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const referenceImages = await loadReferenceImages(db, companyId, referenceAssetIds);
    // See media-jobs-types.ts's MediaJobInput.referenceImages doc comment: neither provider confirms
    // combining a continuity frame with separate character pictures in one call, so we pick ONE image
    // to actually drive continuity/likeness -- the approved still wins, then the continuity frame.
    const startImage = approvedStillImage ?? continuityImage ?? referenceImages[0];

    const input: MediaJobInput = {
      kind: "video",
      prompt: shot.prompt,
      model: model ?? undefined,
      startImage,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      durationSeconds: shot.durationSeconds,
    };
    const handle = await provider.start(input);
    const attempt = shot.attempt + 1;
    await db.insert(videoShotRenderJobs).values({
      companyId,
      storylineId: storyline.id,
      shotId: shot.id,
      attempt,
      provider: handle.provider,
      model: handle.model,
      externalId: handle.externalId,
      status: "running",
      startedAt: nowOf(),
      updatedAt: nowOf(),
    });
    await db
      .update(videoShots)
      .set({ status: "rendering", providerId: handle.provider, model: handle.model, attempt, errorMessage: null, updatedAt: nowOf() })
      .where(eq(videoShots.id, shot.id));
  }

  async function downloadClipFromStorage(companyId: string, provider: string, objectKey: string): Promise<Buffer | null> {
    try {
      const storage = getStorageService();
      const object = await storage.getObject(companyId, objectKey);
      return await streamToBuffer(object.stream);
    } catch (err) {
      logger.warn({ err, objectKey }, "video-storyline-render: could not read a previous shot's clip for continuity");
      return null;
    }
  }

  async function startRender(companyId: string, storylineId: string, actor: VideoStorylineActor, input: StartVideoStorylineRenderInput) {
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    if (!["draft", "estimated", "paused", "failed"].includes(storyline.status)) {
      throw conflict(`This storyline is already ${storyline.status.replace(/_/g, " ")}.`);
    }
    const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(asc(videoShots.orderIndex));
    if (shots.length === 0) throw unprocessable("Add at least one shot before starting a render.");
    // DUR-4317/DUR-4320: dropped shots never render and never cost anything
    // -- excluded from the cost estimate the same way they are excluded
    // from the render queue (nextPendingShot).
    const renderableShots = shots.filter((s) => s.storyboardStatus !== "dropped");

    // DUR-4317/DUR-4320: the mandatory storyboard gate -- every shot that
    // still needs to render must already be approved. Checked here, upfront
    // for the WHOLE storyline, rather than relying solely on
    // beginShotRender's own per-shot check, so a render never starts (and
    // the storyline never flips to "rendering") only to immediately hit an
    // unapproved shot partway through the chain.
    const unapproved = renderableShots.find((s) => s.status !== "done" && s.storyboardStatus !== "approved");
    if (unapproved) {
      throw unprocessable(
        `Shot ${unapproved.orderIndex}'s storyboard still has not been approved yet. Approve every shot's still before starting the render (or drop shots you don't want to render).`,
      );
    }

    const estimateResult = estimateVideoStorylineCostCents(renderableShots, storyline.providerId as VideoStorylineProvider);
    const effectiveBudgetCapCents = input.confirmBudgetCapCents ?? storyline.budgetCapCents;
    if (effectiveBudgetCapCents === null || effectiveBudgetCapCents === undefined) {
      throw badRequest("Set a budget cap before starting a render (or pass confirmBudgetCapCents to set one now).");
    }
    if (storyline.spentCents + estimateResult.estimatedTotalCents > effectiveBudgetCapCents) {
      throw unprocessable(
        `Estimated cost (${estimateResult.estimatedTotalCents} cents) plus what's already spent (${storyline.spentCents} cents) would exceed the budget cap (${effectiveBudgetCapCents} cents). Raise the cap or pass a higher confirmBudgetCapCents to proceed anyway.`,
      );
    }

    // DUR-4317/DUR-4320: a second, opt-in gate on top of the mandatory
    // per-shot approval above -- a company that has configured
    // videoStorylineApprovalThresholdCents also needs a board sign-off on
    // the whole storyline's render spend whenever it crosses that amount.
    // Mirrors browser-service.ts's purchase-clearance gate: file once, then
    // refuse until the board decides, never trusting the caller's own words
    // for the stamped fields.
    const thresholdCents = await settings.getApprovalThresholdCents(companyId);
    if (thresholdCents !== null && estimateResult.estimatedTotalCents > thresholdCents) {
      const approved = await approvals.findApprovedVideoRenderApproval(companyId, storylineId, estimateResult.estimatedTotalCents);
      if (!approved) {
        const open = await approvals.findOpenVideoRenderApproval(companyId, storylineId);
        if (!open) {
          const payload = videoRenderRequestPayloadSchema.parse({
            kind: "video_render",
            storylineId,
            shotCount: estimateResult.shotCount,
            estimatedTotalCents: estimateResult.estimatedTotalCents,
            thresholdCents,
            title: `Render "${storyline.title}"`,
            summary: `Rendering this storyline is estimated at ${estimateResult.estimatedTotalCents} cents across ${estimateResult.shotCount} shots, over this company's ${thresholdCents}-cent approval threshold.`,
          });
          await approvals.create(companyId, { type: "request_board_approval", requestedByAgentId: actor.agentId, payload, status: "pending" });
        }
        throw unprocessable(
          `This render's estimated cost (${estimateResult.estimatedTotalCents} cents) is over this company's ${thresholdCents}-cent approval threshold. Waiting on a board decision before it can start.`,
        );
      }
    }

    const pending = renderableShots.find((s) => s.status !== "done");
    if (!pending) {
      await db.update(videoStorylines).set({ status: "ready_to_stitch", updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "video_storyline.render_skipped_already_done", entityType: "video_storyline", entityId: storylineId, details: {} });
      return storylines.getStoryline(companyId, storylineId);
    }

    await db
      .update(videoStorylines)
      .set({
        status: "rendering",
        budgetCapCents: effectiveBudgetCapCents,
        estimatedTotalCents: estimateResult.estimatedTotalCents,
        estimatedTotalSeconds: estimateResult.totalSeconds,
        errorMessage: null,
        updatedAt: nowOf(),
      })
      .where(eq(videoStorylines.id, storylineId));
    const refreshed = await storylines.getStorylineRow(companyId, storylineId);
    await beginShotRender(companyId, refreshed, pending, actor.agentId ?? actor.actorId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.render_started",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { firstShotOrderIndex: pending.orderIndex, budgetCapCents: effectiveBudgetCapCents },
    });
    return storylines.getStoryline(companyId, storylineId);
  }

  async function reRenderShot(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor) {
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.status === "queued" || shot.status === "rendering") {
      throw conflict("This shot is already rendering.");
    }
    if (storyline.status === "stitching") {
      throw conflict("A stitch is currently running for this storyline. Wait for it to finish before re-rendering a shot.");
    }
    if (shot.storyboardStatus === "dropped") {
      throw conflict("This shot has been dropped from the storyboard. Edit it to bring it back before re-rendering it.");
    }
    if (shot.storyboardStatus !== "approved") {
      throw unprocessable(`Shot ${shot.orderIndex}'s storyboard still has not been approved yet. Approve it before re-rendering.`);
    }
    const refundCents = shot.actualCostCents ?? 0;
    const spentAfterRefund = Math.max(0, storyline.spentCents - refundCents);
    const shotEstimate = estimateVideoStorylineCostCents([{ durationSeconds: shot.durationSeconds }], storyline.providerId as VideoStorylineProvider);
    if (storyline.budgetCapCents !== null && spentAfterRefund + shotEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      throw unprocessable(
        `Re-rendering this shot (estimated ${shotEstimate.estimatedTotalCents} cents) would push spend to ${spentAfterRefund + shotEstimate.estimatedTotalCents} cents, over the budget cap (${storyline.budgetCapCents} cents). Raise the cap first.`,
      );
    }
    await db
      .update(videoShots)
      .set({ status: "queued", errorMessage: null, resultProvider: null, resultObjectKey: null, resultContentType: null, resultByteSize: null, resultSha256: null, actualCostCents: null, updatedAt: nowOf() })
      .where(eq(videoShots.id, shotId));
    if (refundCents > 0) {
      await db
        .update(videoStorylines)
        .set({ spentCents: Math.max(0, storyline.spentCents - refundCents), updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storylineId));
    }
    const refreshedStoryline = await storylines.getStorylineRow(companyId, storylineId);
    if (!["rendering"].includes(refreshedStoryline.status)) {
      await db.update(videoStorylines).set({ status: "rendering", errorMessage: null, updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
    }
    const refreshedShot = await storylines.getShotRow(companyId, storylineId, shotId);
    const finalStoryline = await storylines.getStorylineRow(companyId, storylineId);
    await beginShotRender(companyId, finalStoryline, refreshedShot, actor.agentId ?? actor.actorId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.rerendered",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex, refundCents },
    });
    return storylines.toShotSummary(await storylines.getShotRow(companyId, storylineId, shotId));
  }

  /**
   * DUR-4196: a cheap still-frame render of one shot -- same prompt and
   * continuity/reference pictures the real render would use, but the
   * shortest allowed clip duration, with only its LAST FRAME kept (the same
   * extractLastFrameDataUri beginShotRender uses for continuity). Lets an
   * operator QA composition/likeness before paying for a full-length render.
   *
   * Deliberately does NOT touch video_shot_render_jobs or shot.status (the
   * real render pipeline's bookkeeping) -- only the shot's preview_*
   * columns -- so it can run whether the shot is draft, done, or failed,
   * and never races beginShotRender or the tick. Polls the provider
   * synchronously, bounded by PREVIEW_POLL_TIMEOUT_MS, rather than going
   * through the async tick: a 1-second clip finishes in well under that, and
   * "one-click preview" means a direct answer, not a second job to poll from
   * the UI.
   */
  async function renderPreview(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor) {
    await settings.assertAdvancedEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    if (storyline.status === "stitching") {
      throw conflict("A stitch is currently running for this storyline. Wait for it to finish before rendering a preview.");
    }
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.status === "queued" || shot.status === "rendering") {
      throw conflict("This shot is currently rendering. Wait for it to finish before rendering a preview.");
    }

    const providerId = (shot.providerId ?? storyline.providerId) as VideoStorylineProvider;
    const model = shot.model ?? storyline.model;
    const previewEstimate = estimateVideoStorylineCostCents([{ durationSeconds: PREVIEW_DURATION_SECONDS }], providerId);
    if (storyline.budgetCapCents !== null && storyline.spentCents + previewEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      throw unprocessable(
        `Rendering a preview (estimated ${previewEstimate.estimatedTotalCents} cents) would exceed the budget cap (${storyline.budgetCapCents} cents). Raise the cap first.`,
      );
    }

    const apiKey = await resolveProviderApiKey(companyId, providerId, actor.agentId ?? actor.actorId);
    const provider = buildProvider(providerId, apiKey, model);

    let continuityImage: string | undefined;
    const previous = await closestPreviousDoneShot(storyline.id, shot.orderIndex);
    if (previous?.resultObjectKey && previous.resultProvider && previous.resultContentType) {
      const clip = await downloadClipFromStorage(companyId, previous.resultProvider, previous.resultObjectKey);
      if (clip) continuityImage = (await extractLastFrameDataUri(clip)) ?? undefined;
    }
    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const referenceImages = await loadReferenceImages(db, companyId, referenceAssetIds);
    const startImage = continuityImage ?? referenceImages[0];

    const handle = await provider.start({
      kind: "video",
      prompt: shot.prompt,
      model: model ?? undefined,
      startImage,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      durationSeconds: PREVIEW_DURATION_SECONDS,
    });

    const deadline = nowOf().getTime() + PREVIEW_POLL_TIMEOUT_MS;
    let outcome: MediaPollOutcome = { status: "running" };
    while (nowOf().getTime() < deadline) {
      outcome = await provider.poll(handle);
      if (outcome.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_INTERVAL_MS));
    }
    if (outcome.status === "running") {
      try {
        await provider.cancel(handle);
      } catch {
        // Best effort -- the request still fails either way.
      }
      throw unprocessable("The preview did not finish in time. Try again in a moment.");
    }
    if (outcome.status === "failed") {
      throw unprocessable(`Preview render failed: ${outcome.error}`);
    }

    const { buffer, contentType } = await downloadResultBytes(outcome.result);
    await assertMediaContentType(contentType);
    const frameDataUri = await extractLastFrameDataUri(buffer);
    if (!frameDataUri) {
      throw unprocessable("Still-frame extraction needs ffmpeg, which is not available on this host.");
    }
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(frameDataUri);
    if (!match) throw new Error("extractLastFrameDataUri returned an unrecognized data URI");
    const frameBuffer = Buffer.from(match[2]!, "base64");

    const stored = await getStorageService().putFile({
      companyId,
      namespace: `video-storylines/${storyline.id}/previews`,
      originalFilename: `shot-${String(shot.orderIndex).padStart(6, "0")}-preview.jpg`,
      contentType: match[1]!,
      body: frameBuffer,
    });

    const generatedAt = nowOf();
    const [row] = await db
      .update(videoShots)
      .set({
        previewProvider: stored.provider,
        previewObjectKey: stored.objectKey,
        previewContentType: stored.contentType,
        previewByteSize: stored.byteSize,
        previewSha256: stored.sha256,
        previewGeneratedAt: generatedAt,
        updatedAt: generatedAt,
      })
      .where(eq(videoShots.id, shotId))
      .returning();
    if (!row) throw new Error("Video shot preview update returned no row");

    await db
      .update(videoStorylines)
      .set({ spentCents: storyline.spentCents + previewEstimate.estimatedTotalCents, updatedAt: generatedAt })
      .where(eq(videoStorylines.id, storylineId));

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.preview_rendered",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex, costCents: previewEstimate.estimatedTotalCents },
    });
    return storylines.toShotSummary(row);
  }

  /**
   * DUR-4170: stop an in-flight render cleanly. Only valid from "rendering"
   * (an actual provider job may be running) or "paused" (stopped already,
   * but the operator wants to abandon rather than re-render) -- "stitching"
   * is explicitly refused rather than silently ignored, since stitchOne has
   * no cancellation hook and would otherwise race this and clobber whatever
   * status this sets once it finishes (see video-storyline-stitch.ts).
   * Provider-side cancellation is best-effort (mirrors the tick's own
   * give-up-after-timeout path above): a provider/network failure here must
   * never block the storyline from reaching "cancelled".
   */
  async function cancelRender(companyId: string, storylineId: string, actor: VideoStorylineActor) {
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    if (storyline.status === "stitching") {
      throw conflict("A stitch is currently running for this storyline. Wait for it to finish before cancelling.");
    }
    if (!["rendering", "paused"].includes(storyline.status)) {
      throw conflict(`This storyline is ${storyline.status.replace(/_/g, " ")} and has no in-flight render to cancel.`);
    }

    const runningJobs = await db
      .select()
      .from(videoShotRenderJobs)
      .where(and(eq(videoShotRenderJobs.storylineId, storylineId), eq(videoShotRenderJobs.status, "running")));

    for (const job of runningJobs) {
      try {
        const apiKey = await resolveProviderApiKey(companyId, job.provider as VideoStorylineProvider, actor.agentId ?? actor.actorId);
        const handle: MediaJobHandle = { externalId: job.externalId, model: job.model, provider: job.provider };
        await buildProvider(job.provider as VideoStorylineProvider, apiKey, job.model).cancel(handle);
      } catch (err) {
        logger.warn({ err, jobId: job.id }, "video-storyline-render: best-effort provider cancel failed during cancelRender");
      }
      await db
        .update(videoShotRenderJobs)
        .set({ status: "failed", error: "Cancelled by user.", completedAt: nowOf(), updatedAt: nowOf() })
        .where(eq(videoShotRenderJobs.id, job.id));
    }

    const runningShotIds = runningJobs.map((job) => job.shotId);
    if (runningShotIds.length > 0) {
      await db
        .update(videoShots)
        .set({ status: "failed", errorMessage: "Cancelled by user.", updatedAt: nowOf() })
        .where(inArray(videoShots.id, runningShotIds));
    }

    await db
      .update(videoStorylines)
      .set({ status: "cancelled", errorMessage: null, updatedAt: nowOf() })
      .where(eq(videoStorylines.id, storylineId));

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.render_cancelled",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { cancelledJobCount: runningJobs.length },
    });
    return storylines.getStoryline(companyId, storylineId);
  }

  async function assertMediaContentType(contentType: string): Promise<string> {
    const normalized = (contentType || "").trim().toLowerCase();
    if (!normalized.startsWith(CONTENT_TYPE_PREFIX)) {
      throw new Error(`Provider returned a non-video content type: "${contentType}"`);
    }
    return normalized;
  }

  const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s;

  async function downloadResultBytes(result: { url?: string; dataUrl?: string; contentType: string }): Promise<{ buffer: Buffer; contentType: string }> {
    if (result.dataUrl) {
      const match = DATA_URL_PATTERN.exec(result.dataUrl);
      if (!match?.[3]) throw new Error("Unrecognized (or non-base64) media data URL from provider");
      return { buffer: Buffer.from(match[3], "base64"), contentType: await assertMediaContentType(match[1] || result.contentType) };
    }
    if (result.url) {
      const response = await safeFetch(result.url, undefined, CLIP_MAX_BYTES);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { buffer: bytes, contentType: await assertMediaContentType(response.headers.get("content-type") || result.contentType) };
    }
    throw new Error("Provider returned neither a url nor a dataUrl");
  }

  async function onShotFailed(companyId: string, storylineId: string, shotId: string, jobId: string, errorMessage: string) {
    await db.update(videoShotRenderJobs).set({ status: "failed", error: errorMessage, completedAt: nowOf(), updatedAt: nowOf() }).where(eq(videoShotRenderJobs.id, jobId));
    await db.update(videoShots).set({ status: "failed", errorMessage, updatedAt: nowOf() }).where(eq(videoShots.id, shotId));
    await db.update(videoStorylines).set({ status: "paused", errorMessage: `A shot failed: ${errorMessage}. Re-render it to continue.`, updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
  }

  async function onShotDone(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
    shot: typeof videoShots.$inferSelect,
    jobId: string,
    result: { url?: string; dataUrl?: string; contentType: string; meta?: Record<string, unknown> },
    fal: { apiKey: string; model: string } | null = null,
  ) {
    const { buffer, contentType } = await downloadResultBytes(result);
    const stored = await getStorageService().putFile({
      companyId,
      namespace: `video-storylines/${storyline.id}`,
      originalFilename: `shot-${String(shot.orderIndex).padStart(6, "0")}.mp4`,
      contentType,
      body: buffer,
    });
    const estimateForShot = estimateVideoStorylineCostCents([{ durationSeconds: shot.durationSeconds }], storyline.providerId as VideoStorylineProvider);
    let actualCostCents = estimateForShot.estimatedTotalCents;
    // DUR-4455: Fal video is priced per its published unit (usually seconds); Sogni has no Fal price and keeps the static estimate.
    if (storyline.providerId === "fal" && fal) {
      const recorded = await recordFalCostEvent(db, safeFetch, {
        companyId,
        apiKey: fal.apiKey,
        agentId: storyline.createdByAgentId,
        createdByUserId: storyline.createdByAgentId ? null : storyline.createdByUserId,
        model: fal.model,
        usage: { seconds: shot.durationSeconds },
        estimateCents: estimateForShot.estimatedTotalCents,
        billingCode: "video-storyline-shot",
      });
      if (recorded) actualCostCents = recorded.costCents;
    }

    // DUR-4456: on top of the estimate-based budget tracking above (unchanged,
    // since Sogni has no exact USD price), write a real cost_events row when
    // Sogni reported actual credits for this job -- tagged
    // converted_from_credits, never silently recorded as 0 when the owner
    // hasn't set a credit price yet.
    if (storyline.providerId === "sogni") {
      const sogniCredits = typeof result.meta?.sogniCredits === "number" ? result.meta.sogniCredits : null;
      if (sogniCredits !== null) {
        const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
        const config = plugin ? await registry.getConfig(plugin.id) : null;
        const cfg = (config?.configJson ?? {}) as Record<string, unknown>;
        await recordSogniCost(db, {
          companyId,
          agentId: storyline.createdByAgentId ?? null,
          credits: sogniCredits,
          creditPriceUsd: cfg[SOGNI_CREDIT_PRICE_CONFIG_KEY],
          model: shot.model ?? storyline.model ?? "sogni-video",
          // Per-shot key so a retried tick after a crash does not write a second row.
          billingCode: `video_storyline_render:${shot.id}`,
          idempotent: true,
        }).catch((err) => {
          logger.error({ err, shotId: shot.id }, "video-storyline-render: could not record Sogni actual cost");
        });
      }
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
        actualCostCents,
        errorMessage: null,
        updatedAt: nowOf(),
      })
      .where(eq(videoShots.id, shot.id));
    await db.update(videoShotRenderJobs).set({ status: "done", completedAt: nowOf(), updatedAt: nowOf() }).where(eq(videoShotRenderJobs.id, jobId));

    const spentCents = storyline.spentCents + actualCostCents;
    const next = await nextPendingShot(storyline.id);
    if (!next) {
      await db.update(videoStorylines).set({ spentCents, status: "ready_to_stitch", updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));
      return;
    }
    // DUR-4317/DUR-4320: a shot can be edited (resetting it to 'pending')
    // after the render chain already started on earlier shots -- pause here
    // with a clear reason rather than calling beginShotRender and letting
    // its own guard throw, which would leave the storyline stuck
    // "rendering" forever (the tick's try/catch would just log and skip it).
    if (next.storyboardStatus !== "approved") {
      await db
        .update(videoStorylines)
        .set({
          spentCents,
          status: "paused",
          errorMessage: `Shot ${next.orderIndex}'s storyboard still needs approval before rendering can continue. Approve it and start the render again.`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return;
    }
    const nextEstimate = estimateVideoStorylineCostCents([{ durationSeconds: next.durationSeconds }], storyline.providerId as VideoStorylineProvider);
    if (storyline.budgetCapCents !== null && spentCents + nextEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      await db
        .update(videoStorylines)
        .set({ spentCents, status: "paused", errorMessage: `Budget cap reached before shot ${next.orderIndex}. Raise the cap and start the render again to continue.`, updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storyline.id));
      return;
    }
    await db.update(videoStorylines).set({ spentCents, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));
    const refreshedStoryline = await storylines.getStorylineRow(companyId, storyline.id);
    await beginShotRender(companyId, refreshedStoryline, next, storyline.createdByAgentId ?? storyline.createdByUserId ?? "system");
  }

  /**
   * The scheduler tick: advance every in-flight render job one step, a
   * bounded batch at a time (VIDEO_RENDER_TICK_BATCH), across every company
   * -- called from index.ts's heartbeat scheduler inside
   * runInCompanyScopeBypass, the same pattern mailSecretary.tick and
   * paymentCards.runDailyExpiryTick use. One job failing to advance is
   * logged and skipped; it never stops the batch.
   */
  async function tick(): Promise<{ advanced: number; failed: number }> {
    const running = await db
      .select()
      .from(videoShotRenderJobs)
      .where(eq(videoShotRenderJobs.status, "running"))
      .orderBy(asc(videoShotRenderJobs.startedAt))
      .limit(VIDEO_RENDER_TICK_BATCH);

    let advanced = 0;
    let failed = 0;
    for (const job of running) {
      try {
        const [shot] = await db.select().from(videoShots).where(eq(videoShots.id, job.shotId));
        const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, job.storylineId));
        if (!shot || !storyline) {
          await db.update(videoShotRenderJobs).set({ status: "failed", error: "Shot or storyline no longer exists", completedAt: nowOf(), updatedAt: nowOf() }).where(eq(videoShotRenderJobs.id, job.id));
          continue;
        }
        if (nowOf().getTime() - job.startedAt.getTime() > VIDEO_RENDER_JOB_MAX_AGE_MS) {
          const handle: MediaJobHandle = { externalId: job.externalId, model: job.model, provider: job.provider };
          try {
            const apiKey = await resolveProviderApiKey(job.companyId, job.provider as VideoStorylineProvider, storyline.createdByAgentId ?? "system");
            await buildProvider(job.provider as VideoStorylineProvider, apiKey, job.model).cancel(handle);
          } catch {
            // Best effort -- the job is being marked failed regardless.
          }
          await onShotFailed(job.companyId, job.storylineId, job.shotId, job.id, `Gave up after ${Math.round(VIDEO_RENDER_JOB_MAX_AGE_MS / 60_000)} minutes without a result.`);
          failed += 1;
          continue;
        }

        const apiKey = await resolveProviderApiKey(job.companyId, job.provider as VideoStorylineProvider, storyline.createdByAgentId ?? "system");
        const provider = buildProvider(job.provider as VideoStorylineProvider, apiKey, job.model);
        const outcome = await provider.poll({ externalId: job.externalId, model: job.model, provider: job.provider });
        if (outcome.status === "running") {
          await db.update(videoShotRenderJobs).set({ updatedAt: nowOf() }).where(eq(videoShotRenderJobs.id, job.id));
          continue;
        }
        if (outcome.status === "failed") {
          await onShotFailed(job.companyId, job.storylineId, job.shotId, job.id, outcome.error);
          failed += 1;
          continue;
        }
        await onShotDone(job.companyId, storyline, shot, job.id, outcome.result, { apiKey, model: job.model });
        advanced += 1;
      } catch (err) {
        logger.error({ err, jobId: job.id }, "video-storyline-render: tick could not advance a render job");
      }
    }
    return { advanced, failed };
  }

  return { estimate, startRender, reRenderShot, renderPreview, cancelRender, tick };
}
