import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildClipContactSheet, checkFfmpegAvailable, extractFirstFrameDataUri, normalizeClipsForStitch } from "../services/video-ffmpeg.ts";
import { mediaJobQueueState, runMediaJob } from "../services/media-job-queue.ts";

/**
 * Storyline strip: an inserted AI bridge loses its duplicated first and last
 * frame and, for "no transition sound", its audio; contact sheets put a
 * second of frames on one picture; heavy jobs run at most 2 at a time.
 */
const ffmpeg = await checkFfmpegAvailable(true);
const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-strip-ffmpeg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function clip(name: string, frames: number, withAudio: boolean): Buffer {
  const out = path.join(dir, name);
  const args = ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=160x120:rate=24`];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  execFileSync("ffmpeg", args);
  return readFileSync(out);
}

function probe(buffer: Buffer): { frames: number; audio: boolean; maxVolume: number | null } {
  const file = path.join(dir, `probe-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(file, buffer);
  const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).toString().trim());
  const audio = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]).toString().trim().length > 0;
  let maxVolume: number | null = null;
  if (audio) {
    const log = spawnSync("ffmpeg", ["-i", file, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(log);
    maxVolume = m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
  }
  return { frames, audio, maxVolume };
}

describe.skipIf(!ffmpeg)("strip ffmpeg helpers", () => {
  it("drops the AI bridge's duplicate edge frames and strips its sound", async () => {
    const shot = clip("shot.mp4", 24, true);
    const bridge = clip("bridge.mp4", 24, true);
    const out = await normalizeClipsForStitch([shot, bridge], [undefined, { trimEdgeFrames: true, audio: "strip" }]);
    const shotOut = probe(out.buffers[0]!);
    const bridgeOut = probe(out.buffers[1]!);
    // 24 source frames at 24 fps -> 30 fps normalised; the bridge lost 2 source frames (~2.5 output frames).
    expect(bridgeOut.frames).toBeLessThan(shotOut.frames);
    expect(out.durationsSeconds[1]!).toBeLessThan(out.durationsSeconds[0]!);
    expect(bridgeOut.audio).toBe(true); // silence, so the film keeps one audio track
    expect(bridgeOut.maxVolume === -Infinity || (bridgeOut.maxVolume ?? 0) < -60).toBe(true);
    expect((shotOut.maxVolume ?? -99) > -30).toBe(true);
  }, 60_000);

  it("puts a second of frames on one contact sheet, and reads a first frame", async () => {
    const source = clip("sheet.mp4", 48, false);
    const sheet = await buildClipContactSheet(source, "end");
    expect(sheet?.subarray(0, 2).toString("hex")).toBe("ffd8");
    const file = path.join(dir, "sheet.jpg");
    writeFileSync(file, sheet!);
    const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
    expect(w).toBe(384 * 4);
    expect(h).toBeGreaterThan(0);
    expect(await extractFirstFrameDataUri(source)).toMatch(/^data:image\/jpeg;base64,/);
  }, 60_000);
});

describe("media job queue", () => {
  it("runs at most 2 heavy jobs at once by default, the rest in order", async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number) =>
      runMediaJob(`t${n}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        order.push(n);
        active -= 1;
      });
    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
    expect(mediaJobQueueState()).toMatchObject({ running: 0, waiting: 0, max: 2 });
  });
});
