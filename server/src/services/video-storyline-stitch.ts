import { buffer as streamToBuffer } from "node:stream/consumers";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoShots, videoStorylines } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { checkFfmpegAvailable, stitchClips } from "./video-ffmpeg.js";

/**
 * DUR-4127: the stitching worker. Picks up storylines sitting in
 * "ready_to_stitch" (every shot done -- see video-storyline-render.ts's
 * onShotDone), downloads each shot's clip from storage in order, and hands
 * them to ffmpeg's concat demuxer (video-ffmpeg.ts#stitchClips). Ground
 * rule: never install ffmpeg, never block a storyline on its absence -- a
 * host without it just parks the storyline with stitchBlockedReason set and
 * the tick moves on, no differently from any other "waiting on ops" state
 * this codebase already has.
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

  async function stitchOne(storyline: typeof videoStorylines.$inferSelect): Promise<"stitched" | "blocked" | "failed"> {
    if (!(await checkFfmpegAvailable())) {
      await db
        .update(videoStorylines)
        .set({ stitchBlockedReason: "ffmpeg is not available on this host.", updatedAt: nowOf() })
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

    await db.update(videoStorylines).set({ status: "stitching", stitchBlockedReason: null, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));

    try {
      const clipBuffers: Buffer[] = [];
      for (const shot of shots) {
        clipBuffers.push(await downloadClip(storyline.companyId, shot.resultObjectKey!));
      }
      const stitched = await stitchClips(clipBuffers);
      const durationSeconds = shots.reduce((sum, s) => sum + s.durationSeconds, 0);
      const stored = await getStorageService().putFile({
        companyId: storyline.companyId,
        namespace: `video-storylines/${storyline.id}`,
        originalFilename: `${storyline.title || "storyline"}.mp4`,
        contentType: stitched.contentType,
        body: stitched.buffer,
      });
      await db
        .update(videoStorylines)
        .set({
          status: "done",
          finalProvider: stored.provider,
          finalObjectKey: stored.objectKey,
          finalContentType: stored.contentType,
          finalByteSize: stored.byteSize,
          finalSha256: stored.sha256,
          finalDurationSeconds: durationSeconds,
          errorMessage: null,
          stitchBlockedReason: null,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      await logActivity(db, {
        companyId: storyline.companyId,
        actorType: "agent",
        actorId: storyline.createdByAgentId ?? storyline.createdByUserId ?? "system",
        agentId: storyline.createdByAgentId,
        action: "video_storyline.stitched",
        entityType: "video_storyline",
        entityId: storyline.id,
        details: { shotCount: shots.length, durationSeconds, byteSize: stored.byteSize },
      });
      return "stitched";
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
  async function tick(): Promise<{ stitched: number; blocked: number; failed: number }> {
    const pending = await db
      .select()
      .from(videoStorylines)
      .where(eq(videoStorylines.status, "ready_to_stitch"))
      .orderBy(asc(videoStorylines.updatedAt))
      .limit(STITCH_TICK_BATCH);

    let stitched = 0;
    let blocked = 0;
    let failed = 0;
    for (const storyline of pending) {
      try {
        const outcome = await stitchOne(storyline);
        if (outcome === "stitched") stitched += 1;
        else if (outcome === "blocked") blocked += 1;
        else failed += 1;
      } catch (err) {
        logger.error({ err, storylineId: storyline.id }, "video-storyline-stitch: tick could not stitch a storyline");
        failed += 1;
      }
    }
    return { stitched, blocked, failed };
  }

  return { tick, stitchOne };
}
