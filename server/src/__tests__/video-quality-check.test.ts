import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildShotTimeline,
  expectedTotalDurationSeconds,
  parseBlackDetect,
  parseFreezeDetect,
  parseMaxVolumeDb,
  parseSilenceDetect,
  runVideoQualityCheck,
  shotIndexAtTime,
  type VideoQualityCheckShotPlan,
} from "../services/video-quality-check.js";
import { checkFfmpegAvailable } from "../services/video-ffmpeg.js";

const execFileAsync = promisify(execFile);

/**
 * DUR-4318: written fresh against ffmpeg/ffprobe's own documented filters --
 * no code, prompts, schemas or word lists copied from any other project
 * (researched OpenMontage (AGPL) and Graft (MIT) for ideas only, per the
 * ticket). Pure parsing/timeline helpers are tested unconditionally; the
 * end-to-end checks against real generated clips are gated on ffmpeg's
 * presence, same pattern as video-storyline-stitch-service.test.ts -- this
 * sandbox has none, so that block is exercised in any environment that does.
 */

describe("buildShotTimeline / expectedTotalDurationSeconds", () => {
  it("lays out cut-only shots back to back with no overlap", () => {
    const shots: VideoQualityCheckShotPlan[] = [
      { durationSeconds: 5, transitionIn: "cut", transitionDurationMs: 500 },
      { durationSeconds: 3, transitionIn: "cut", transitionDurationMs: 500 },
    ];
    const timeline = buildShotTimeline(shots);
    expect(timeline).toEqual([
      { shotIndex: 0, startSeconds: 0, endSeconds: 5 },
      { shotIndex: 1, startSeconds: 5, endSeconds: 8 },
    ]);
    expect(expectedTotalDurationSeconds(shots)).toBe(8);
  });

  it("overlaps a fade/dissolve boundary by its transition duration, shortening the total", () => {
    const shots: VideoQualityCheckShotPlan[] = [
      { durationSeconds: 5, transitionIn: "cut", transitionDurationMs: 500 },
      { durationSeconds: 5, transitionIn: "fade", transitionDurationMs: 1000 },
    ];
    const timeline = buildShotTimeline(shots);
    expect(timeline).toEqual([
      { shotIndex: 0, startSeconds: 0, endSeconds: 5 },
      { shotIndex: 1, startSeconds: 4, endSeconds: 9 },
    ]);
    expect(expectedTotalDurationSeconds(shots)).toBe(9);
  });

  it("shot 0 is never treated as transitioning in, even if its row has a stale value", () => {
    const shots: VideoQualityCheckShotPlan[] = [{ durationSeconds: 4, transitionIn: "cut", transitionDurationMs: 500 }];
    expect(buildShotTimeline(shots)).toEqual([{ shotIndex: 0, startSeconds: 0, endSeconds: 4 }]);
  });
});

describe("shotIndexAtTime", () => {
  const timeline = buildShotTimeline([
    { durationSeconds: 5, transitionIn: "cut", transitionDurationMs: 500 },
    { durationSeconds: 3, transitionIn: "cut", transitionDurationMs: 500 },
  ]);

  it("finds the shot containing a timestamp", () => {
    expect(shotIndexAtTime(timeline, 0)).toBe(0);
    expect(shotIndexAtTime(timeline, 4.9)).toBe(0);
    expect(shotIndexAtTime(timeline, 5)).toBe(1);
    expect(shotIndexAtTime(timeline, 7.9)).toBe(1);
  });

  it("clamps out-of-range timestamps to the nearest shot instead of returning null", () => {
    expect(shotIndexAtTime(timeline, 100)).toBe(1);
    expect(shotIndexAtTime(timeline, -5)).toBe(0);
  });

  it("returns null for an empty timeline", () => {
    expect(shotIndexAtTime([], 1)).toBeNull();
  });
});

describe("ffmpeg log parsers", () => {
  it("parses blackdetect lines", () => {
    const log = `[blackdetect @ 0x1] black_start:2.5 black_end:4.1 black_duration:1.6\nsome other line\n[blackdetect @ 0x1] black_start:10 black_end:11 black_duration:1.0`;
    expect(parseBlackDetect(log)).toEqual([
      { startSeconds: 2.5, durationSeconds: 1.6 },
      { startSeconds: 10, durationSeconds: 1.0 },
    ]);
  });

  it("parses freezedetect lines emitted as separate log entries", () => {
    const log = [
      "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 2.000000",
      "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_duration: 3.000000",
      "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_end: 5.000000",
    ].join("\n");
    expect(parseFreezeDetect(log)).toEqual([{ startSeconds: 2, durationSeconds: 3 }]);
  });

  it("parses silencedetect lines", () => {
    const log = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 3.0";
    expect(parseSilenceDetect(log)).toEqual([{ startSeconds: 1.5, durationSeconds: 3.0 }]);
  });

  it("parses the volumedetect summary line", () => {
    expect(parseMaxVolumeDb("[Parsed_volumedetect_0 @ 0x1] max_volume: -0.0 dB")).toBe(-0.0);
    expect(parseMaxVolumeDb("[Parsed_volumedetect_0 @ 0x1] max_volume: -12.3 dB")).toBe(-12.3);
    expect(parseMaxVolumeDb("no volume line here")).toBeNull();
  });

  it("returns empty arrays for logs with no matches", () => {
    expect(parseBlackDetect("")).toEqual([]);
    expect(parseFreezeDetect("")).toEqual([]);
    expect(parseSilenceDetect("")).toEqual([]);
  });
});

const ffmpegAvailable = await checkFfmpegAvailable();
const d = ffmpegAvailable ? describe : describe.skip;
if (!ffmpegAvailable) {
  console.warn("Skipping video-quality-check end-to-end tests: ffmpeg is not available in this environment.");
}

/** Builds a tiny synthetic clip via ffmpeg's lavfi test sources -- no real media asset is read from or written to any other project. */
async function generateClip(
  dir: string,
  name: string,
  opts: { videoFilter: string; audioFilter: string; durationSeconds: number },
): Promise<Buffer> {
  const outputPath = join(dir, name);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${opts.videoFilter}:d=${opts.durationSeconds}`,
    "-f",
    "lavfi",
    "-i",
    `${opts.audioFilter}:d=${opts.durationSeconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outputPath,
  ]);
  return readFile(outputPath);
}

d("runVideoQualityCheck (end-to-end, real ffmpeg)", () => {
  async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-video-quality-check-test-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const SINGLE_SHOT_PLAN: VideoQualityCheckShotPlan[] = [{ durationSeconds: 3, transitionIn: "cut", transitionDurationMs: 500 }];

  it("passes a clean clip with normal video and audio", async () => {
    await withScratchDir(async (dir) => {
      const clip = await generateClip(dir, "clean.mp4", {
        videoFilter: "testsrc=size=160x120:rate=15",
        audioFilter: "sine=frequency=440",
        durationSeconds: 3,
      });
      const result = await runVideoQualityCheck(clip, { shots: SINGLE_SHOT_PLAN, expectAudio: true });
      expect(result.issues.filter((i) => i.code !== "duration_mismatch")).toEqual([]);
    });
  }, 30_000);

  it("flags a long black stretch and locates it", async () => {
    await withScratchDir(async (dir) => {
      const clip = await generateClip(dir, "black.mp4", {
        videoFilter: "color=c=black:size=160x120:rate=15",
        audioFilter: "sine=frequency=440",
        durationSeconds: 3,
      });
      const result = await runVideoQualityCheck(clip, { shots: SINGLE_SHOT_PLAN, expectAudio: true });
      expect(result.passed).toBe(false);
      const blackIssue = result.issues.find((i) => i.code === "black_stretch");
      expect(blackIssue).toBeDefined();
      expect(blackIssue?.shotIndex).toBe(0);
      expect(blackIssue?.timeSeconds).not.toBeNull();
    });
  }, 30_000);

  it("flags a frozen stretch", async () => {
    await withScratchDir(async (dir) => {
      // A single still frame held for the whole clip -- tiny `d` holds the source frame rate at 1, frozen throughout.
      const clip = await generateClip(dir, "frozen.mp4", {
        videoFilter: "testsrc=size=160x120:rate=1",
        audioFilter: "sine=frequency=440",
        durationSeconds: 3,
      });
      const result = await runVideoQualityCheck(clip, { shots: SINGLE_SHOT_PLAN, expectAudio: true });
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.code === "frozen_stretch")).toBe(true);
    });
  }, 30_000);

  it("flags silent audio", async () => {
    await withScratchDir(async (dir) => {
      const clip = await generateClip(dir, "silent.mp4", {
        videoFilter: "testsrc=size=160x120:rate=15",
        audioFilter: "anullsrc=channel_layout=stereo:sample_rate=44100",
        durationSeconds: 3,
      });
      const result = await runVideoQualityCheck(clip, { shots: SINGLE_SHOT_PLAN, expectAudio: true });
      expect(result.passed).toBe(false);
      const silentIssue = result.issues.find((i) => i.code === "silent_audio");
      expect(silentIssue).toBeDefined();
      expect(silentIssue?.shotIndex).toBe(0);
    });
  }, 30_000);
});
