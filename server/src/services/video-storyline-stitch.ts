import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, videoShots, videoStorylines } from "@paperclipai/db";
import { hasBlockingVideoQualityIssue, readVideoExportSettings, videoExportPreset, videoQualityIssueSeverity, type VideoStorylineQualityIssue } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { companyVideoFileMaxBytes, instanceVideoFileMaxMb, mediaWorkDir } from "./media-video-limits.js";
import type { VideoStorylineActor } from "./video-storylines.js";
import {
  addMusicBedToFile,
  checkFfmpegAvailable,
  normalizeClipFilesForStitch,
  normalizeLoudnessFile,
  renderTitleCard,
  stitchClipFiles,
  stitchClipFilesWithTransitions,
  type MusicBedFileInput,
  type NormalizeClipOptions,
  type ShotTransitionFileInput,
} from "./video-ffmpeg.js";
import { runMediaJob } from "./media-job-queue.js";
import { buildStitchPlan } from "./video-storyline-transitions.js";
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
 *
 * Storyline export fix (Oct 2026): most findings are warnings, not
 * blockers. A film whose check found only warnings (a loud peak, a quiet
 * stretch) lands on "done" with the warnings attached, so it can be
 * downloaded and shown with them; only a blocking finding (no picture, the
 * wrong length) lands on "needs_attention". Every film with sound is also
 * evened out (loudnorm to about -14 LUFS with a peak limiter, see
 * video-ffmpeg.ts#normalizeLoudness), so a normal export never trips the
 * clipping check in the first place. A stitch that fails twice in a row
 * stops on "needs_attention" with a plain explanation instead of being
 * retried on every tick forever.
 */

/** Marks a failed attempt in errorMessage, so the next failure in a row stops instead of looping. */
const STITCH_FAILED_PREFIX = "Putting the film together did not work";

/** Plain words for a failed stitch: ffmpeg's own error repeats the whole command line, which helps nobody on the film page. */
export function friendlyStitchError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
  if (/^Command failed/i.test(text)) return "the video tool stopped with an error";
  if (/timed? ?out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(text)) return "it took too long and was stopped";
  if (/ENOSPC|no space/i.test(text)) return "the server ran out of disk space";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** The storyline's message for a check result: blocking findings only (warnings are shown from qualityCheckIssues next to Download). */
function qualityExplanation(issues: readonly VideoStorylineQualityIssue[]): string | null {
  const blocking = issues.filter((i) => videoQualityIssueSeverity(i) === "blocking");
  if (blocking.length === 0) return null;
  return `The automatic check found ${blocking.length === 1 ? "a problem" : `${blocking.length} problems`} that stop this film from being finished:\n${blocking.map((i) => `- ${i.message}`).join("\n")}`;
}

const STITCH_TICK_BATCH = 5;

/** The music lane to lay under the film: its settings now, its stored file fetched into the work folder when the film is made. */
type MusicBedPlan = Omit<MusicBedFileInput, "path"> & { objectKey: string };

/** Drops work files that are no longer needed, so a long film needs about twice its size on disk, not five times. */
async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** D18: plain words for a finished film over the company's per-file video limit. */
export function filmTooLargeMessage(filmBytes: number, maxBytes: number): string {
  return (
    `The finished film is ${megabytes(filmBytes)}, more than this company keeps for one video file (${megabytes(maxBytes)}), so it was not saved. ` +
    `An owner or admin can raise "Largest film or saved video" in Media Studio's settings (this server allows up to ${instanceVideoFileMaxMb()} MB), ` +
    `or the film can be made shorter or with Standard quality. Then press "Combine again".`
  );
}

export interface VideoStorylineStitchDeps {
  now?: () => Date;
}

export function videoStorylineStitchService(db: Db, deps: VideoStorylineStitchDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();

  /** D18: a stored clip (or music file) streamed straight to a work file, never read into memory. */
  async function downloadTo(companyId: string, objectKey: string, filePath: string): Promise<void> {
    const object = await getStorageService().getObject(companyId, objectKey);
    await pipeline(object.stream, createWriteStream(filePath));
  }

  /**
   * DUR-4196: the optional music bed. Only an uploaded asset (musicAssetId)
   * is resolvable today -- musicSourceKey (a licensed/stock track id) has no
   * resolver yet (no licensed-source picker exists), so a storyline left
   * with one set is treated the same as "ffmpeg unavailable": parked with
   * stitchBlockedReason, never silently stitched without the music the user
   * asked for. The file itself is fetched into the film's work folder when
   * the film is made.
   */
  async function loadMusicBed(
    companyId: string,
    storyline: typeof videoStorylines.$inferSelect,
  ): Promise<MusicBedPlan | "unsupported" | null> {
    if (storyline.musicSourceKey) return "unsupported";
    if (!storyline.musicAssetId) return null;
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, storyline.musicAssetId), eq(assets.companyId, companyId)));
    if (!asset) return "unsupported";
    // Phase 2 music lane: trim, start offset, fades and mix/replace.
    return {
      objectKey: asset.objectKey,
      volumeDb: storyline.musicVolumeDb,
      trimInMs: storyline.musicTrimInMs,
      trimOutMs: storyline.musicTrimOutMs,
      offsetMs: storyline.musicOffsetMs,
      fadeInMs: storyline.musicFadeInMs,
      fadeOutMs: storyline.musicFadeOutMs,
      mode: storyline.musicAudioMode === "replace" ? "replace" : "mix",
    };
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

    // Phase 2: your own videos and photos are prepared by ffmpeg first; wait for them.
    const [preparing] = await db
      .select({ id: videoShots.id, orderIndex: videoShots.orderIndex, status: videoShots.status })
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storyline.id), ne(videoShots.status, "done"), ne(videoShots.storyboardStatus, "dropped"), ne(videoShots.clipKind, "generated")))
      .limit(1);
    if (preparing) {
      await db
        .update(videoStorylines)
        .set({
          status: "ready_to_stitch",
          stitchBlockedReason:
            preparing.status === "failed"
              ? `Clip ${preparing.orderIndex + 1} could not be prepared. Change its trim (or remove it) on the strip, then combine again.`
              : `Getting clip ${preparing.orderIndex + 1} ready (your own video or photo). The film is combined as soon as it is.`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return "blocked";
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

    // Storyline strip: each gap's transition (cut, blend, or an inserted AI
    // bridge). An AI bridge that is missing or out of date stops the film
    // here, in plain words, until it is made again or switched to cut/blend.
    const plan = await buildStitchPlan(db, storyline, shots);
    if (plan.problems.length > 0) {
      await db
        .update(videoStorylines)
        .set({ status: "ready_to_stitch", stitchBlockedReason: plan.problems.join(" "), updatedAt: nowOf() })
        .where(eq(videoStorylines.id, storyline.id));
      return "blocked";
    }

    await db.update(videoStorylines).set({ status: "stitching", stitchBlockedReason: null, updatedAt: nowOf() }).where(eq(videoStorylines.id, storyline.id));

    // D18: the whole film is made on disk, in one work folder per stitch
    // (clips streamed in from storage, ffmpeg file to file, the finished film
    // streamed back into storage), so a long film is never held in memory.
    let workDir: string | null = null;
    try {
      workDir = await mkdtemp(join(await mediaWorkDir(), "paperclip-film-"));
      const dir = workDir;
      // At most a few heavy ffmpeg jobs at once on the shared box (media-job-queue.ts).
      const built = await runMediaJob(`stitch ${storyline.id}`, async () => {
        // The first item always joins with "cut" -- there is nothing before it.
        // Phase 2 (design 2.7): the export's size, frame rate, fill/fit and quality.
        const exportSettings = readVideoExportSettings(storyline.exportSettings, storyline.aspect);
        const preset = videoExportPreset(exportSettings.preset);
        const target = { width: preset.width, height: preset.height, fps: exportSettings.fps, fit: exportSettings.fit, quality: exportSettings.quality };
        type BuiltItem = {
          objectKey: string | null;
          buffer?: Buffer;
          transitionIn: ShotTransitionFileInput["transitionIn"];
          transitionDurationMs: number;
          normalize?: NormalizeClipOptions;
          writtenSeconds: number;
          allowStill?: boolean;
          allowSilence?: boolean;
        };
        const shotById = new Map(shots.map((s) => [s.id, s]));
        const items: BuiltItem[] = plan.items.map((item) => {
          const shot = item.shotId ? shotById.get(item.shotId) : undefined;
          return {
            ...item,
            // A held photo is meant to be still; your own clips and muted clips may be quiet.
            allowStill: shot?.clipKind === "still",
            allowSilence: Boolean(shot && (shot.clipKind !== "generated" || shot.clipMuted)),
          };
        });
        // Title card and credits: drawn by ffmpeg from a text file, joined by cuts.
        if (exportSettings.opening) {
          const buffer = await renderTitleCard(exportSettings.opening.text, { seconds: exportSettings.opening.seconds, kind: "opening", target });
          items.unshift({ objectKey: null, buffer, transitionIn: "cut", transitionDurationMs: 0, writtenSeconds: exportSettings.opening.seconds, allowStill: true, allowSilence: true });
          if (items[1]) items[1] = { ...items[1], transitionIn: "cut" };
        }
        if (exportSettings.credits) {
          const buffer = await renderTitleCard(exportSettings.credits.text, { seconds: exportSettings.credits.seconds, kind: "credits", target });
          items.push({ objectKey: null, buffer, transitionIn: "cut", transitionDurationMs: 0, writtenSeconds: exportSettings.credits.seconds, allowStill: true, allowSilence: true });
        }
        const allCut = items.every((item, index) => index === 0 || item.transitionIn === "cut");
        const rawPaths: string[] = [];
        for (const [index, item] of items.entries()) {
          const rawPath = join(dir, `raw-${String(index).padStart(6, "0")}.mp4`);
          if (item.buffer) await writeFile(rawPath, item.buffer);
          else await downloadTo(storyline.companyId, item.objectKey!, rawPath);
          rawPaths.push(rawPath);
        }
        // Same size/frame rate/codecs for every clip first -- see
        // normalizeClipsForStitch -- and the real length of each one.
        const normalized = await normalizeClipFilesForStitch(rawPaths, items.map((item) => item.normalize), target, dir);
        await removeFiles(rawPaths);
        let filmPath: string;
        if (allCut) {
          filmPath = join(dir, "film.mp4");
          await stitchClipFiles(normalized.paths, filmPath, dir);
        } else {
          const inputs: ShotTransitionFileInput[] = items.map((item, index) => ({
            path: normalized.paths[index]!,
            transitionIn: index === 0 ? "cut" : item.transitionIn,
            transitionDurationMs: item.transitionDurationMs,
          }));
          filmPath = await stitchClipFilesWithTransitions(inputs, dir);
        }
        await removeFiles(normalized.paths.filter((path) => path !== filmPath));
        if (musicBed) {
          const musicPath = join(dir, "music.audio");
          await downloadTo(storyline.companyId, musicBed.objectKey, musicPath);
          const withMusic = join(dir, "film-music.mp4");
          await addMusicBedToFile(filmPath, { ...musicBed, path: musicPath }, withMusic, dir);
          await removeFiles([filmPath, musicPath]);
          filmPath = withMusic;
        }
        // An even, never-clipping sound track. If this step fails the film
        // is kept as it is (the check may then warn about loud peaks)
        // rather than losing the whole export over the sound.
        try {
          const evened = join(dir, "film-even.mp4");
          if ((await normalizeLoudnessFile(filmPath, evened, dir)) !== "no-audio") {
            await removeFiles([filmPath]);
            filmPath = evened;
          }
        } catch (err) {
          logger.warn({ err, storylineId: storyline.id }, "video-storyline-stitch: evening out the sound failed; keeping the film as stitched");
        }
        return { filmPath, durationsSeconds: normalized.durationsSeconds, items };
      });
      const { filmPath, durationsSeconds: clipSeconds, items: builtItems } = built;
      const durationSeconds = Math.round(clipSeconds.reduce((sum, seconds) => sum + seconds, 0));

      // D18: one finished film may be up to this company's video file limit
      // (2 GB by default). A longer one is not stored; the person is told
      // what to change, and "Combine again" works once the limit is raised.
      const filmBytes = (await stat(filmPath)).size;
      const maxBytes = await companyVideoFileMaxBytes(db, storyline.companyId);
      if (filmBytes > maxBytes) {
        const message = filmTooLargeMessage(filmBytes, maxBytes);
        await db
          .update(videoStorylines)
          .set({
            status: "needs_attention",
            errorMessage: message,
            stitchBlockedReason: null,
            qualityCheckIssues: [{ code: "stitch_failed", message, shotIndex: null, timeSeconds: null, severity: "blocking" }],
            qualityCheckedAt: nowOf(),
            updatedAt: nowOf(),
          })
          .where(eq(videoStorylines.id, storyline.id));
        await logActivity(db, {
          companyId: storyline.companyId,
          actorType: "agent",
          actorId: storyline.createdByAgentId ?? storyline.createdByUserId ?? "system",
          agentId: storyline.createdByAgentId,
          action: "video_storyline.needs_attention",
          entityType: "video_storyline",
          entityId: storyline.id,
          details: { reason: "film_too_large", byteSize: filmBytes, maxBytes, durationSeconds },
        });
        return "needs_attention";
      }

      // DUR-4318: check the stitched file before it is ever shown as "done".
      // Planned against each clip's REAL length: providers snap or round
      // clip lengths (Kling only makes 5s/10s clips), so the written shot
      // durations are not what the film is made of.
      const shotPlans: VideoQualityCheckShotPlan[] = builtItems.map((item, index) => ({
        durationSeconds: clipSeconds[index] ?? item.writtenSeconds,
        transitionIn: index === 0 ? "cut" : item.transitionIn,
        transitionDurationMs: item.transitionDurationMs,
        allowStill: item.allowStill,
        allowSilence: item.allowSilence,
      }));
      const qualityCheck = await runVideoQualityCheck(filmPath, { shots: shotPlans, expectAudio: musicBed !== null });

      const stored = await getStorageService().putFileFromPath({
        companyId: storyline.companyId,
        namespace: `video-storylines/${storyline.id}`,
        originalFilename: `${storyline.title || "storyline"}.mp4`,
        contentType: "video/mp4",
        filePath: filmPath,
        maxBytes,
      });
      // Warnings never block: only a truly broken film waits on "needs_attention".
      const blocked = qualityCheck.blocking;
      await db
        .update(videoStorylines)
        .set({
          status: blocked ? "needs_attention" : "done",
          finalProvider: stored.provider,
          finalObjectKey: stored.objectKey,
          finalContentType: stored.contentType,
          finalByteSize: stored.byteSize,
          finalSha256: stored.sha256,
          finalDurationSeconds: durationSeconds,
          errorMessage: qualityExplanation(qualityCheck.issues),
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
        action: blocked ? "video_storyline.needs_attention" : "video_storyline.stitched",
        entityType: "video_storyline",
        entityId: storyline.id,
        details: {
          shotCount: shots.length,
          durationSeconds,
          byteSize: stored.byteSize,
          qualityCheckIssues: qualityCheck.issues,
          warningCount: qualityCheck.issues.filter((i) => i.severity !== "blocking").length,
        },
      });
      return blocked ? "needs_attention" : "stitched";
    } catch (err) {
      logger.error({ err, storylineId: storyline.id }, "video-storyline-stitch: stitch failed");
      const reason = friendlyStitchError(err);
      // One automatic retry; a second failure in a row stops and says so,
      // instead of re-running a heavy ffmpeg job on every tick forever.
      const failedBefore = (storyline.errorMessage ?? "").startsWith(STITCH_FAILED_PREFIX);
      if (failedBefore) {
        const message = `${STITCH_FAILED_PREFIX} twice in a row (${reason}). Your clips are kept. Press "Combine again" to try once more; if it keeps failing, change or remove the clip you changed last.`;
        await db
          .update(videoStorylines)
          .set({
            status: "needs_attention",
            errorMessage: message,
            qualityCheckIssues: [{ code: "stitch_failed", message, shotIndex: null, timeSeconds: null, severity: "blocking" }],
            qualityCheckedAt: nowOf(),
            updatedAt: nowOf(),
          })
          .where(eq(videoStorylines.id, storyline.id));
        return "failed";
      }
      await db
        .update(videoStorylines)
        .set({
          status: "ready_to_stitch",
          errorMessage: `${STITCH_FAILED_PREFIX} (${reason}). Trying once more automatically.`,
          updatedAt: nowOf(),
        })
        .where(eq(videoStorylines.id, storyline.id));
      return "failed";
    } finally {
      // The clips, the in-between files and the film itself (now in storage, or not kept) go with the work folder.
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
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
    // Storyline strip: "Combine again" also works on a finished film (new
    // transitions, no re-render), not only after a failed quality check.
    if (storyline.status !== "needs_attention" && storyline.status !== "done") {
      throw conflict(`This storyline is ${storyline.status.replace(/_/g, " ")}, so it cannot be combined again right now.`);
    }
    const shots = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storylineId), eq(videoShots.companyId, companyId), eq(videoShots.status, "done")))
      .orderBy(asc(videoShots.orderIndex));
    const plan = await buildStitchPlan(db, storyline, shots);
    if (plan.problems.length > 0) throw unprocessable(plan.problems.join(" "));
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

  /**
   * "Accept warnings and finish": a film parked on "needs_attention" whose
   * findings are all warnings (from before warnings stopped blocking, or a
   * person who simply wants it as it is) becomes "done" without making it
   * again. A film with a real problem cannot be accepted this way.
   */
  async function acceptWarnings(companyId: string, storylineId: string, actor: VideoStorylineActor): Promise<void> {
    const [storyline] = await db
      .select()
      .from(videoStorylines)
      .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    if (!storyline) throw notFound("Video storyline not found");
    if (storyline.status === "done") return;
    if (storyline.status !== "needs_attention") {
      throw conflict(`This storyline is ${storyline.status.replace(/_/g, " ")}, so there is nothing to accept right now.`);
    }
    if (!storyline.finalObjectKey) throw conflict("There is no finished film to accept yet. Combine the clips again first.");
    if (hasBlockingVideoQualityIssue(storyline.qualityCheckIssues)) {
      throw unprocessable("The automatic check found a real problem with this film, so it cannot be accepted as it is. Combine the clips again.");
    }
    await db
      .update(videoStorylines)
      .set({
        status: "done",
        errorMessage: null,
        // The findings stay, so they are still shown next to Download as warnings.
        updatedAt: nowOf(),
      })
      .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId), eq(videoStorylines.status, "needs_attention")));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.warnings_accepted",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { warningCount: (storyline.qualityCheckIssues ?? []).length },
    });
  }

  return { tick, stitchOne, retryStitch, acceptWarnings };
}
