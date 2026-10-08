import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, videoShots, videoStorylines } from "@paperclipai/db";
import type { VideoShotTransition } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { addMusicBed, checkFfmpegAvailable, normalizeClipsForStitch, stitchClips, stitchClipsWithTransitions, type ShotTransitionInput } from "./video-ffmpeg.js";
import { runVideoQualityCheck, type VideoQualityCheckShotPlan } from "./video-quality-check.js";

/**
 * DUR-4127: the stitching worker. Picks up storylines sitting in
 * "ready_to_stitch" (every shot done -- see video-storyline-render.ts's
 * onShotDone), downloads each shot's clip from storage in order, and hands
 * them to ffmpeg's concat demuxer (video-ffmpeg.ts#stitchClips) -- or, when
 * any shot has a non-"cut" transition, the pairwise xfade path
 * (stitchClipsWithTransitions). DUR-4196 adds an optional music bed
 * (addMusicBed) laid under the result. Ground rule: never install ffmpeg,
 * never block a storyline on its absence -- a host without it just parks the
 * storyline with stitchBlockedReason set and the tick moves on, no
 * differently from any other "waiting on ops" state this codebase already
 * has.
 *
 * DUR-4318: before a stitched file is presented as "done", it is run
 * through video-quality-check.ts's automatic check (duration/streams via
 * ffprobe, sampled black/frozen stretches, audio silence/clipping). A
 * failed check lands the storyline on "needs_attention" instead, with
 * qualityCheckIssues/errorMessage explaining what to look at and where --
 * the file itself is still stored so it can be inspected.
 */

const STITCH_TICK_BATCH = 5;

export interface VideoStorylineStitchDeps {
  now?: () => Date;
}

export function videoStorylineStitchService(db: Db, deps: VideoStorylineStitchDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();

  async function downloadClip(companyId: string, objectKey: string): Promise<Buffer> {
    const storage = getStorageService();
    const object = await storage.getObject(companyId, objectKey);
    return streamToBuffer(object.stream);
  }

  /**
   * DUR-4196: the optional music bed. Only an uploaded asset (musicAssetId)
   * is resolvable today -- musicSourceKey (a licensed/stock track id) has no
   * resolver yet (no licensed-source picker exists), so a storyline left
   * with one set is treated the same as "ffmpeg unavailable": parked with
   * stitchBlockedReason, never silently stitched without the music the user
   * asked for.
   */
  async function loadMusicBed(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
  ): Promise<{ buffer: Buffer; volumeDb: number } | "unsupported" | null> {
    if (storyline.musicSourceKey) return "unsupported";
    if (!storyline.musicAssetId) return null;
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, storyline.musicAssetId), eq(assets.companyId, companyId)));
    if (!asset) return "unsupported";
    const buffer = await downloadClip(companyId, asset.objectKey);
    return { buffer, volumeDb: storyline.musicVolumeDb };
  }

  async function stitchOne(storyline: typeof videoStorylines.$inferSelect): Promise<"stitched" | "needs_attention" | "blocked" | "failed"> {
    if (!(await checkFfmpegAvailable())) {
      await db
        .update(videoStorylines)
        .set({
          stitchBlockedReason:
            "Combining the clips needs ffmpeg, which is not installed on this server (ffmpeg is not available on this host). The rendered clips are kept and will be combined automatically once an admin installs it.",
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return "blocked";
    }

    const shots = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storyline.id), eq(videoShots.status, "done")))
      .orderBy(asc(videoShots.orderIndex));
    const missingClip = shots.find((s) => !s.resultObjectKey);
    if (shots.length === 0 || missingClip) {
      await db
        .update(videoStorylines)
        .set({ status: "failed", errorMessage: "No rendered clips were found to stitch.", updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storyline.id));
      return "failed";
    }

    const musicBed = await loadMusicBed(storyline.companyId, storyline);
    if (musicBed === "unsupported") {
      await db
        .update(videoStorylines)
        .set({
          status: "ready_to_stitch",
          stitchBlockedReason: "This storyline's music bed could not be resolved (licensed-track music isn't supported yet; use an uploaded music file, or clear the music bed to stitch without one).",
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return "blocked";
    }

    await db.update(videoStorylines).set({ status: "stitching", stitchBlockedReason: null, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));

    try {
      // DUR-4196: every shot's resolved transition-in (falling back to the
      // storyline's default) -- shot 0 always renders "cut" regardless of
      // what's stored, since there is no previous clip to transition from.
      const allCut = shots.every((shot, index) => index === 0 || (shot.transitionIn ?? storyline.defaultTransition) === "cut");
      const rawClips: Buffer[] = [];
      for (const shot of shots) {
        rawClips.push(await downloadClip(storyline.companyId, shot.resultObjectKey!));
      }
      // Same size/frame rate/codecs for every clip first -- see
      // normalizeClipsForStitch -- and the real length of each one.
      const normalized = await normalizeClipsForStitch(rawClips);
      let stitched: Awaited<ReturnType<typeof stitchClips>>;
      if (allCut) {
        stitched = await stitchClips(normalized.buffers);
      } else {
        const shotInputs: ShotTransitionInput[] = shots.map((shot, index) => ({
          buffer: normalized.buffers[index]!,
          transitionIn: (index === 0 ? "cut" : (shot.transitionIn ?? storyline.defaultTransition)) as VideoShotTransition,
          transitionDurationMs: storyline.defaultTransitionDurationMs,
        }));
        stitched = await stitchClipsWithTransitions(shotInputs);
      }
      if (musicBed) {
        stitched = await addMusicBed(stitched, musicBed);
      }
      const durationSeconds = Math.round(normalized.durationsSeconds.reduce((sum, seconds) => sum + seconds, 0));

      // DUR-4318: check the stitched file before it is ever shown as "done".
      // Planned against each clip's REAL length: providers snap or round
      // clip lengths (Kling only makes 5s/10s clips), so the written shot
      // durations are not what the film is made of.
      const shotPlans: VideoQualityCheckShotPlan[] = shots.map((shot, index) => ({
        durationSeconds: normalized.durationsSeconds[index] ?? shot.durationSeconds,
        transitionIn: (index === 0 ? "cut" : (shot.transitionIn ?? storyline.defaultTransition)) as VideoShotTransition,
        transitionDurationMs: storyline.defaultTransitionDurationMs,
      }));
      const qualityCheck = await runVideoQualityCheck(stitched.buffer, { shots: shotPlans, expectAudio: musicBed !== null });

      const stored = await getStorageService().putFile({
        companyId: storyline.companyId,
        namespace: `video-storylines/${storyline.id}`,
        originalFilename: `${storyline.title || "storyline"}.mp4`,
        contentType: stitched.contentType,
        body: stitched.buffer,
      });
      const explanation = qualityCheck.passed
        ? null
        : `Automatic quality check found ${qualityCheck.issues.length} issue(s):\n${qualityCheck.issues.map((i) => `- ${i.message}`).join("\n")}`;
      await db
        .update(videoStorylines)
        .set({
          status: qualityCheck.passed ? "done" : "needs_attention",
          finalProvider: stored.provider,
          finalObjectKey: stored.objectKey,
          finalContentType: stored.contentType,
          finalByteSize: stored.byteSize,
          finalSha256: stored.sha256,
          finalDurationSeconds: durationSeconds,
          errorMessage: explanation,
          stitchBlockedReason: null,
          qualityCheckIssues: qualityCheck.issues,
          qualityCheckedAt: nowOf(),
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      await logActivity(db, {
        companyId: storyline.companyId,
        actorType: "agent",
        actorId: storyline.createdByAgentId ?? storyline.createdByUserId ?? "system",
        agentId: storyline.createdByAgentId,
        action: qualityCheck.passed ? "video_storyline.stitched" : "video_storyline.needs_attention",
        entityType: "video_storyline",
        entityId: storyline.id,
        details: { shotCount: shots.length, durationSeconds, byteSize: stored.byteSize, qualityCheckIssues: qualityCheck.issues },
      });
      return qualityCheck.passed ? "stitched" : "needs_attention";
    } catch (err) {
      logger.error({ err, storylineId: storyline.id }, "video-storyline-stitch: stitch failed");
      await db
        .update(videoStorylines)
        .set({
          status: "ready_to_stitch",
          errorMessage: `Stitching failed: ${err instanceof Error ? err.message : String(err)}`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return "failed";
    }
  }

  /**
   * The scheduler tick: stitch a bounded batch of "ready_to_stitch"
   * storylines per call, oldest-first. Same shape as
   * video-storyline-render.ts's tick -- one storyline failing to stitch is
   * logged and skipped, never stops the batch.
   */
  async function tick(): Promise<{ stitched: number; needsAttention: number; blocked: number; failed: number }> {
    const pending = await db
      .select()
      .from(videoStorylines)
      .where(eq(videoStorylines.status, "ready_to_stitch"))
      .orderBy(asc(videoStorylines.updatedAt))
      .limit(STITCH_TICK_BATCH);

    let stitched = 0;
    let needsAttention = 0;
    let blocked = 0;
    let failed = 0;
    for (const storyline of pending) {
      try {
        const outcome = await stitchOne(storyline);
        if (outcome === "stitched") stitched += 1;
        else if (outcome === "needs_attention") needsAttention += 1;
        else if (outcome === "blocked") blocked += 1;
        else failed += 1;
      } catch (err) {
        logger.error({ err, storylineId: storyline.id }, "video-storyline-stitch: tick could not stitch a storyline");
        failed += 1;
      }
    }
    return { stitched, needsAttention, blocked, failed };
  }

  /**
   * DUR-4318: the operator's recovery path off "needs_attention" -- the shots
   * themselves are already done, only the stitched file failed its quality
   * check, so this re-queues for stitching (and a fresh quality check) rather
   * than re-rendering every shot from scratch via render/start.
   */
  async function retryStitch(companyId: string, storylineId: string): Promise<void> {
    const [storyline] = await db
      .select()
      .from(videoStorylines)
      .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    if (!storyline) throw notFound("Video storyline not found");
    if (storyline.status !== "needs_attention") {
      throw conflict(`This storyline is ${storyline.status.replace(/_/g, " ")}, not needing attention.`);
    }
    await db
      .update(videoStorylines)
      .set({
        status: "ready_to_stitch",
        errorMessage: null,
        qualityCheckIssues: [],
        qualityCheckedAt: null,
        updatedAt: nowOf(),
      })
      .where(eq(videoStorylines.id, storylineId));
  }

  return { tick, stitchOne, retryStitch };
}
