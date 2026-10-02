import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VideoQualityIssueCode, VideoShotTransition, VideoStorylineQualityIssue } from "@paperclipai/shared";
import { probeDurationSeconds, probeHasAudioStream } from "./video-ffmpeg.js";

const execFileAsync = promisify(execFile);

/**
 * DUR-4318: the post-stitch automatic quality check. Runs after a storyline's
 * shots are stitched into one file (video-storyline-stitch.ts), before it is
 * shown as "done" -- (1) duration/streams match the shot plan (ffprobe), (2)
 * sampled frames for long black or frozen stretches (ffmpeg's blackdetect +
 * freezedetect filters), (3) the audio track for extended silence and
 * clipping (ffmpeg's silencedetect + volumedetect filters). Every check here
 * is written fresh against ffmpeg/ffprobe's own documented filters -- no
 * code, prompts, schemas or word lists were copied from any other project.
 * A failed check never throws: it returns structured issues with a shot
 * number/time where possible, and the caller is responsible for landing the
 * storyline on "needs_attention" (with these issues attached) instead of
 * "done". Ships with the same execFile-only, no-shell discipline as
 * video-ffmpeg.ts.
 */

const FFMPEG_BINARY = process.env.PAPERCLIP_FFMPEG_PATH?.trim() || "ffmpeg";
const SCAN_TIMEOUT_MS = 5 * 60_000;
const SCAN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// "Long" stretches per the ticket -- short cuts to black (e.g. a hard scene
// cut) or a couple of visually-identical frames are normal, not a defect.
const BLACK_MIN_DURATION_SECONDS = 1.0;
const BLACK_PIC_THRESHOLD = 0.98;
const FREEZE_MIN_DURATION_SECONDS = 1.0;
const FREEZE_NOISE_THRESHOLD_DB = "-60dB";
const SILENCE_MIN_DURATION_SECONDS = 1.5;
const SILENCE_NOISE_THRESHOLD_DB = "-50dB";
// True digital clipping pins samples at (or essentially at) full scale --
// volumedetect's max_volume lands at/just under 0 dBFS when that happens.
const CLIPPING_MAX_VOLUME_DB_THRESHOLD = -0.3;

const DURATION_TOLERANCE_SECONDS = 1.5;
const DURATION_TOLERANCE_RATIO = 0.05;

export interface VideoQualityCheckShotPlan {
  durationSeconds: number;
  transitionIn: VideoShotTransition;
  transitionDurationMs: number;
}

export interface VideoQualityCheckPlan {
  shots: readonly VideoQualityCheckShotPlan[];
  /** Whether the final file is expected to carry an audio track (e.g. a music bed was requested) -- absence is only flagged as an issue when true. */
  expectAudio: boolean;
}

export interface VideoQualityCheckResult {
  passed: boolean;
  issues: VideoStorylineQualityIssue[];
}

export interface ShotTimelineEntry {
  shotIndex: number;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Mirrors video-ffmpeg.ts#stitchClipsWithTransitions' own timing: a
 * fade/dissolve boundary overlaps the previous shot's tail with the next
 * shot's head by the transition duration (shortening the combined timeline
 * by that much); "cut" has no overlap. Shot 0 never has an incoming
 * transition, matching stitchOne's own resolution rule.
 */
export function buildShotTimeline(shots: readonly VideoQualityCheckShotPlan[]): ShotTimelineEntry[] {
  const timeline: ShotTimelineEntry[] = [];
  let cursor = 0;
  shots.forEach((shot, index) => {
    const overlapSeconds = index === 0 || shot.transitionIn === "cut" ? 0 : Math.min(shot.transitionDurationMs / 1000, shot.durationSeconds);
    const start = Math.max(0, cursor - overlapSeconds);
    const end = start + shot.durationSeconds;
    timeline.push({ shotIndex: index, startSeconds: start, endSeconds: end });
    cursor = end;
  });
  return timeline;
}

export function expectedTotalDurationSeconds(shots: readonly VideoQualityCheckShotPlan[]): number {
  const timeline = buildShotTimeline(shots);
  return timeline.length === 0 ? 0 : timeline[timeline.length - 1]!.endSeconds;
}

/** Best-effort: which shot a timestamp in the final file most likely belongs to, given the planned timeline. Clamps to the first/last shot rather than returning null for an out-of-range time, since "closest shot" is still more useful to a reviewer than nothing. */
export function shotIndexAtTime(timeline: readonly ShotTimelineEntry[], timeSeconds: number): number | null {
  if (timeline.length === 0) return null;
  for (const entry of timeline) {
    if (timeSeconds >= entry.startSeconds && timeSeconds < entry.endSeconds) return entry.shotIndex;
  }
  const last = timeline[timeline.length - 1]!;
  if (timeSeconds >= last.endSeconds) return last.shotIndex;
  return timeline[0]!.shotIndex;
}

export interface DetectedRange {
  startSeconds: number;
  durationSeconds: number;
}

/** Parses ffmpeg's blackdetect log lines, e.g. `black_start:2.5 black_end:4.1 black_duration:1.6`. */
export function parseBlackDetect(stderrOutput: string): DetectedRange[] {
  const ranges: DetectedRange[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderrOutput))) {
    ranges.push({ startSeconds: Number.parseFloat(match[1]!), durationSeconds: Number.parseFloat(match[3]!) });
  }
  return ranges;
}

/** Parses ffmpeg's freezedetect log lines: `lavfi.freezedetect.freeze_start: 2.5` / `lavfi.freezedetect.freeze_duration: 1.6`, emitted as separate log lines in the same order they occur. */
export function parseFreezeDetect(stderrOutput: string): DetectedRange[] {
  const starts = [...stderrOutput.matchAll(/lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/g)].map((m) => Number.parseFloat(m[1]!));
  const durations = [...stderrOutput.matchAll(/lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/g)].map((m) => Number.parseFloat(m[1]!));
  return starts.map((startSeconds, index) => ({ startSeconds, durationSeconds: durations[index] ?? 0 }));
}

/** Parses ffmpeg's silencedetect log lines: `silence_start: 2.5` / `silence_end: 4.1 | silence_duration: 1.6`. */
export function parseSilenceDetect(stderrOutput: string): DetectedRange[] {
  const starts = [...stderrOutput.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number.parseFloat(m[1]!));
  const durations = [...stderrOutput.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => Number.parseFloat(m[1]!));
  return starts.map((startSeconds, index) => ({ startSeconds: Math.max(0, startSeconds), durationSeconds: durations[index] ?? 0 }));
}

/** Parses ffmpeg's volumedetect summary line: `max_volume: -0.0 dB`. */
export function parseMaxVolumeDb(stderrOutput: string): number | null {
  const match = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderrOutput);
  return match ? Number.parseFloat(match[1]!) : null;
}

async function withTempFile<T>(buffer: Buffer, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-video-quality-check-"));
  try {
    const filePath = join(dir, "final.mp4");
    await writeFile(filePath, buffer);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs an ffmpeg filter pass and returns its stderr log, regardless of whether ffmpeg exits non-zero (it legitimately can for a `-f null -` scan; the detector output we want is in the log either way). */
async function runFilterScan(filePath: string, args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync(FFMPEG_BINARY, args, { timeout: SCAN_TIMEOUT_MS, maxBuffer: SCAN_MAX_BUFFER_BYTES });
    return stderr;
  } catch (err) {
    const withStderr = err as { stderr?: unknown };
    if (typeof withStderr.stderr === "string") return withStderr.stderr;
    throw err;
  }
}

async function scanBlackAndFrozenStretches(filePath: string): Promise<{ black: DetectedRange[]; frozen: DetectedRange[] }> {
  const filter = `blackdetect=d=${BLACK_MIN_DURATION_SECONDS}:pic_th=${BLACK_PIC_THRESHOLD},freezedetect=n=${FREEZE_NOISE_THRESHOLD_DB}:d=${FREEZE_MIN_DURATION_SECONDS}`;
  const stderr = await runFilterScan(filePath, ["-i", filePath, "-vf", filter, "-an", "-f", "null", "-"]);
  return { black: parseBlackDetect(stderr), frozen: parseFreezeDetect(stderr) };
}

async function scanAudioIssues(filePath: string): Promise<{ silence: DetectedRange[]; maxVolumeDb: number | null }> {
  const filter = `silencedetect=noise=${SILENCE_NOISE_THRESHOLD_DB}:d=${SILENCE_MIN_DURATION_SECONDS},volumedetect`;
  const stderr = await runFilterScan(filePath, ["-i", filePath, "-af", filter, "-vn", "-f", "null", "-"]);
  return { silence: parseSilenceDetect(stderr), maxVolumeDb: parseMaxVolumeDb(stderr) };
}

function shotLabel(timeline: readonly ShotTimelineEntry[], timeSeconds: number): string {
  const index = shotIndexAtTime(timeline, timeSeconds);
  return index === null ? "the final video" : `shot #${index + 1}`;
}

function issue(code: VideoQualityIssueCode, message: string, shotIndex: number | null, timeSeconds: number | null): VideoStorylineQualityIssue {
  return { code, message, shotIndex, timeSeconds };
}

/**
 * Runs the full check against an already-stitched file (passed as a buffer;
 * written to a scratch temp file for ffmpeg/ffprobe, cleaned up afterward).
 * Never throws for a file that ffmpeg/ffprobe can open -- check failures are
 * reported in the returned issues (code "check_error") rather than bubbling
 * an exception, so a transient probe hiccup does not crash the stitch tick.
 */
export async function runVideoQualityCheck(videoBuffer: Buffer, plan: VideoQualityCheckPlan): Promise<VideoQualityCheckResult> {
  const timeline = buildShotTimeline(plan.shots);
  const expectedDuration = expectedTotalDurationSeconds(plan.shots);
  const issues: VideoStorylineQualityIssue[] = [];

  try {
    await withTempFile(videoBuffer, async (filePath) => {
      const actualDuration = await probeDurationSeconds(filePath);
      const toleranceSeconds = Math.max(DURATION_TOLERANCE_SECONDS, expectedDuration * DURATION_TOLERANCE_RATIO);
      if (Math.abs(actualDuration - expectedDuration) > toleranceSeconds) {
        issues.push(
          issue(
            "duration_mismatch",
            `The final video is ${actualDuration.toFixed(1)}s long, but the shot plan calls for about ${expectedDuration.toFixed(1)}s.`,
            null,
            actualDuration,
          ),
        );
      }

      const hasAudioStream = await probeHasAudioStream(filePath);
      if (plan.expectAudio && !hasAudioStream) {
        issues.push(
          issue("missing_audio_stream", "A music bed was requested, but the final video has no audio track.", null, null),
        );
      }

      const { black, frozen } = await scanBlackAndFrozenStretches(filePath);
      for (const range of black) {
        issues.push(
          issue(
            "black_stretch",
            `${shotLabel(timeline, range.startSeconds)} has a black stretch of about ${range.durationSeconds.toFixed(1)}s starting at ${range.startSeconds.toFixed(1)}s.`,
            shotIndexAtTime(timeline, range.startSeconds),
            range.startSeconds,
          ),
        );
      }
      for (const range of frozen) {
        issues.push(
          issue(
            "frozen_stretch",
            `${shotLabel(timeline, range.startSeconds)} appears frozen for about ${range.durationSeconds.toFixed(1)}s starting at ${range.startSeconds.toFixed(1)}s.`,
            shotIndexAtTime(timeline, range.startSeconds),
            range.startSeconds,
          ),
        );
      }

      if (hasAudioStream) {
        const { silence, maxVolumeDb } = await scanAudioIssues(filePath);
        for (const range of silence) {
          issues.push(
            issue(
              "silent_audio",
              `${shotLabel(timeline, range.startSeconds)} has about ${range.durationSeconds.toFixed(1)}s of silence starting at ${range.startSeconds.toFixed(1)}s.`,
              shotIndexAtTime(timeline, range.startSeconds),
              range.startSeconds,
            ),
          );
        }
        if (maxVolumeDb !== null && maxVolumeDb >= CLIPPING_MAX_VOLUME_DB_THRESHOLD) {
          issues.push(
            issue("clipped_audio", `The audio track peaks at ${maxVolumeDb.toFixed(1)} dB, which indicates clipping.`, null, null),
          );
        }
      }
    });
  } catch (err) {
    issues.push(
      issue("check_error", `Automatic quality check could not finish: ${err instanceof Error ? err.message : String(err)}`, null, null),
    );
  }

  return { passed: issues.length === 0, issues };
}
