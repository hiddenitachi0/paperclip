import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, eq, inArray, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, issueAttachments, videoMediaSpend, videoShotRenderJobs, videoShots, videoStorylines, withCompanyScope } from "@paperclipai/db";
import { sendableDataUriBytes, videoStorylineFootageService } from "./video-storyline-footage.js";
import {
  MEDIA_STUDIO_PLUGIN_KEY,
  VIDEO_RENDER_JOB_MAX_AGE_MS,
  VIDEO_RENDER_TICK_BATCH,
  VIDEO_SHOT_MIN_DURATION_SECONDS,
  estimateVideoStorylineCostCents,
  readVideoStorylineCast,
  videoRenderDurationSeconds,
  videoCastCheckRequiredAtStart,
  videoShotCast,
  VIDEO_CAST_ENFORCED_KEY,
  unconfirmedVideoCastMessage,
  unconfirmedVideoCastShots,
  videoShotOnlyCastLine,
  videoShotVideoPrompt,
  videoRenderRequestPayloadSchema,
  type StartVideoStorylineRenderInput,
  type VideoStorylineProvider,
} from "@paperclipai/shared";
import type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaPollOutcome } from "./video-provider-clients.js";
import { FalVideoProvider, SOGNI_DEFAULT_VIDEO_MODEL, SogniVideoProvider } from "./video-provider-clients.js";
import { badRequest, conflict, HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { recordFalCostEvent } from "./fal-cost-events.js";
import { releaseStorylineMediaSpend, settleSogniStorylineSpend, storylineAnimateSpendCode } from "./storyline-media-ledger.js";
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
import { lockStorylineRow, videoStorylineService, type ScopedTx, type VideoStorylineActor } from "./video-storylines.js";
import { executePinnedHttpRequest, validateAndResolveFetchUrl, pinnedToFetchResponse } from "./safe-outbound-fetch.js";
import { companyMediaStudioKeyRef, mediaStudioKeyRef } from "./media-studio-company-keys.js";
import {
  castIdentityNames,
  castPeople,
  castPictureRefusal,
  castVideoPictures,
  loadCastAgeRefusals,
  loadLinkedCastIdentities,
} from "./storyline-cast.js";
import { estimateShotRenderCents, loadMadeClipTargets, realVideoModel, resolveShotRenderTarget, shotClipTiming } from "./video-storyline-shot-target.js";

// The provider/model resolution lives in video-storyline-shot-target.ts; re-exported for the strip and clip services.
export { estimateShotRenderCents, resolveShotRenderTarget, shotClipTiming };

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
 * for how a single bad shot gets retried without touching the rest (it renders
 * that one shot and never starts or resumes the chain; only startRender does).
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
/**
 * How long a storyline may sit on "rendering" with no render job running
 * before the tick calls it stalled. Longer than the slowest real start (a
 * few reference uploads at 30 s each), so a start in progress is never cut.
 */
export const STALLED_RENDER_GRACE_MS = 15 * 60_000;
/**
 * Everything beginShotRender does, from its first read up to and including the
 * video service's start call, must finish inside this. It is well under
 * STALLED_RENDER_GRACE_MS on purpose: a start that outlives the grace could be
 * swept as stalled (and the shot re-rendered and paid for again) while it was
 * still about to create its own paid job (DUR-4944).
 */
export const SHOT_START_DEADLINE_MS = 10 * 60_000;

/** What a shot shows when it was left queued/rendering with no video service job behind it. */
const SHOT_NEVER_STARTED_MESSAGE = "This shot never started on the video service. Nothing was charged for it. Try it again.";

/** SSRF-guarded FetchImpl, reused for both provider API calls and downloading finished clips -- see safe-outbound-fetch.ts. */
async function safeFetch(url: string, init?: RequestInit, maxResponseBytes = 8 * 1024 * 1024, outerSignal?: AbortSignal): Promise<Response> {
  const target = await validateAndResolveFetchUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.method === "GET" || !init?.method ? CLIP_DOWNLOAD_TIMEOUT_MS : RENDER_API_FETCH_TIMEOUT_MS);
  // The caller's own deadline (a shot start's, see SHOT_START_DEADLINE_MS) cuts the request short as well.
  const onOuterAbort = () => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const pinned = await executePinnedHttpRequest(target, init, controller.signal, { maxResponseBytes });
    return pinnedToFetchResponse(pinned);
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Storyline strip: AI transitions use the same guarded fetch and provider clients as shot renders. */
export { safeFetch as storylineSafeFetch };

export function buildProvider(providerId: VideoStorylineProvider, apiKey: string, model: string | null, signal?: AbortSignal): MediaJobProvider {
  const fetchImpl: typeof safeFetch = signal ? (url, init, maxResponseBytes) => safeFetch(url, init, maxResponseBytes, signal) : safeFetch;
  if (providerId === "fal") {
    return new FalVideoProvider(apiKey, fetchImpl, model ?? undefined);
  }
  // Uploads go to Sogni's storage as real multipart bytes through the same pinned fetch (see sogniStorageFetch).
  return new SogniVideoProvider({ apiKey, apiFetch: fetchImpl, transferFetch: sogniStorageFetch(fetchImpl), defaultModel: model ?? undefined });
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

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PROVIDER_LABEL: Record<VideoStorylineProvider, string> = { fal: "Fal.ai", sogni: "Sogni" };

/**
 * One plain-English sentence for a render that could not start, with what to
 * do next. Our own refusals (HttpError: no key, picture not approved, budget,
 * ...) are already written for people and pass through unchanged. A failure
 * talking to the video service itself (its refusal, a timeout, a network
 * error, or a bug on our side) becomes "<service> didn't accept shot N: ...".
 * `charged` is false whenever the service never confirmed a job -- the
 * usual case -- so the person knows retrying costs nothing extra.
 */
export function describeRenderStartFailure(
  err: unknown,
  ctx: { providerId: VideoStorylineProvider; shotNumber: number; charged?: boolean },
): string {
  if (err instanceof HttpError) return err.message;
  const service = PROVIDER_LABEL[ctx.providerId] ?? "The video service";
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: unknown } | null)?.code;
  const status = /\((\d{3})\)/.exec(raw)?.[1];
  const shot = `shot ${ctx.shotNumber}`;
  // What to do next. A job the service may already have taken is never "free to retry".
  const retry = ctx.charged
    ? " The video service may have started it anyway: check its dashboard before trying again, so you don't pay twice."
    : " Nothing was charged. Try again in a minute.";
  const noCharge = ctx.charged ? retry : " Nothing was charged.";
  if (status === "401" || status === "403") {
    return `${service} didn't accept the API key while starting ${shot}. An owner or admin can check the key in Media Studio's Settings tab.${noCharge}`;
  }
  if (status === "402") {
    return `${service} says the account doesn't have enough credit to make ${shot}. Top it up on ${service}'s website, then start the render again.${noCharge}`;
  }
  if (status === "429" || status === "409") return `${service} is busy with other work for this account and turned ${shot} away for now.${retry}`;
  if (name === "AbortError" || /abort|timed? ?out/i.test(raw)) return `${service} didn't answer in time while ${shot} was being sent.${retry}`;
  if (
    (typeof code === "string" && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)/.test(code)) ||
    /fetch failed|socket hang up|getaddrinfo|could not reach/i.test(raw)
  ) {
    return `Couldn't reach ${service} to start ${shot}. The internet connection or ${service} may be down.${retry}`;
  }
  if (/^(Sogni|Fal|The starting frame|This Sogni video model)/.test(raw)) {
    // The provider clients' own messages (video-provider-clients.ts) are already plain sentences.
    // Room for Sogni's whole (cleaned, ~1500-character) reason: cutting it is how a refusal became undiagnosable.
    const said = raw.trim().slice(0, 2000);
    return `${service} didn't accept ${shot}: ${said}${/[.!?]$/.test(said) ? "" : "."}${retry}`;
  }
  // A bug on our side (a programming error, an unexpected answer): never show its raw text.
  return `Something went wrong on our side while sending ${shot} to ${service}. If it keeps happening, tell your admin.${retry}`;
}

/** Raised by beginShotRender when the video service never got (or never confirmed) the job. */
export class RenderStartError extends Error {
  readonly charged: boolean;
  constructor(
    message: string,
    readonly original: unknown,
    charged: boolean,
    /** The stamp this start gave the shot when it claimed it (DUR-4937): the shot's updated_at is still this while it is the start's own. */
    readonly claimedAt?: Date,
  ) {
    super(message);
    this.name = "RenderStartError";
    this.charged = charged;
  }
}

/**
 * Raised by beginShotRender when another caller already holds the shot (queued, rendering or done). The shot is that
 * caller's: the loser must leave it alone (never mark it failed, which would hand it to a third caller) and stop.
 */
export class ShotClaimLostError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = "ShotClaimLostError";
  }
}

export interface VideoStorylineRenderDeps {
  now?: () => Date;
  /** Test seam: the provider client for a shot render (production builds the real Fal/Sogni client). */
  buildProvider?: (providerId: VideoStorylineProvider, apiKey: string, model: string | null, signal?: AbortSignal) => MediaJobProvider;
  /** Test seam: the API key lookup (production reads the company's / instance's secret). */
  resolveApiKey?: (companyId: string, providerId: VideoStorylineProvider) => Promise<string>;
}

export function videoStorylineRenderService(db: Db, deps: VideoStorylineRenderDeps = {}) {
  const storylines = videoStorylineService(db);
  const settings = videoStorylineSettingsService(db);
  const registry = pluginRegistryService(db);
  const secrets = secretService(db);
  const approvals = approvalService(db);
  const footage = videoStorylineFootageService(db, { now: deps.now });
  const nowOf = () => deps.now?.() ?? new Date();

  /**
   * The Fal/Sogni key for one company's render: the company's own pick, else
   * the instance's key. That instance key is a secret OWNED by one company
   * (the instance owner's); secrets.resolveSecretValueForVideoRender refuses
   * a secret of any other company ("Secret must belong to same company"), so
   * this fallback can only ever reach this company's own secret -- never
   * another company's (Phase 0 check, tested in
   * video-storyline-transitions-service.test.ts). AI transitions pass
   * companyKeyOnly: they never fall back on the instance key (decision 15).
   */
  async function resolveProviderApiKey(
    companyId: string,
    providerId: VideoStorylineProvider,
    actorId: string,
    opts: { companyKeyOnly?: boolean } = {},
  ): Promise<string> {
    if (deps.resolveApiKey) return deps.resolveApiKey(companyId, providerId);
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    if (!plugin) throw unprocessable("The media-studio plugin is not installed, so there is no Fal/Sogni key configured.");
    const config = await registry.getConfig(plugin.id);
    const cfg = (config?.configJson ?? {}) as Record<string, unknown>;
    const service = providerId === "fal" ? "fal" : "sogni";
    if (opts.companyKeyOnly) {
      const own = await companyMediaStudioKeyRef(db, plugin.id, companyId, service);
      if (!own) {
        throw unprocessable(
          `AI transitions use this company's own ${providerId === "fal" ? "Fal.ai" : "Sogni"} key, and none is picked yet. The company's owner or an admin can pick one in Media Studio's Settings tab.`,
        );
      }
      return secrets.resolveSecretValueForVideoRender(companyId, own, { actorId });
    }
    // The company's own key (Media Studio's Settings tab), else the instance's.
    const ref = await mediaStudioKeyRef(db, plugin.id, companyId, service, cfg);
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

  /**
   * Excludes 'dropped' shots -- dropped shots never render and are never counted toward "is this storyline finished?" (see DUR-4317/DUR-4320's storyboard gate).
   * Also skips shots that are queued or rendering: a re-render of one shot during a running film must not make the chain
   * start the shot it is already rendering a second time (DUR-4937).
   */
  async function nextPendingShot(storylineId: string) {
    const [row] = await db
      .select()
      .from(videoShots)
      // Phase 2: only AI shots render; uploaded videos and photos are prepared by ffmpeg (video-storyline-clips.ts).
      .where(and(eq(videoShots.storylineId, storylineId), notInArray(videoShots.status, ["done", "queued", "rendering"]), ne(videoShots.storyboardStatus, "dropped"), eq(videoShots.clipKind, "generated")))
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

  /** The video text of a shot: description and camera notes, plus the "only these people" line when its cast is confirmed. */
  function shotVideoPrompt(storyline: typeof videoStorylines.$inferSelect, shot: typeof videoShots.$inferSelect): string {
    const base = videoShotVideoPrompt(shot.prompt, shot.cameraNotes);
    const line = videoShotOnlyCastLine(shot, readVideoStorylineCast(storyline.pictureSettings));
    return line ? `${base}\n\n${line}` : base;
  }

  /**
   * Refuses a paid call that would send a linked person's pictures for shots
   * nobody has confirmed the cast for (castVideoInput would otherwise guess
   * from names in the text). Used by every entry point other than the render
   * chain itself (startRender checks its own list; the chain and a paused
   * film's resume deliberately skip it, see startRender).
   */
  function assertVideoCastConfirmed(
    storyline: typeof videoStorylines.$inferSelect,
    shots: ReadonlyArray<{ id: string; orderIndex: number }>,
  ): void {
    const unconfirmed = unconfirmedVideoCastShots(readVideoStorylineCast(storyline.pictureSettings), shots);
    if (unconfirmed.length > 0) throw unprocessable(unconfirmedVideoCastMessage(unconfirmed.map((s) => s.orderIndex + 1)));
  }

  /** SQL for picture_settings with the cast-rule marker added, leaving the rest of the column as it is under the lock. */
  function markCastEnforced() {
    return sql`coalesce(${videoStorylines.pictureSettings}, '{}'::jsonb) || ${JSON.stringify({ [VIDEO_CAST_ENFORCED_KEY]: true })}::jsonb` as unknown as typeof videoStorylines.$inferSelect["pictureSettings"];
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
   * The shot's and storyline's own reference pictures as data: URIs, each
   * through the age check before anything is sent: the refusal set is
   * company-wide (file ids and byte hashes), so these pictures need no person.
   * Refuses the whole render (a plain message) when one was flagged.
   */
  async function checkedReferenceImages(companyId: string, assetIds: readonly string[]): Promise<string[]> {
    if (assetIds.length === 0) return [];
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    // One at a time so each file id is checked against its own bytes.
    const loaded: Array<{ fileId: string; dataUri: string | null }> = [];
    for (const fileId of assetIds.slice(0, MAX_REFERENCE_IMAGES)) {
      loaded.push({ fileId, dataUri: (await loadReferenceImages(db, companyId, [fileId]))[0] ?? null });
    }
    const refusal = castPictureRefusal(
      loaded.map((p) => ({ ...p, personName: null })),
      await loadCastAgeRefusals(db, plugin?.id ?? null, companyId),
    );
    if (refusal) throw unprocessable(refusal);
    return loaded.flatMap((p) => (p.dataUri ? [p.dataUri] : []));
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
  async function beginShotRender(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
    shot: typeof videoShots.$inferSelect,
    actorId: string,
    opts: { companyKeyOnly?: boolean; alreadyQueued?: boolean } = {},
  ) {
    // DUR-4944: one deadline for the whole start. The timer cuts the video service's requests short; the injected
    // clock is checked too, so a start that finishes late is stopped even if no request was running when it passed.
    const controller = new AbortController();
    const startedAtMs = nowOf().getTime();
    const deadline = {
      signal: controller.signal,
      passed: () => controller.signal.aborted || nowOf().getTime() - startedAtMs > SHOT_START_DEADLINE_MS,
    };
    const timer = setTimeout(() => controller.abort(), SHOT_START_DEADLINE_MS);
    try {
      await beginShotRenderWithinDeadline(companyId, storyline, shot, actorId, opts, deadline);
    } finally {
      clearTimeout(timer);
    }
  }

  async function beginShotRenderWithinDeadline(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
    shot: typeof videoShots.$inferSelect,
    actorId: string,
    opts: { companyKeyOnly?: boolean; alreadyQueued?: boolean },
    deadline: { signal: AbortSignal; passed: () => boolean },
  ) {
    if (shot.clipKind !== "generated") {
      throw unprocessable(`Clip ${shot.orderIndex + 1} is your own video or photo; it is prepared on the server, never rendered by an AI service.`);
    }
    if (shot.storyboardStatus !== "approved") {
      throw unprocessable(
        `Shot ${shot.orderIndex + 1}'s storyboard still has not been approved yet. Generate and approve a still for it (or drop it) before rendering.`,
      );
    }
    const { providerId, model } = resolveShotRenderTarget(storyline, shot);
    // A shot animated from the company's own photo uses the company's own key only (decision 15).
    const apiKey = await resolveProviderApiKey(companyId, providerId, actorId, { companyKeyOnly: opts.companyKeyOnly || Boolean(shot.sourceUploadId) });
    const provider = (deps.buildProvider ?? buildProvider)(providerId, apiKey, model, deadline.signal);
    // Stopping a job must not ride the deadline's signal: that signal is already aborted by the time a late job
    // needs stopping, so the stop request would be cut off at once and the job would stay running and paid for.
    const buildCancelProvider = () => (deps.buildProvider ?? buildProvider)(providerId, apiKey, model);
    const systemActor = { actorType: "user" as const, actorId };

    // DUR-4317/DUR-4320: an approved storyboard still wins over the ordinary
    // last-frame continuity image -- the operator explicitly approved this
    // still as what this shot should look like, so it takes the startImage
    // slot the continuity frame would otherwise occupy. Falls back to
    // continuity/reference pictures below only when the still could not be
    // read back (see loadApprovedStillDataUri's doc comment).
    const approvedStillImage = await loadApprovedStillDataUri(companyId, shot);
    let carriesFootage = false;
    // An animated photo: the photo is the start picture, so it must pass the footage rules (design 2.5).
    if (approvedStillImage && shot.sourceUploadId) {
      const sent = await footage.assertMaySend(companyId, shot, providerId, sendableDataUriBytes(approvedStillImage), systemActor);
      carriesFootage = carriesFootage || sent.footage;
    }

    let continuityImage: string | undefined;
    const previous = await closestPreviousDoneShot(storyline.id, shot.orderIndex);
    if (!approvedStillImage && previous?.resultObjectKey && previous.resultProvider && previous.resultContentType) {
      const clip = await downloadClipFromStorage(companyId, previous.resultProvider, previous.resultObjectKey);
      if (clip) {
        continuityImage = (await extractLastFrameDataUri(clip)) ?? undefined;
      }
      // The previous clip is the company's own footage: its last frame is only
      // sent when it passes the footage rules; otherwise the shot simply
      // starts without it (continuity is a nicety, never a reason to leak).
      if (continuityImage && previous.sourceUploadId) {
        try {
          const sent = await footage.assertMaySend(companyId, previous, providerId, sendableDataUriBytes(continuityImage), systemActor);
          carriesFootage = carriesFootage || sent.footage;
        } catch (err) {
          logger.info({ err, shotId: shot.id }, "video-storyline-render: continuity frame from own footage not sent");
          continuityImage = undefined;
        }
      }
    }
    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const cast = await castVideoInput(companyId, storyline, shot);
    // The cast's pictures first (faces first), then the shot's and storyline's pictures.
    const referenceImages = [...cast.flat, ...(await checkedReferenceImages(companyId, referenceAssetIds))].slice(0, MAX_REFERENCE_IMAGES);
    // See media-jobs-types.ts's MediaJobInput.referenceImages doc comment: neither provider confirms
    // combining a continuity frame with separate character pictures in one call, so we pick ONE image
    // to actually drive continuity/likeness -- the approved still wins, then the continuity frame.
    const startImage = approvedStillImage ?? continuityImage ?? cast.startFallback ?? referenceImages[0];

    const input: MediaJobInput = {
      kind: "video",
      // Camera notes go with the description (they used to be dropped).
      prompt: shotVideoPrompt(storyline, shot),
      // Sogni: our prompt as written, not rewritten from the pictures (decision 7).
      promptRewrite: false,
      model: model ?? undefined,
      startImage,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      ...(cast.characters.length > 0 ? { characters: cast.characters } : {}),
      // Snapped to a length the model accepts (Fal's Kling models only take
      // 5 or 10 seconds and refuse anything else) -- see
      // videoRenderDurationSeconds; the estimate bills the same length.
      durationSeconds: videoRenderDurationSeconds(providerId, model, shot.durationSeconds),
      // Phase 2: the storyline's picture shape, chosen before rendering.
      ...(storyline.aspect ? { aspectRatio: storyline.aspect } : {}),
      ...(carriesFootage ? { storeIO: false as const } : {}),
    };
    if (providerId === "sogni" && storyline.aspect && storyline.aspect !== "16:9" && !startImage) {
      // Sogni's video tools take no shape setting; with no start picture the prompt carries it.
      input.prompt = `${input.prompt}\nFrame: ${storyline.aspect === "9:16" ? "vertical 9:16" : "square 1:1"}.`;
    }
    const shotNumber = shot.orderIndex + 1;
    let claimedAt: Date | undefined;
    // DUR-4937: claim the shot before the paid call, so a shot already queued or rendering is never started a second
    // time (two ticks, or a re-render racing the chain). A caller that already moved the shot to "queued" under the
    // storyline lock (a re-render, an animated photo) is that claim; every other caller's shot must still be idle.
    if (!opts.alreadyQueued) {
      const claimStamp = nowOf();
      const claimed = await db
        .update(videoShots)
        .set({ status: "queued", updatedAt: claimStamp })
        .where(and(eq(videoShots.id, shot.id), inArray(videoShots.status, ["draft", "failed"])))
        .returning({ id: videoShots.id });
      if (claimed.length === 0) {
        throw new ShotClaimLostError(`Shot ${shotNumber} is already rendering or has finished, so it was not started again.`);
      }
      claimedAt = claimStamp;
    }
    // DUR-4944: out of time before anything was sent, so no paid call is made. This runs after the claim on purpose:
    // the shot is already ours (queued), and this error sends it to the caller's recordShotStartFailure, which moves a
    // queued shot to "failed" with this reason -- never left stuck in "queued". Checked before the claim, a deadline
    // passing during the claim write would slip through to provider.start.
    if (deadline.passed()) {
      throw new RenderStartError(
        `Shot ${shotNumber} took too long to get ready, so it was not sent to ${PROVIDER_LABEL[providerId]}. Nothing was charged for it. Try it again.`,
        undefined,
        false,
        claimedAt,
      );
    }
    let handle: MediaJobHandle;
    try {
      handle = await provider.start(input);
    } catch (err) {
      logger.warn({ err, shotId: shot.id, providerId }, "video-storyline-render: the video service did not start a shot");
      // Cut short by the deadline: the request may have reached the service (Fal can queue a job and then lose the
      // answer), so this is not known to be free.
      if (deadline.signal.aborted) {
        throw new RenderStartError(
          `${PROVIDER_LABEL[providerId]} didn't answer in time while shot ${shotNumber} was being sent, so it was stopped. It may have been charged: check ${PROVIDER_LABEL[providerId]}'s dashboard before trying again, so you don't pay twice.`,
          err,
          true,
          claimedAt,
        );
      }
      // The service never confirmed a job, so nothing was charged.
      throw new RenderStartError(describeRenderStartFailure(err, { providerId, shotNumber, charged: false }), err, false, claimedAt);
    }
    // The job exists, but this start outlived its deadline: the shot may already have been swept as stalled and
    // started again, and writing this job down would run (and pay for) the shot twice. Stop it instead.
    if (deadline.passed()) {
      logger.error({ shotId: shot.id, externalId: handle.externalId, providerId }, "video-storyline-render: a shot start finished after its deadline; stopping the late job");
      await buildCancelProvider()
        .cancel(handle)
        .catch((err) => logger.error({ err, shotId: shot.id, externalId: handle.externalId }, "video-storyline-render: could not stop a late shot start"));
      throw new RenderStartError(
        `Shot ${shotNumber} took too long to start on ${PROVIDER_LABEL[providerId]}, so it was stopped. If you see a charge for it, tell your admin. Try it again.`,
        undefined,
        true,
        claimedAt,
      );
    }
    const attempt = shot.attempt + 1;
    try {
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
        // The service and model that really ran are recorded on the job above, never on the shot:
        // video_shots.provider_id/model is only a person's pin, so a later change of the film's model reaches this shot.
        .set({ status: "rendering", attempt, errorMessage: null, updatedAt: nowOf() })
        .where(eq(videoShots.id, shot.id));
    } catch (err) {
      // The job started but could not be written down: stop it rather than leave it unfollowed.
      logger.error({ err, shotId: shot.id, externalId: handle.externalId }, "video-storyline-render: started a shot but could not record it");
      await buildCancelProvider().cancel(handle).catch(() => undefined);
      throw new RenderStartError(describeRenderStartFailure(err, { providerId, shotNumber, charged: true }), err, true, claimedAt);
    }
  }

  /**
   * A shot that could not be started: the shot shows its own reason (status
   * "failed"), and the storyline is put back where it was -- never left on
   * "rendering" with nothing running, which is how a failed start used to
   * look (no message, a spinner forever). Returns the plain reason.
   */
  async function recordShotStartFailure(
    companyId: string,
    storyline: Pick<StorylineRow, "id" | "providerId" | "model">,
    shot: Pick<ShotRow, "id" | "orderIndex" | "providerId" | "model" | "updatedAt">,
    err: unknown,
    restore: { status: string; errorPrefix?: string },
  ): Promise<string> {
    const { providerId } = resolveShotRenderTarget(storyline, shot);
    const reason = err instanceof RenderStartError ? err.message : describeRenderStartFailure(err, { providerId, shotNumber: shot.orderIndex + 1 });
    if (!(err instanceof HttpError)) {
      logger.warn({ err, shotId: shot.id }, "video-storyline-render: a shot could not be started");
    }
    // A start that claimed the shot itself stamped it after the caller read it; that stamp is the start's own too.
    const claimedAt = err instanceof RenderStartError ? err.claimedAt : undefined;
    const ownedAt = claimedAt && claimedAt.getTime() > shot.updatedAt.getTime() ? claimedAt : shot.updatedAt;
    const failed = await db
      .update(videoShots)
      .set({ status: "failed", errorMessage: reason, updatedAt: nowOf() })
      .where(
        and(
          eq(videoShots.id, shot.id),
          // Only a shot that is not running: a start that did get recorded is the tick's to follow.
          inArray(videoShots.status, ["draft", "queued", "failed"]),
          // Only a shot this caller still owns (DUR-4949). A start that fails late, after the shot was swept as
          // stalled and queued again by another re-render, must not mark that other render's shot failed (a third
          // re-render would then be accepted and both would run one shot). Every write to the shot moves updatedAt
          // on from what the caller read; the 1 ms of slack covers a stamp the database kept to the microsecond.
          lte(videoShots.updatedAt, new Date(ownedAt.getTime() + 1)),
        ),
      )
      .returning({ id: videoShots.id });
    // Not this caller's shot any more: the film's state is that other render's to settle, not this late failure's.
    if (failed.length === 0) {
      logger.warn({ shotId: shot.id }, "video-storyline-render: a shot start failed after the shot was taken over; left it alone");
      return reason;
    }
    await db
      .update(videoStorylines)
      .set({ status: restore.status, errorMessage: `${restore.errorPrefix ?? ""}${reason}`, updatedAt: nowOf() })
      .where(and(eq(videoStorylines.id, storyline.id), eq(videoStorylines.status, "rendering")));
    return reason;
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

  /**
   * The approval-threshold gate startRender and a single-shot re-render share: null when `totalCents` is within the
   * company's threshold (or none is set) or a board-approved card already covers exactly that total.
   */
  async function missingRenderApproval(companyId: string, storylineId: string, totalCents: number): Promise<{ thresholdCents: number } | null> {
    const thresholdCents = await settings.getApprovalThresholdCents(companyId);
    if (thresholdCents === null || totalCents <= thresholdCents) return null;
    const approved = await approvals.findApprovedVideoRenderApproval(companyId, storylineId, totalCents);
    return approved ? null : { thresholdCents };
  }

  /** File one open card for the storyline (never a second), then refuse. The stamped fields come from here, never the caller. */
  async function refuseForApproval(
    companyId: string,
    title: string,
    storylineId: string,
    actor: VideoStorylineActor,
    info: { thresholdCents: number; totalCents: number; shotCount: number; summary: string; refusal: string },
  ): Promise<never> {
    const open = await approvals.findOpenVideoRenderApproval(companyId, storylineId);
    if (!open) {
      const payload = videoRenderRequestPayloadSchema.parse({
        kind: "video_render",
        storylineId,
        shotCount: info.shotCount,
        estimatedTotalCents: info.totalCents,
        thresholdCents: info.thresholdCents,
        title: `Render "${title}"`,
        summary: info.summary,
      });
      await approvals.create(companyId, { type: "request_board_approval", requestedByAgentId: actor.agentId, payload, status: "pending" });
    }
    throw unprocessable(info.refusal);
  }

  const RENDER_IN_FLIGHT_MESSAGE = "A shot of this storyline is still rendering. Wait for it to finish before starting the render.";

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
    // Phase 2: only AI shots render (and cost money); the company's own
    // videos and photos are prepared by ffmpeg, free.
    const renderableShots = shots.filter((s) => s.storyboardStatus !== "dropped" && s.clipKind === "generated");

    // DUR-4930 (security review B1): a single-shot re-render leaves the film in draft/paused with its shot queued or
    // rendering. A startRender now would pick that shot (it is not "done") and call the provider a second time for
    // it, with two chains then rendering every shot twice past the cap. Wait for the re-render to settle instead.
    if (shots.some((s) => s.clipKind === "generated" && (s.status === "queued" || s.status === "rendering"))) {
      throw conflict(RENDER_IN_FLIGHT_MESSAGE);
    }

    // Who is in a shot is a person's choice, not a guess from names in the
    // text: a film with a person linked to its cast needs every shot still to
    // render confirmed first. Only here, at start -- never in beginShotRender,
    // so a film that is rendering (the chain continues) finishes normally. A
    // paused film is exempt only when it predates this rule (no marker, see
    // VIDEO_CAST_ENFORCED_KEY): one that was started under the rule and paused
    // since (budget cap, failed shot) may have gained shots or cast, so it is
    // checked like a new start. Checked again under the row lock below.
    if (videoCastCheckRequiredAtStart(storyline.status, storyline.pictureSettings)) {
      assertVideoCastConfirmed(storyline, renderableShots.filter((s) => s.status !== "done"));
    }

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

    // Finished shots are priced at the model that made them, shots still to render at the target a render would use.
    const madeTargets = await loadMadeClipTargets(db, renderableShots.filter((s) => s.status === "done").map((s) => s.id));
    const estimateResult = estimateShotRenderCents(
      storyline,
      renderableShots.map((s) => ({ ...s, madeWith: madeTargets.get(s.id) ?? null })),
    );
    const effectiveBudgetCapCents = input.confirmBudgetCapCents ?? storyline.budgetCapCents;
    const nothingToPayFor = renderableShots.every((s) => s.status === "done");
    if ((effectiveBudgetCapCents === null || effectiveBudgetCapCents === undefined) && !nothingToPayFor) {
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
    if (effectiveBudgetCapCents !== null && effectiveBudgetCapCents !== undefined && storyline.spentCents + remainingEstimate.estimatedTotalCents > effectiveBudgetCapCents) {
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
    const missing = await missingRenderApproval(companyId, storylineId, estimateResult.estimatedTotalCents);
    if (missing) {
      await refuseForApproval(companyId, storyline.title, storylineId, actor, {
        thresholdCents: missing.thresholdCents,
        totalCents: estimateResult.estimatedTotalCents,
        shotCount: estimateResult.shotCount,
        summary: `Rendering this storyline is estimated at ${estimateResult.estimatedTotalCents} cents across ${estimateResult.shotCount} shots, over this company's ${missing.thresholdCents}-cent approval threshold.`,
        refusal: `This render's estimated cost (${estimateResult.estimatedTotalCents} cents) is over this company's ${missing.thresholdCents}-cent approval threshold. Waiting on a board decision before it can start.`,
      });
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
      // Again under the lock: a re-render may have queued a shot since the read above (DUR-4930).
      const [inFlight] = await tx
        .select({ id: videoShots.id })
        .from(videoShots)
        .where(and(eq(videoShots.storylineId, storylineId), eq(videoShots.clipKind, "generated"), inArray(videoShots.status, ["queued", "rendering"])))
        .limit(1);
      if (inFlight) throw conflict(RENDER_IN_FLIGHT_MESSAGE);
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, pending.id), eq(videoShots.storylineId, storylineId)));
      if (!current || current.storyboardStatus !== "approved" || current.status === "done") {
        throw conflict("This storyline's shots changed while the render was starting. Check them and start the render again.");
      }
      // Re-check against the cast as it is under the lock (a cast edit may have
      // committed since the read above), and mark the film as started under the rule.
      const castCheck = videoCastCheckRequiredAtStart(locked.status, locked.pictureSettings);
      if (castCheck) assertVideoCastConfirmed(locked, renderableShots.filter((s) => s.status !== "done"));
      await tx
        .update(videoStorylines)
        .set({
          ...(castCheck ? { pictureSettings: markCastEnforced() } : {}),
          status: "rendering",
          budgetCapCents: effectiveBudgetCapCents,
          estimatedTotalCents: estimateResult.estimatedTotalCents,
          estimatedTotalSeconds: estimateResult.totalSeconds,
          errorMessage: null,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storylineId));
      return { shot: current, previousStatus: locked.status };
    });
    const refreshed = await storylines.getStorylineRow(companyId, storylineId);
    try {
      await beginShotRender(companyId, refreshed, lockedPending.shot, actor.agentId ?? actor.actorId);
    } catch (err) {
      if (err instanceof ShotClaimLostError) {
        // Another caller holds the shot (DUR-4937): leave the shot alone, only undo the film's own move to "rendering".
        await db
          .update(videoStorylines)
          .set({ status: lockedPending.previousStatus, updatedAt: nowOf() })
          .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.status, "rendering")));
        throw err;
      }
      // Compensate: the storyline goes back to where it was (with the reason),
      // the shot shows its own reason, and the person gets the same sentence.
      const reason = await recordShotStartFailure(companyId, refreshed, lockedPending.shot, err, { status: lockedPending.previousStatus, errorPrefix: "The render did not start. " });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "video_storyline.render_start_failed",
        entityType: "video_storyline",
        entityId: storylineId,
        details: { shotOrderIndex: lockedPending.shot.orderIndex, reason: reason.slice(0, 2000) },
      });
      throw err instanceof HttpError ? err : unprocessable(`The render did not start. ${reason}`);
    }

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

  /** Older renders pinned the made-up name 'sogni-video' on the shot; a person never sets that. */
  function hasAutomaticPin(shot: { model: string | null }): boolean {
    return shot.model !== null && realVideoModel(shot.model) === null;
  }

  function withoutAutomaticPin<T extends { providerId: string | null; model: string | null }>(shot: T): T {
    return hasAutomaticPin(shot) ? { ...shot, providerId: null, model: null } : shot;
  }

  /**
   * Money a shot that is `queued` or `rendering` will cost when it settles, which spentCents does not hold yet (it only
   * rises when a shot settles). A single-shot re-render must count it, or a burst of re-renders each sees the same
   * settled spend and walks past the cap and the approval threshold (DUR-4930). An animated photo is already counted
   * in spentCents through its reserved ledger row, so it is left out here rather than counted twice. `exceptShotId` is
   * the shot being re-rendered, never counted against itself.
   */
  async function inFlightShotEstimateCents(
    runner: Db | ScopedTx,
    storyline: Pick<typeof videoStorylines.$inferSelect, "id" | "providerId" | "model">,
    companyId: string,
    exceptShotId: string,
  ): Promise<number> {
    const inFlight = await runner
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storyline.id), inArray(videoShots.status, ["queued", "rendering"]), ne(videoShots.id, exceptShotId)));
    const generated = inFlight.filter((s) => s.clipKind === "generated");
    if (generated.length === 0) return 0;
    const held = await runner
      .select({ shotId: videoMediaSpend.shotId })
      .from(videoMediaSpend)
      .where(and(eq(videoMediaSpend.companyId, companyId), eq(videoMediaSpend.storylineId, storyline.id), eq(videoMediaSpend.status, "reserved")));
    const heldShotIds = new Set(held.map((row) => row.shotId));
    return estimateShotRenderCents(
      storyline,
      generated.filter((s) => !heldShotIds.has(s.id)).map(withoutAutomaticPin),
    ).estimatedTotalCents;
  }

  async function reRenderShot(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor) {
    await settings.assertEnabled(companyId);
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    const shot = await storylines.getShotRow(companyId, storylineId, shotId);
    if (shot.clipKind !== "generated") {
      throw unprocessable("This clip is your own video or photo, so there is nothing to render. Change its trim or motion on the strip instead.");
    }
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
    // Spend-cap gap (DUR-4915): like startRender, a paid render needs a budget cap the person chose -- a missing cap
    // is not "no limit".
    if (storyline.budgetCapCents === null) {
      throw badRequest("Set a budget cap before re-rendering a shot, so spending stops at a limit you chose.");
    }
    // Who is in the shot is a person's choice (see startRender). A re-render only queues this one shot (the film's
    // status is left alone, DUR-4915), so no chain starts here: this shot is the one checked, again under the lock below.
    assertVideoCastConfirmed(storyline, [shot]);
    const refundCents = shot.actualCostCents ?? 0;
    // Shots already queued or rendering have not settled into spentCents yet: count what they will cost (DUR-4930).
    const inFlightCents = await inFlightShotEstimateCents(db, storyline, companyId, shotId);
    const spentAfterRefund = Math.max(0, storyline.spentCents - refundCents) + inFlightCents;
    // Price the shot the way it will actually render: with the legacy automatic pin cleared (see below), so the
    // estimate and the render use the same target.
    const shotEstimate = estimateShotRenderCents(storyline, [withoutAutomaticPin(shot)]);
    if (spentAfterRefund + shotEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      throw unprocessable(
        `Re-rendering this shot (estimated ${shotEstimate.estimatedTotalCents} cents) would push spend to ${spentAfterRefund + shotEstimate.estimatedTotalCents} cents, over the budget cap (${storyline.budgetCapCents} cents). Raise the cap first.`,
      );
    }
    // Spend-cap gap (DUR-4915, security review): a re-render on a film that is not already running is a fresh paid
    // render, so it needs the same board sign-off startRender asks for once the company's approval threshold is
    // crossed. A film that is "rendering" is a run startRender already cleared. Never-made shots have no cost to
    // refund, so one-shot-at-a-time must not walk past the threshold.
    const gateTotal = spentAfterRefund + shotEstimate.estimatedTotalCents;
    const refuseRerender = (thresholdCents: number, totalCents: number) =>
      refuseForApproval(companyId, storyline.title, storylineId, actor, {
        thresholdCents,
        totalCents,
        shotCount: 1,
        summary: `Re-rendering shot ${shot.orderIndex + 1} of this storyline takes its render spend to ${totalCents} cents, over this company's ${thresholdCents}-cent approval threshold.`,
        refusal: `Re-rendering this shot would take this storyline's render spend to ${totalCents} cents, over this company's ${thresholdCents}-cent approval threshold. Waiting on a board decision before it can render.`,
      });
    if (storyline.status !== "rendering") {
      const missing = await missingRenderApproval(companyId, storylineId, gateTotal);
      if (missing) await refuseRerender(missing.thresholdCents, gateTotal);
    }
    // Security review (replace-import TOCTOU): queue the shot under the
    // storyline row lock a "replace" import also takes, re-checking the shot is
    // still there and idle. The storyline's own status is left alone (DUR-4915):
    // flipping it to "rendering" would make the tick carry on through every
    // other shot, past the approval threshold startRender enforces.
    const lockedGate: { hit: { thresholdCents: number; totalCents: number } | null } = { hit: null };
    await withCompanyScope(db, companyId, async (tx) => {
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      if (locked.status === "stitching") {
        throw conflict("A stitch is currently running for this storyline. Wait for it to finish before re-rendering a shot.");
      }
      const [current] = await tx.select().from(videoShots).where(and(eq(videoShots.id, shotId), eq(videoShots.storylineId, storylineId)));
      if (!current) throw conflict("This shot was removed while the re-render was starting.");
      if (current.status === "queued" || current.status === "rendering") throw conflict("This shot is already rendering.");
      // Re-check against the cast as it is under the lock (a cast edit may have committed since the read above).
      assertVideoCastConfirmed(locked, [current]);
      const lockedRefund = current.actualCostCents ?? 0;
      // Re-check the cap against the row as it is under the lock (a pin or cost may have changed since the
      // pre-lock check), priced with the same clear rule the update below applies.
      if (locked.budgetCapCents === null) {
        throw badRequest("Set a budget cap before re-rendering a shot, so spending stops at a limit you chose.");
      }
      const lockedEstimate = estimateShotRenderCents(locked, [withoutAutomaticPin(current)]).estimatedTotalCents;
      const lockedInFlight = await inFlightShotEstimateCents(tx, locked, companyId, shotId);
      const lockedTotal = Math.max(0, locked.spentCents - lockedRefund) + lockedInFlight + lockedEstimate;
      if (lockedTotal > locked.budgetCapCents) {
        throw unprocessable(
          `Re-rendering this shot (estimated ${lockedEstimate} cents) would push spend to ${lockedTotal} cents, over the budget cap (${locked.budgetCapCents} cents). Raise the cap first.`,
        );
      }
      // The same threshold check again on the row as it is under the lock (spend, status or the threshold's card may
      // have changed since the pre-lock check). The card is filed after the lock is released.
      if (locked.status !== "rendering") {
        const missing = await missingRenderApproval(companyId, storylineId, lockedTotal);
        if (missing) {
          lockedGate.hit = { thresholdCents: missing.thresholdCents, totalCents: lockedTotal };
          return;
        }
      }
      await tx
        .update(videoShots)
        .set({
          status: "queued",
          errorMessage: null,
          resultProvider: null,
          resultObjectKey: null,
          resultContentType: null,
          resultByteSize: null,
          resultSha256: null,
          actualCostCents: null,
          // A new clip: the old one's trim no longer applies.
          ...(current.clipKind === "generated" ? { sourceTrimInMs: null, sourceTrimOutMs: null } : {}),
          // Older renders pinned the made-up name 'sogni-video' on the shot. A person never sets that (the pin
          // API drops it), so it is an automatic pin: clear it so this render follows the film's model.
          ...(hasAutomaticPin(current) ? { providerId: null, model: null } : {}),
          updatedAt: nowOf(),
        })
        .where(eq(videoShots.id, shotId));
      await tx
        .update(videoStorylines)
        .set({
          ...(lockedRefund > 0 ? { spentCents: Math.max(0, locked.spentCents - lockedRefund) } : {}),
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storylineId));
    });
    if (lockedGate.hit) await refuseRerender(lockedGate.hit.thresholdCents, lockedGate.hit.totalCents);
    const refreshedShot = await storylines.getShotRow(companyId, storylineId, shotId);
    const finalStoryline = await storylines.getStorylineRow(companyId, storylineId);
    try {
      await beginShotRender(companyId, finalStoryline, refreshedShot, actor.agentId ?? actor.actorId, { alreadyQueued: true });
    } catch (err) {
      // A storyline that is "rendering" (a run already going) is paused rather than left with nothing running, with
      // the shot's own reason; any other status is left as it was.
      const reason = await recordShotStartFailure(companyId, finalStoryline, refreshedShot, err, {
        status: "paused",
        errorPrefix: `Shot ${refreshedShot.orderIndex + 1} did not start again. `,
      });
      throw err instanceof HttpError ? err : unprocessable(`Shot ${refreshedShot.orderIndex + 1} did not start again. ${reason}`);
    }
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

    assertVideoCastConfirmed(storyline, [shot]);

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
    const provider = (deps.buildProvider ?? buildProvider)(providerId, apiKey, model);

    let continuityImage: string | undefined;
    const previous = await closestPreviousDoneShot(storyline.id, shot.orderIndex);
    if (previous?.resultObjectKey && previous.resultProvider && previous.resultContentType) {
      const clip = await downloadClipFromStorage(companyId, previous.resultProvider, previous.resultObjectKey);
      if (clip) continuityImage = (await extractLastFrameDataUri(clip)) ?? undefined;
    }
    const referenceAssetIds = [...shot.lookReferenceAssetIds, ...storyline.characterReferenceAssetIds];
    const cast = await castVideoInput(companyId, storyline, shot);
    const referenceImages = [...cast.flat, ...(await checkedReferenceImages(companyId, referenceAssetIds))].slice(0, MAX_REFERENCE_IMAGES);
    const startImage = continuityImage ?? cast.startFallback ?? referenceImages[0];

    const handle = await provider.start({
      kind: "video",
      prompt: shotVideoPrompt(storyline, shot),
      promptRewrite: false,
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
        await (deps.buildProvider ?? buildProvider)(job.provider as VideoStorylineProvider, apiKey, job.model).cancel(handle);
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
    // A shot left queued/rendering with no job (the process died before its job started) is not covered by
    // the jobs above and would keep "already rendering" on it after the cancel. Same grace period as the
    // stalled-render sweep: a younger shot may be a start that is still in flight (a re-render queues the
    // shot before its job row exists), and failing it here would make it restartable and paid for twice.
    const strandedCutoff = new Date(nowOf().getTime() - STALLED_RENDER_GRACE_MS);
    await db
      .update(videoShots)
      .set({ status: "failed", errorMessage: SHOT_NEVER_STARTED_MESSAGE, updatedAt: nowOf() })
      .where(
        and(
          eq(videoShots.storylineId, storylineId),
          eq(videoShots.clipKind, "generated"),
          inArray(videoShots.status, ["queued", "rendering"]),
          lt(videoShots.updatedAt, strandedCutoff),
          sql`not exists (select 1 from ${videoShotRenderJobs} where ${videoShotRenderJobs.shotId} = ${videoShots.id} and ${videoShotRenderJobs.status} = 'running')`,
        ),
      );

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

  /** Phase 2: money held for this shot's paid step (animate photo), released when it fails. */
  async function releaseShotReservation(companyId: string, storylineId: string, shotId: string): Promise<void> {
    const releasedIds = await withCompanyScope(db, companyId, async (tx) => {
      const held = await tx
        .select()
        .from(videoMediaSpend)
        .where(and(eq(videoMediaSpend.shotId, shotId), eq(videoMediaSpend.companyId, companyId), eq(videoMediaSpend.status, "reserved")))
        .for("update");
      const total = held.reduce((sum, row) => sum + row.reservedCents, 0);
      if (held.length === 0) return [];
      await tx
        .update(videoMediaSpend)
        .set({ status: "released", costCents: 0, updatedAt: nowOf() })
        .where(inArray(videoMediaSpend.id, held.map((r) => r.id)));
      if (total > 0) {
        await tx
          .update(videoStorylines)
          .set({ spentCents: sql`greatest(0, ${videoStorylines.spentCents} - ${total})`, updatedAt: nowOf() })
          .where(eq(videoStorylines.id, storylineId));
      }
      return held.map((row) => row.id);
    });
    // Nothing was charged: the ledger rows stop counting (they are kept, at 0).
    for (const id of releasedIds) await releaseStorylineMediaSpend(db, companyId, storylineAnimateSpendCode(id));
  }

  /** Phase 2: settles this shot's held money at its real cost; returns what was held (already counted in spentCents). */
  async function settleShotReservation(companyId: string, shotId: string, costCents: number): Promise<number> {
    const held = await db
      .select()
      .from(videoMediaSpend)
      .where(and(eq(videoMediaSpend.shotId, shotId), eq(videoMediaSpend.companyId, companyId), eq(videoMediaSpend.status, "reserved")));
    if (held.length === 0) return 0;
    await db
      .update(videoMediaSpend)
      .set({ status: "settled", costCents, updatedAt: nowOf() })
      .where(inArray(videoMediaSpend.id, held.map((r) => r.id)));
    return held.reduce((sum, row) => sum + row.reservedCents, 0);
  }

  async function onShotFailed(companyId: string, storylineId: string, shotId: string, jobId: string, errorMessage: string) {
    await releaseShotReservation(companyId, storylineId, shotId);
    await db.update(videoShotRenderJobs).set({ status: "failed", error: errorMessage, completedAt: nowOf(), updatedAt: nowOf() }).where(eq(videoShotRenderJobs.id, jobId));
    await db.update(videoShots).set({ status: "failed", errorMessage, updatedAt: nowOf() }).where(eq(videoShots.id, shotId));
    await db.update(videoStorylines).set({ status: "paused", errorMessage: `A shot failed: ${errorMessage}. Re-render it to continue.`, updatedAt: nowOf() }).where(eq(videoStorylines.id, storylineId));
  }

  async function onShotDone(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
    shot: typeof videoShots.$inferSelect,
    job: { id: string; provider: string; model: string },
    result: { url?: string; dataUrl?: string; contentType: string; meta?: Record<string, unknown> },
    fal: { apiKey: string } | null = null,
  ) {
    const jobId = job.id;
    const { buffer, contentType } = await downloadResultBytes(result);
    const stored = await getStorageService().putFile({
      companyId,
      namespace: `video-storylines/${storyline.id}`,
      originalFilename: `shot-${String(shot.orderIndex).padStart(6, "0")}.mp4`,
      contentType,
      body: buffer,
    });
    // Billing reads the JOB, not the storyline or the shot: a paused storyline can still be edited
    // (assertStorylineEditable), so a person may switch the film's provider while this job runs.
    // The job holds what was really sent and started (and what beginShotRender's budget check priced).
    const target = { providerId: job.provider as VideoStorylineProvider, model: realVideoModel(job.model) };
    const estimateForShot = estimateShotRenderCents({ providerId: job.provider, model: job.model }, [{ providerId: null, model: null, durationSeconds: shot.durationSeconds }]);
    let actualCostCents = estimateForShot.estimatedTotalCents;
    // An animated photo had its money held, with a ledger row the monthly limit
    // counts (DUR-4807): that row is settled to the real cost, never doubled.
    const [heldSpend] = await db
      .select({ id: videoMediaSpend.id })
      .from(videoMediaSpend)
      .where(and(eq(videoMediaSpend.shotId, shot.id), eq(videoMediaSpend.companyId, companyId), eq(videoMediaSpend.status, "reserved")))
      .orderBy(asc(videoMediaSpend.createdAt))
      .limit(1);
    const heldSpendCode = heldSpend ? storylineAnimateSpendCode(heldSpend.id) : undefined;
    // DUR-4455: Fal video is priced per its published unit (usually seconds); Sogni has no Fal price and keeps the static estimate.
    if (target.providerId === "fal" && fal) {
      const recorded = await recordFalCostEvent(db, safeFetch, {
        companyId,
        apiKey: fal.apiKey,
        agentId: storyline.createdByAgentId,
        createdByUserId: storyline.createdByAgentId ? null : storyline.createdByUserId,
        model: job.model,
        usage: { seconds: videoRenderDurationSeconds("fal", target.model, shot.durationSeconds) },
        estimateCents: estimateForShot.estimatedTotalCents,
        billingCode: "video-storyline-shot",
        settleBillingCode: heldSpendCode,
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
        const settled = heldSpendCode
          ? await settleSogniStorylineSpend(db, {
              companyId,
              billingCode: heldSpendCode,
              credits: sogniCredits,
              creditPriceUsd: cfg[SOGNI_CREDIT_PRICE_CONFIG_KEY],
              model: target.model ?? SOGNI_DEFAULT_VIDEO_MODEL,
            }).catch((err) => {
              logger.error({ err, shotId: shot.id }, "video-storyline-render: could not settle the held Sogni cost");
              return true;
            })
          : false;
        if (!settled) await recordSogniCost(db, {
          companyId,
          agentId: storyline.createdByAgentId ?? null,
          credits: sogniCredits,
          creditPriceUsd: cfg[SOGNI_CREDIT_PRICE_CONFIG_KEY],
          model: target.model ?? SOGNI_DEFAULT_VIDEO_MODEL,
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

    // An animated photo had its estimate held (and counted) when it started: count only the difference now.
    const alreadyHeld = await settleShotReservation(companyId, shot.id, actualCostCents);
    const spentCents = Math.max(0, storyline.spentCents + actualCostCents - alreadyHeld);
    // Phase 2: a single clip made outside a render run (an animated photo in
    // a finished or not-yet-started film) never starts paid renders of other
    // shots by itself: only a running render continues down the chain.
    if (storyline.status !== "rendering") {
      await db.update(videoStorylines).set({ spentCents, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));
      return;
    }
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
    // Fail closed (DUR-4915): a missing cap stops the chain, the same as a cap that is used up. The approval
    // threshold needs no check here: only startRender puts a storyline into "rendering", and it enforces it.
    // Shots still queued or rendering (a re-render during the run) have not settled into spentCents yet (DUR-4937).
    const nextEstimate = estimateShotRenderCents(storyline, [next]);
    const inFlightCents = await inFlightShotEstimateCents(db, storyline, companyId, next.id);
    if (storyline.budgetCapCents === null || spentCents + inFlightCents + nextEstimate.estimatedTotalCents > storyline.budgetCapCents) {
      await db
        .update(videoStorylines)
        .set({
          spentCents,
          status: "paused",
          errorMessage:
            storyline.budgetCapCents === null
              ? `No budget cap is set, so the render stopped before shot ${next.orderIndex + 1}. Set a cap and start the render again to continue.`
              : `Budget cap reached before shot ${next.orderIndex + 1}. Raise the cap and start the render again to continue.`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return;
    }
    await db.update(videoStorylines).set({ spentCents, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));
    const refreshedStoryline = await storylines.getStorylineRow(companyId, storyline.id);
    try {
      await beginShotRender(companyId, refreshedStoryline, next, storyline.createdByAgentId ?? storyline.createdByUserId ?? "system");
    } catch (err) {
      // Another caller already holds this shot (DUR-4937): its run continues the chain, so there is nothing to record.
      if (err instanceof ShotClaimLostError) return;
      // The next shot could not start: pause with its reason instead of
      // leaving the storyline "rendering" with nothing running.
      await recordShotStartFailure(companyId, refreshedStoryline, next, err, {
        status: "paused",
        errorPrefix: `Shot ${next.orderIndex + 1} could not start, so the render paused. `,
      });
    }
  }

  /**
   * The scheduler tick: advance every in-flight render job one step, a
   * bounded batch at a time (VIDEO_RENDER_TICK_BATCH), across every company
   * -- called from index.ts's heartbeat scheduler inside
   * runInCompanyScopeBypass, the same pattern mailSecretary.tick and
   * paymentCards.runDailyExpiryTick use. One job failing to advance is
   * logged and skipped; it never stops the batch.
   */
  /**
   * A storyline left on "rendering" with nothing actually running -- a start
   * that crashed between flipping the status and the video service call (a
   * restart, a bug like the 204 upload crash) -- is put on "paused" with a
   * plain reason after a grace period, so it never shows a render that will
   * never finish. Shots stuck "queued"/"rendering" without a job get their
   * own reason. Runs on the render tick.
   */
  async function releaseStalledRenders(): Promise<number> {
    const cutoff = new Date(nowOf().getTime() - STALLED_RENDER_GRACE_MS);
    const stalled = await db
      .select({ id: videoStorylines.id })
      .from(videoStorylines)
      .where(
        and(
          eq(videoStorylines.status, "rendering"),
          lt(videoStorylines.updatedAt, cutoff),
          sql`not exists (select 1 from ${videoShotRenderJobs} where ${videoShotRenderJobs.storylineId} = ${videoStorylines.id} and ${videoShotRenderJobs.status} = 'running')`,
        ),
      )
      .limit(VIDEO_RENDER_TICK_BATCH);
    for (const row of stalled) {
      await db
        .update(videoShots)
        .set({ status: "failed", errorMessage: SHOT_NEVER_STARTED_MESSAGE, updatedAt: nowOf() })
        .where(and(eq(videoShots.storylineId, row.id), eq(videoShots.clipKind, "generated"), inArray(videoShots.status, ["queued", "rendering"])));
      await db
        .update(videoStorylines)
        .set({
          status: "paused",
          errorMessage: "The render stopped without finishing: nothing is being made right now. Finished clips are kept. Start the render again to continue.",
          updatedAt: nowOf(),
        })
        .where(and(eq(videoStorylines.id, row.id), eq(videoStorylines.status, "rendering")));
    }
    // A shot queued/rendering with no running job, on a film in ANY status (a draft or paused film whose
    // process died between queuing the shot and starting its job), would block a new render for good: it
    // reads "already rendering" with nothing behind it. Only shots untouched for the grace period, and
    // never one with a running job.
    const strandedShots = await db
      .update(videoShots)
      .set({ status: "failed", errorMessage: SHOT_NEVER_STARTED_MESSAGE, updatedAt: nowOf() })
      .where(
        and(
          eq(videoShots.clipKind, "generated"),
          inArray(videoShots.status, ["queued", "rendering"]),
          lt(videoShots.updatedAt, cutoff),
          sql`not exists (select 1 from ${videoShotRenderJobs} where ${videoShotRenderJobs.shotId} = ${videoShots.id} and ${videoShotRenderJobs.status} = 'running')`,
        ),
      )
      .returning({ id: videoShots.id });
    if (strandedShots.length > 0) {
      logger.warn({ released: strandedShots.length }, "video-storyline-render: reset shots that were left queued/rendering with no job running");
    }
    return stalled.length;
  }

  async function tick(): Promise<{ advanced: number; failed: number }> {
    try {
      const released = await releaseStalledRenders();
      if (released > 0) logger.warn({ released }, "video-storyline-render: paused storylines that were left rendering with nothing running");
    } catch (err) {
      logger.error({ err }, "video-storyline-render: could not check for stalled renders");
    }
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
            await (deps.buildProvider ?? buildProvider)(job.provider as VideoStorylineProvider, apiKey, job.model).cancel(handle);
          } catch {
            // Best effort -- the job is being marked failed regardless.
          }
          await onShotFailed(job.companyId, job.storylineId, job.shotId, job.id, `Gave up after ${Math.round(VIDEO_RENDER_JOB_MAX_AGE_MS / 60_000)} minutes without a result.`);
          failed += 1;
          continue;
        }

        const apiKey = await resolveProviderApiKey(job.companyId, job.provider as VideoStorylineProvider, storyline.createdByAgentId ?? "system");
        const provider = (deps.buildProvider ?? buildProvider)(job.provider as VideoStorylineProvider, apiKey, job.model);
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
        await onShotDone(job.companyId, storyline, shot, job, outcome.result, { apiKey });
        advanced += 1;
      } catch (err) {
        logger.error({ err, jobId: job.id }, "video-storyline-render: tick could not advance a render job");
      }
    }
    return { advanced, failed };
  }

  return {
    estimate,
    startRender,
    releaseStalledRenders,
    reRenderShot,
    renderPreview,
    cancelRender,
    tick,
    // Storyline strip (AI transitions) reuses these.
    beginShotRender,
    releaseShotReservation,
    resolveProviderApiKey,
    castVideoInput,
    assertVideoCastConfirmed,
    downloadResultBytes,
    downloadClipFromStorage,
  };
}
