import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, issueAttachments, videoShotRenderJobs, videoShots, videoStorylines, withCompanyScope } from "@paperclipai/db";
import {
  MEDIA_STUDIO_PLUGIN_KEY,
  VIDEO_RENDER_JOB_MAX_AGE_MS,
  VIDEO_RENDER_TICK_BATCH,
  VIDEO_SHOT_MIN_DURATION_SECONDS,
  estimateVideoStorylineCostCents,
  readVideoStorylineCast,
  videoRenderDurationSeconds,
  videoShotCast,
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
import { sogniStorageFetch } from "./image-provider-clients.js";
import { loadApprovedStillDataUri } from "./video-storyline-still-frame.js";
import { videoStorylineSettingsService } from "./video-storyline-settings.js";
import { lockStorylineRow, videoStorylineService, type VideoStorylineActor } from "./video-storylines.js";
import { executePinnedHttpRequest, validateAndResolveFetchUrl } from "./safe-outbound-fetch.js";
import { mediaStudioKeyRef } from "./media-studio-company-keys.js";
import {
  castIdentityNames,
  castPeople,
  castPictureRefusal,
  castVideoPictures,
  loadCastAgeRefusals,
  loadLinkedCastIdentities,
} from "./storyline-cast.js";

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
  // Uploads go to Sogni's storage as real multipart bytes through the same pinned fetch (see sogniStorageFetch).
  return new SogniVideoProvider({ apiKey, apiFetch: safeFetch, transferFetch: sogniStorageFetch(safeFetch), defaultModel: model ?? undefined });
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
  const byId = new Map<string, { provider: string; objectKey: string; contentType: string }>(rows.map((r) => [r.id, r]));
  // The editor picks character/look pictures from Media Studio's saved
  // Looks, whose reference ids are company FILE ids (issue_attachments.id,
  // what the plugin file API hands out) -- not assets.id. Looking those up
  // only in `assets` found nothing, so every character picture was silently
  // dropped from stills and renders. Resolve either kind of id.
  const unresolved = ids.filter((id) => !byId.has(id));
  if (unresolved.length > 0) {
    const fileRows = await db
      .select({ fileId: issueAttachments.id, provider: assets.provider, objectKey: assets.objectKey, contentType: assets.contentType })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(and(eq(issueAttachments.companyId, companyId), inArray(issueAttachments.id, unresolved)));
    for (const row of fileRows) byId.set(row.fileId, row);
  }
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

type StorylineRow = typeof videoStorylines.$inferSelect;
type ShotRow = typeof videoShots.$inferSelect;

/**
 * Security review: the ONE provider/model resolution every render-cost
 * estimate and the actual render call share -- a shot's own provider/model
 * (set from the last real render job) wins over the storyline's. Before,
 * beginShotRender billed with the shot's values while the budget gates
 * estimated with the storyline's, so a shot re-rendered on a pricier model
 * could pass a budget check it should have failed.
 */
export function resolveShotRenderTarget(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shot: Pick<ShotRow, "providerId" | "model">,
): { providerId: VideoStorylineProvider; model: string | null } {
  return {
    providerId: (shot.providerId ?? storyline.providerId) as VideoStorylineProvider,
    model: shot.model ?? storyline.model,
  };
}

/** Render-cost estimate for a set of shots, each priced with resolveShotRenderTarget (shots on different providers/models are summed). */
export function estimateShotRenderCents(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shots: ReadonlyArray<Pick<ShotRow, "providerId" | "model" | "durationSeconds">>,
): { shotCount: number; totalSeconds: number; estimatedTotalCents: number } {
  let totalSeconds = 0;
  let estimatedTotalCents = 0;
  for (const shot of shots) {
    const { providerId, model } = resolveShotRenderTarget(storyline, shot);
    const one = estimateVideoStorylineCostCents([{ durationSeconds: shot.durationSeconds }], providerId, { model });
    totalSeconds += one.totalSeconds;
    estimatedTotalCents += one.estimatedTotalCents;
  }
  return { shotCount: shots.length, totalSeconds, estimatedTotalCents };
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
   * The shot's linked cast members' pictures for the video call: per person
   * the face crop, the canonical render and the body crop (the approved
   * storyboard picture stays the start frame). Whether a video model really
   * uses them is the provider client's call (video-provider-clients.ts:
   * Fal's Kling v3 takes them as one "element" per person; Sogni's
   * reference-to-video models as loose references; Sogni's image-to-video
   * models take only the start frame). Pictures the age check refused are
   * never sent: the render is refused with a plain message instead.
   */
  async function castVideoInput(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
    shot: typeof videoShots.$inferSelect,
  ): Promise<{ characters: Array<{ name: string; images: string[] }>; flat: string[]; startFallback: string | undefined }> {
    const empty = { characters: [], flat: [], startFallback: undefined };
    const cast = readVideoStorylineCast(storyline.pictureSettings);
    if (!cast.members.some((m) => m.identityId)) return empty;
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    const pluginId = plugin?.id ?? null;
    const identities = await loadLinkedCastIdentities(db, pluginId, companyId, cast.members);
    const { castIds } = videoShotCast(shot, cast, castIdentityNames(identities));
    const { people } = castPeople(castIds, cast.members, identities);
    if (people.length === 0) return empty;
    const wanted = castVideoPictures(people);
    const loaded: Array<{ name: string; pictures: Array<{ fileId: string; dataUri: string | null }> }> = [];
    for (const person of wanted) {
      const pictures: Array<{ fileId: string; dataUri: string | null }> = [];
      for (const fileId of person.fileIds) {
        const [dataUri] = await loadReferenceImages(db, companyId, [fileId]);
        pictures.push({ fileId, dataUri: dataUri ?? null });
      }
      loaded.push({ name: person.name, pictures });
    }
    const refusal = castPictureRefusal(
      loaded.flatMap((p) => p.pictures.map((x) => ({ fileId: x.fileId, dataUri: x.dataUri, personName: p.name }))),
      await loadCastAgeRefusals(db, pluginId, companyId),
    );
    if (refusal) throw unprocessable(refusal);
    const characters = loaded
      .map((p) => ({ name: p.name, images: p.pictures.map((x) => x.dataUri).filter((x): x is string => !!x) }))
      .filter((c) => c.images.length > 0);
    // Everyone's first picture (the face) first, then everyone's second, ...: a model that only takes a few still gets every face.
    const flat: string[] = [];
    for (let k = 0; k < 3; k += 1) for (const c of characters) if (c.images[k]) flat.push(c.images[k]!);
    // Without an approved picture or a previous clip, the first person's canonical render (else face) is a better first frame than a look picture.
    const first = people[0]!.identity;
    const startFallback = first.canonicalFileId
      ? loaded[0]?.pictures.find((x) => x.fileId === first.canonicalFileId)?.dataUri ?? characters[0]?.images[0]
      : characters[0]?.images[0];
    return { characters, flat, startFallback: startFallback ?? undefined };
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
        `Shot ${shot.orderIndex + 1}'s storyboard still has not been approved yet. Generate and approve a still for it (or drop it) before rendering.`,
      );
    }
    const { providerId, model } = resolveShotRenderTarget(storyline, shot);
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
    const cast = await castVideoInput(companyId, storyline, shot);
    // The cast's pictures first (faces first), then the shot's and storyline's pictures.
    const referenceImages = [...cast.flat, ...(await loadReferenceImages(db, companyId, referenceAssetIds))].slice(0, MAX_REFERENCE_IMAGES);
    // See media-jobs-types.ts's MediaJobInput.referenceImages doc comment: neither provider confirms
    // combining a continuity frame with separate character pictures in one call, so we pick ONE image
    // to actually drive continuity/likeness -- the approved still wins, then the continuity frame.
    const startImage = approvedStillImage ?? continuityImage ?? cast.startFallback ?? referenceImages[0];

    const input: MediaJobInput = {
      kind: "video",
      prompt: shot.prompt,
      model: model ?? undefined,
      startImage,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      ...(cast.characters.length > 0 ? { characters: cast.characters } : {}),
      // Snapped to a length the model accepts (Fal's Kling models only take
      // 5 or 10 seconds and refuse anything else) -- see
      // videoRenderDurationSeconds; the estimate bills the same length.
      durationSeconds: videoRenderDurationSeconds(providerId, model, shot.durationSeconds),
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
    if (!["draft", "estimated", "paused", "failed", "cancelled"].includes(storyline.status)) {
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
        `Shot ${unapproved.orderIndex + 1}'s storyboard still has not been approved yet. Approve every shot's still before starting the render (or drop shots you don't want to render).`,
      );
    }

    const estimateResult = estimateShotRenderCents(storyline, renderableShots);
    const effectiveBudgetCapCents = input.confirmBudgetCapCents ?? storyline.budgetCapCents;
    if (effectiveBudgetCapCents === null || effectiveBudgetCapCents === undefined) {
      throw badRequest(
        `Set a budget cap before starting a render, so spending stops at a limit you chose. This render is estimated at ${formatDollars(estimateResult.estimatedTotalCents)}.`,
      );
    }
    // Only shots still to render cost anything from here on -- counting
    // already-finished shots again (their cost is in spentCents) made a
    // storyline paused at its cap impossible to resume.
    const remainingEstimate = estimateShotRenderCents(
      storyline,
      renderableShots.filter((s) => s.status !== "done"),
    );
    if (storyline.spentCents + remainingEstimate.estimatedTotalCents > effectiveBudgetCapCents) {
      throw unprocessable(
        `This render is estimated at ${formatDollars(remainingEstimate.estimatedTotalCents)}, and ${formatDollars(storyline.spentCents)} is already spent -- together that is over the budget cap of ${formatDollars(effectiveBudgetCapCents)}. Raise the budget cap to at least ${formatDollars(storyline.spentCents + remainingEstimate.estimatedTotalCents)} to go ahead.`,
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

    // Security review (replace-import TOCTOU): flip to "rendering" under the
    // storyline row lock a "replace" import also takes, after re-checking
    // nothing moved since the reads above -- a replace that committed in
    // between has deleted `pending`, and one that comes after sees
    // "rendering" and is refused.
    const lockedPending = await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      if (!["draft", "estimated", "paused", "failed", "cancelled"].includes(locked.status)) {
        throw conflict(`This storyline is already ${locked.status.replace(/_/g, " ")}.`);
      }
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, pending.id), eq(videoShots.storylineId, storylineId)));
      if (!current || current.storyboardStatus !== "approved" || current.status === "done") {
        throw conflict("This storyline's shots changed while the render was starting. Check them and start the render again.");
      }
      await tx
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
      return current;
    });
    const refreshed = await storylines.getStorylineRow(companyId, storylineId);
    await beginShotRender(companyId, refreshed, lockedPending, actor.agentId ?? actor.actorId);

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
      throw unprocessable(`Shot ${shot.orderIndex + 1}'s storyboard still has not been approved yet. Approve it before re-rendering.`);
    }
    const refundCents = shot.actualCostCents ?? 0;
    const spentAfterRefund = Math.max(0, storyline.spentCents - refundCents);
    const shotEstimate = estimateShotRenderCents(storyline, [shot]);
    if (storyline.budgetCapCents !== null && spentAfterRefund + shotEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      throw unprocessable(
        `Re-rendering this shot (estimated ${shotEstimate.estimatedTotalCents} cents) would push spend to ${spentAfterRefund + shotEstimate.estimatedTotalCents} cents, over the budget cap (${storyline.budgetCapCents} cents). Raise the cap first.`,
      );
    }
    // Security review (replace-import TOCTOU): queue the shot and flip the
    // storyline to "rendering" under the storyline row lock a "replace"
    // import also takes, re-checking the shot is still there and idle.
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      if (locked.status === "stitching") {
        throw conflict("A stitch is currently running for this storyline. Wait for it to finish before re-rendering a shot.");
      }
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, shotId), eq(videoShots.storylineId, storylineId)));
      if (!current) throw conflict("This shot was removed while the re-render was starting.");
      if (current.status === "queued" || current.status === "rendering") throw conflict("This shot is already rendering.");
      const lockedRefund = current.actualCostCents ?? 0;
      await tx
        .update(videoShots)
        .set({ status: "queued", errorMessage: null, resultProvider: null, resultObjectKey: null, resultContentType: null, resultByteSize: null, resultSha256: null, actualCostCents: null, updatedAt: nowOf() })
        .where(eq(videoShots.id, shotId));
      await tx
        .update(videoStorylines)
        .set({
          ...(lockedRefund > 0 ? { spentCents: Math.max(0, locked.spentCents - lockedRefund) } : {}),
          ...(locked.status !== "rendering" ? { status: "rendering", errorMessage: null } : {}),
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storylineId));
    });
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

    const { providerId, model } = resolveShotRenderTarget(storyline, shot);
    // The shortest clip this model will actually make (1s for a model that
    // takes any length, 5s for Fal's Kling models, which refuse 1s).
    const previewDurationSeconds = videoRenderDurationSeconds(providerId, model, PREVIEW_DURATION_SECONDS);
    const previewEstimate = estimateVideoStorylineCostCents([{ durationSeconds: previewDurationSeconds }], providerId);
    const previewCents = previewEstimate.estimatedTotalCents;
    const overCap = (row: { budgetCapCents: number | null; spentCents: number }) =>
      row.budgetCapCents !== null && row.spentCents + previewCents > row.budgetCapCents;
    if (overCap(storyline)) {
      throw unprocessable(
        `Rendering a preview (estimated ${previewCents} cents) would exceed the budget cap (${storyline.budgetCapCents} cents). Raise the cap first.`,
      );
    }

    // Security review (replace-import TOCTOU): reserve the preview's cost
    // under the storyline row lock a "replace" import also takes, before the
    // paid provider call -- spentCents > 0 makes a replace refuse while this
    // preview is in flight. Refunded below if the preview fails.
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      if (locked.status === "stitching") {
        throw conflict("A stitch is currently running for this storyline. Wait for it to finish before rendering a preview.");
      }
      const [current] = await tx.select({ id: videoShots.id }).from(videoShots).where(and(eq(videoShots.id, shotId), eq(videoShots.storylineId, storylineId)));
      if (!current) throw conflict("This shot was removed while the preview was starting.");
      if (overCap(locked)) {
        throw unprocessable(
          `Rendering a preview (estimated ${previewCents} cents) would exceed the budget cap (${locked.budgetCapCents} cents). Raise the cap first.`,
        );
      }
      await tx
        .update(videoStorylines)
        .set({ spentCents: sql`${videoStorylines.spentCents} + ${previewCents}`, updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storylineId));
    });
    try {
      return await finishPreview(companyId, storyline, shot, providerId, model, previewDurationSeconds, previewCents, actor);
    } catch (err) {
      await db
        .update(videoStorylines)
        .set({ spentCents: sql`greatest(0, ${videoStorylines.spentCents} - ${previewCents})`, updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storylineId));
      throw err;
    }
  }

  async function finishPreview(
    companyId: string,
    storyline: StorylineRow,
    shot: ShotRow,
    providerId: VideoStorylineProvider,
    model: string | null,
    previewDurationSeconds: number,
    previewCents: number,
    actor: VideoStorylineActor,
  ) {
    const shotId = shot.id;
    const apiKey = await resolveProviderApiKey(companyId, providerId, actor.agentId ?? actor.actorId);
    const provider = buildProvider(providerId, apiKey, model);

    let continuityImage: string | undefined;
    const previous = await closestPreviousDoneShot(storyline.id, shot.orderIndex);
    if (previous?.resultObjectKey && previous.resultProvider && previous.resultContentType) {
      const clip = await downloadClipFromStorage(companyId, previous.resultProvider, previous.resultObjectKey);
      if (clip) continuityImage = (await extractLastFrameDataUri(clip)) ?? undefined;
    }
    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const cast = await castVideoInput(companyId, storyline, shot);
    const referenceImages = [...cast.flat, ...(await loadReferenceImages(db, companyId, referenceAssetIds))].slice(0, MAX_REFERENCE_IMAGES);
    const startImage = continuityImage ?? cast.startFallback ?? referenceImages[0];

    const handle = await provider.start({
      kind: "video",
      prompt: shot.prompt,
      model: model ?? undefined,
      startImage,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      ...(cast.characters.length > 0 ? { characters: cast.characters } : {}),
      durationSeconds: previewDurationSeconds,
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

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_shot.preview_rendered",
      entityType: "video_shot",
      entityId: shotId,
      details: { orderIndex: shot.orderIndex, costCents: previewCents },
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
    const target = resolveShotRenderTarget(storyline, shot);
    const estimateForShot = estimateShotRenderCents(storyline, [shot]);
    let actualCostCents = estimateForShot.estimatedTotalCents;
    // DUR-4455: Fal video is priced per its published unit (usually seconds); Sogni has no Fal price and keeps the static estimate.
    if (target.providerId === "fal" && fal) {
      const recorded = await recordFalCostEvent(db, safeFetch, {
        companyId,
        apiKey: fal.apiKey,
        agentId: storyline.createdByAgentId,
        createdByUserId: storyline.createdByAgentId ? null : storyline.createdByUserId,
        model: fal.model,
        usage: { seconds: videoRenderDurationSeconds("fal", target.model, shot.durationSeconds) },
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
    if (target.providerId === "sogni") {
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
          model: target.model ?? "sogni-video",
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
          errorMessage: `Shot ${next.orderIndex + 1}'s storyboard still needs approval before rendering can continue. Approve it and start the render again.`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return;
    }
    const nextEstimate = estimateShotRenderCents(storyline, [next]);
    if (storyline.budgetCapCents !== null && spentCents + nextEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      await db
        .update(videoStorylines)
        .set({ spentCents, status: "paused", errorMessage: `Budget cap reached before shot ${next.orderIndex + 1}. Raise the cap and start the render again to continue.`, updatedAt: nowOf() })
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
