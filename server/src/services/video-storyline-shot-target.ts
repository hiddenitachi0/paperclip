import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoShotRenderJobs, videoShots, videoStorylines } from "@paperclipai/db";
import {
  VIDEO_CLIP_MIN_MS,
  estimateVideoStorylineCostCents,
  videoRenderDurationSeconds,
  type VideoStorylineProvider,
} from "@paperclipai/shared";

/**
 * Which video service and model a shot uses, in one place -- every estimate,
 * budget gate, render call and clip-length read goes through here, so they
 * cannot disagree.
 *
 * Two different questions:
 *  - A NEW render (resolveShotRenderTarget): the film's service and model,
 *    unless a person pinned this one shot to its own ("keep this shot on X").
 *  - A clip that is already MADE (resolveMadeClipTarget): the service and
 *    model that really made it, read from the shot's latest done render job.
 *    A shot made on Kling 1.6 keeps its 10 s length when the film moves to
 *    Sogni. A legacy row with no done job falls back to its old shot pin.
 *
 * video_shots.provider_id / model are only a person's pin. Rendering never
 * writes them; what a render actually used is recorded on
 * video_shot_render_jobs.
 */

type StorylineRow = typeof videoStorylines.$inferSelect;
type ShotRow = typeof videoShots.$inferSelect;

/** The made-up name older renders stored when Sogni was left on its default model. It is not a Sogni model key. */
const LEGACY_PLACEHOLDER_MODEL = "sogni-video";

/** A real model name, or null (= the service's default): blank and the legacy placeholder are not models. */
export function realVideoModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed && trimmed !== LEGACY_PLACEHOLDER_MODEL ? trimmed : null;
}

export interface VideoShotTarget {
  providerId: VideoStorylineProvider;
  model: string | null;
}

/** The service and model a done shot's clip was made with: its latest done render job. */
export interface MadeClipTarget {
  provider: string;
  model: string;
}

/**
 * Security review: the ONE provider/model resolution every render-cost
 * estimate and the actual render call share -- a shot's own pin (set by a
 * person, never by a render) wins over the storyline's. Before, beginShotRender
 * billed with the shot's values while the budget gates estimated with the
 * storyline's, so a shot re-rendered on a pricier model could pass a budget
 * check it should have failed.
 *
 * A pin is a service plus a model. Without a pinned service the shot follows
 * the film completely; with one, its model is its own (the film's model
 * belongs to the film's service, so it is only borrowed when both use the same).
 */
export function resolveShotRenderTarget(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shot: Pick<ShotRow, "providerId" | "model">,
): VideoShotTarget {
  if (!shot.providerId) {
    return { providerId: storyline.providerId as VideoStorylineProvider, model: realVideoModel(storyline.model) };
  }
  return {
    providerId: shot.providerId as VideoStorylineProvider,
    model: realVideoModel(shot.model) ?? (shot.providerId === storyline.providerId ? realVideoModel(storyline.model) : null),
  };
}

/** What a done shot's clip was made with (see the file comment); a shot not done, or without a done job, is read as a new render would be. */
export function resolveMadeClipTarget(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shot: Pick<ShotRow, "status" | "providerId" | "model">,
  made: MadeClipTarget | null | undefined,
): VideoShotTarget {
  if (shot.status === "done" && made) return { providerId: made.provider as VideoStorylineProvider, model: realVideoModel(made.model) };
  return resolveShotRenderTarget(storyline, shot);
}

/** The latest done render job's service and model for each of these shots (shots with no done job are absent). */
export async function loadMadeClipTargets(db: Pick<Db, "select">, shotIds: readonly string[]): Promise<Map<string, MadeClipTarget>> {
  const out = new Map<string, MadeClipTarget>();
  if (shotIds.length === 0) return out;
  const rows = await db
    .select({ shotId: videoShotRenderJobs.shotId, provider: videoShotRenderJobs.provider, model: videoShotRenderJobs.model })
    .from(videoShotRenderJobs)
    .where(and(inArray(videoShotRenderJobs.shotId, [...shotIds]), eq(videoShotRenderJobs.status, "done")))
    .orderBy(desc(videoShotRenderJobs.attempt), desc(videoShotRenderJobs.completedAt));
  for (const row of rows) if (!out.has(row.shotId)) out.set(row.shotId, { provider: row.provider, model: row.model });
  return out;
}

/**
 * Timeline editor: how long a clip plays in the film and how far its trim
 * handles reach (both in ms). An AI shot plays for the length its model
 * really makes (Kling 1.6/2.1 snap 7 s up to 10 s); once made, it can be
 * trimmed within that length (applied when the film is combined). Your own
 * video plays its trimmed part; a photo plays for its set length.
 *
 * `made` is the shot's latest done render job (loadMadeClipTargets): a made
 * clip keeps the length of the model that made it, whatever the film uses now.
 */
export function shotClipTiming(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shot: Pick<ShotRow, "clipKind" | "status" | "resultObjectKey" | "providerId" | "model" | "durationSeconds" | "sourceTrimInMs" | "sourceTrimOutMs">,
  uploadDurationMs: number | null = null,
  made: MadeClipTarget | null | undefined = null,
): { playMs: number; sourceLengthMs: number | null; trimmed: boolean } {
  if (shot.clipKind === "generated") {
    const { providerId, model } = resolveMadeClipTarget(storyline, shot, made);
    const fullMs = videoRenderDurationSeconds(providerId, model, shot.durationSeconds) * 1000;
    if (shot.status !== "done" || !shot.resultObjectKey) return { playMs: fullMs, sourceLengthMs: null, trimmed: false };
    const inMs = Math.min(Math.max(0, shot.sourceTrimInMs ?? 0), fullMs);
    const outMs = Math.min(fullMs, shot.sourceTrimOutMs ?? fullMs);
    const trimmed = inMs > 0 || outMs < fullMs;
    return { playMs: Math.max(VIDEO_CLIP_MIN_MS, outMs - inMs), sourceLengthMs: fullMs, trimmed };
  }
  if (shot.clipKind === "uploaded_video") {
    const inMs = shot.sourceTrimInMs ?? 0;
    const outMs = shot.sourceTrimOutMs ?? uploadDurationMs ?? inMs + shot.durationSeconds * 1000;
    return { playMs: Math.max(VIDEO_CLIP_MIN_MS, outMs - inMs), sourceLengthMs: uploadDurationMs, trimmed: true };
  }
  return { playMs: shot.durationSeconds * 1000, sourceLengthMs: null, trimmed: false };
}

/**
 * Render-cost estimate for a set of shots, each priced with the same target
 * the render uses (shots on different providers/models are summed). A shot
 * carrying `madeWith` (its latest done job) that is done is priced at what
 * made it -- a whole-film figure then keeps finished shots at their real
 * model. Leave `madeWith` off to price a NEW render of the shot.
 */
export function estimateShotRenderCents(
  storyline: Pick<StorylineRow, "providerId" | "model">,
  shots: ReadonlyArray<
    Pick<ShotRow, "providerId" | "model" | "durationSeconds"> & { status?: string; madeWith?: MadeClipTarget | null }
  >,
): { shotCount: number; totalSeconds: number; estimatedTotalCents: number } {
  let totalSeconds = 0;
  let estimatedTotalCents = 0;
  for (const shot of shots) {
    const { providerId, model } = shot.madeWith
      ? resolveMadeClipTarget(storyline, { status: shot.status ?? "done", providerId: shot.providerId, model: shot.model }, shot.madeWith)
      : resolveShotRenderTarget(storyline, shot);
    const one = estimateVideoStorylineCostCents([{ durationSeconds: shot.durationSeconds }], providerId, { model });
    totalSeconds += one.totalSeconds;
    estimatedTotalCents += one.estimatedTotalCents;
  }
  return { shotCount: shots.length, totalSeconds, estimatedTotalCents };
}
