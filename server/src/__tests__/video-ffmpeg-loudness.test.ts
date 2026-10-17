import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hasBlockingVideoQualityIssue, videoQualityIssueSeverity } from "@paperclipai/shared";
import {
  buildLoudnessApplyArgs,
  buildLoudnessFilter,
  buildLoudnessMeasureArgs,
  checkFfmpegAvailable,
  normalizeLoudness,
  parseLoudnormMeasurement,
} from "../services/video-ffmpeg.js";
import { runVideoQualityCheck } from "../services/video-quality-check.js";

/**
 * Storyline export fix: every export evens out the sound (loudnorm to about
 * -14 LUFS, true-peak ceiling, then a hard limiter), and the check's
 * findings are warnings unless the film is really broken.
 */

const execFileAsync = promisify(execFile);

const LOG = `[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-4.56",
	"input_tp" : "0.39",
	"input_lra" : "0.00",
	"input_thresh" : "-14.56",
	"output_i" : "-14.01",
	"output_tp" : "-4.94",
	"output_lra" : "0.10",
	"output_thresh" : "-24.01",
	"normalization_type" : "dynamic",
	"target_offset" : "0.01"
}`;

describe("which findings block", () => {
  it("only a broken film blocks; loud peaks, silence, dark or still moments and a check that could not finish are warnings", () => {
    for (const code of ["clipped_audio", "silent_audio", "black_stretch", "frozen_stretch", "missing_audio_stream", "check_error"]) {
      expect(videoQualityIssueSeverity({ code })).toBe("warning");
    }
    for (const code of ["missing_video_stream", "duration_mismatch", "stitch_failed"]) {
      expect(videoQualityIssueSeverity({ code })).toBe("blocking");
    }
    expect(hasBlockingVideoQualityIssue([{ code: "clipped_audio" }, { code: "silent_audio" }])).toBe(false);
    expect(hasBlockingVideoQualityIssue([{ code: "clipped_audio" }, { code: "duration_mismatch" }])).toBe(true);
    expect(hasBlockingVideoQualityIssue(null)).toBe(false);
  });
});

describe("loudness filter and ffmpeg arguments", () => {
  it("reads loudnorm's measurement, and refuses -inf (silence) or a missing block", () => {
    expect(parseLoudnormMeasurement(LOG)).toEqual({ inputI: -4.56, inputTp: 0.39, inputLra: 0, inputThresh: -14.56, targetOffset: 0.01 });
    expect(parseLoudnormMeasurement(LOG.replace('"-4.56"', '"-inf"'))).toBeNull();
    expect(parseLoudnormMeasurement("no json here")).toBeNull();
  });

  it("the export's audio args carry loudnorm to -14 LUFS with a true-peak ceiling and a limiter; the picture is copied", () => {
    const filter = buildLoudnessFilter(parseLoudnormMeasurement(LOG));
    expect(filter).toBe(
      "loudnorm=I=-14.0:TP=-1.5:LRA=11.0:measured_I=-4.56:measured_TP=0.39:measured_LRA=0.00:measured_thresh=-14.56:offset=0.01:linear=true,aresample=48000,alimiter=limit=0.8913:level=0",
    );
    const args = buildLoudnessApplyArgs("in.mp4", "out.mp4", filter);
    expect(args[args.indexOf("-af") + 1]).toContain("loudnorm=I=-14.0:TP=-1.5");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ar", "48000"]));
    expect(args.at(-1)).toBe("out.mp4");
    // The measuring pass decodes only the sound.
    const measure = buildLoudnessMeasureArgs("in.mp4");
    expect(measure).toEqual(expect.arrayContaining(["-vn", "-f", "null"]));
    expect(measure[measure.indexOf("-af") + 1]).toContain("print_format=json");
  });

  it("falls back to one pass without a measurement, never lifts a quiet film by more than 12 dB, and only limits silence", () => {
    expect(buildLoudnessFilter(null)).toBe("loudnorm=I=-14.0:TP=-1.5:LRA=11.0,aresample=48000,alimiter=limit=0.8913:level=0");
    const quiet = buildLoudnessFilter({ inputI: -40, inputTp: -25, inputLra: 3, inputThresh: -50, targetOffset: 0 });
    expect(quiet).toContain("loudnorm=I=-28.0:");
    expect(buildLoudnessFilter({ inputI: -70, inputTp: -60, inputLra: 0, inputThresh: -80, targetOffset: 0 })).toBe("aresample=48000,alimiter=limit=0.8913:level=0");
  });
});

const ffmpegAvailable = await checkFfmpegAvailable(true);
const d = ffmpegAvailable ? describe : describe.skip;

async function inScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-loudness-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function maxVolume(dir: string, film: Buffer): Promise<number> {
  const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.mp4`);
  await writeFile(path, film);
  const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
  return Number.parseFloat(/max_volume:\s*(-?[\d.]+)/.exec(stderr)![1]!);
}

d("loudness and the check, with real ffmpeg", () => {
  const plan = { shots: [{ durationSeconds: 3, transitionIn: "cut", transitionDurationMs: 0 }], expectAudio: false };

  it("a film peaking at full scale trips only a clipping warning before, and nothing after evening out", async () => {
    await inScratch(async (dir) => {
      const loudPath = join(dir, "loud.mp4");
      await execFileAsync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=3,volume=18dB,alimiter=limit=1:level=0,volume=0.5dB",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", loudPath,
      ]);
      const loud = await readFile(loudPath);
      const before = await runVideoQualityCheck(loud, plan);
      expect(before.issues.map((i) => i.code)).toContain("clipped_audio");
      expect(before.blocking).toBe(false);
      expect(before.issues.find((i) => i.code === "clipped_audio")).toMatchObject({ severity: "warning" });

      const evened = await normalizeLoudness({ buffer: loud, contentType: "video/mp4" });
      expect(evened.mode).toBe("two-pass");
      expect(await maxVolume(dir, evened.buffer)).toBeLessThanOrEqual(-1.0);
      const after = await runVideoQualityCheck(evened.buffer, plan);
      expect(after.issues.map((i) => i.code)).not.toContain("clipped_audio");
    });
  }, 60_000);

  it("leaves a film without sound alone", async () => {
    await inScratch(async (dir) => {
      const path = join(dir, "mute.mp4");
      await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", path]);
      const mute = await readFile(path);
      const result = await normalizeLoudness({ buffer: mute, contentType: "video/mp4" });
      expect(result.mode).toBe("no-audio");
      expect(result.buffer.equals(mute)).toBe(true);
    });
  }, 60_000);

  it("a file with no picture is a blocking finding", async () => {
    await inScratch(async (dir) => {
      const path = join(dir, "sound-only.mp4");
      await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", path]);
      const result = await runVideoQualityCheck(await readFile(path), plan);
      expect(result.blocking).toBe(true);
      expect(result.issues.map((i) => i.code)).toEqual(["missing_video_stream"]);
    });
  }, 60_000);
});
