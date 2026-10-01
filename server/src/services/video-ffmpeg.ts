import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * DUR-4127: a thin wrapper around the system `ffmpeg` binary, used for two
 * things: (1) extracting a shot's last ~1s frame so the next shot can
 * continue from it, and (2) stitching every shot into the final film. Ships
 * with a real availability check -- see the ticket's ground rule: if ffmpeg
 * is not on the host, the caller (video-storyline-render.ts /
 * video-storyline-stitch.ts) must fall back gracefully (skip continuity, or
 * leave a storyline "ready to stitch, ffmpeg unavailable") rather than
 * install anything or block. See the PR's "Host steps for Filip" section
 * for whether/how to add ffmpeg to the deploy image.
 */

const FFMPEG_BINARY = process.env.PAPERCLIP_FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE_BINARY = process.env.PAPERCLIP_FFPROBE_PATH?.trim() || "ffprobe";
const AVAILABILITY_CACHE_MS = 5 * 60_000;
const FRAME_EXTRACT_TIMEOUT_MS = 30_000;
const STITCH_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

let cachedAvailability: { checkedAt: number; available: boolean } | null = null;

/** Real detection, not a guess: actually spawns `ffmpeg -version` and checks it starts. Cached briefly so a busy stitch tick does not re-spawn every call. */
export async function checkFfmpegAvailable(force = false): Promise<boolean> {
  if (!force && cachedAvailability && Date.now() - cachedAvailability.checkedAt < AVAILABILITY_CACHE_MS) {
    return cachedAvailability.available;
  }
  let available: boolean;
  try {
    await execFileAsync(FFMPEG_BINARY, ["-version"], { timeout: 5_000 });
    available = true;
  } catch {
    available = false;
  }
  cachedAvailability = { checkedAt: Date.now(), available };
  return available;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-video-storyline-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The last ~1s of a clip, as a single JPEG frame (data: URI) for the next
 * shot's continuity image. Returns null (never throws) when ffmpeg is
 * unavailable or the extraction fails -- continuity is a quality
 * enhancement, not something that should ever block a render.
 */
export async function extractLastFrameDataUri(clipBuffer: Buffer): Promise<string | null> {
  if (!(await checkFfmpegAvailable())) return null;
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      const output = join(dir, "frame.jpg");
      await writeFile(input, clipBuffer);
      await execFileAsync(
        FFMPEG_BINARY,
        ["-y", "-sseof", "-1", "-i", input, "-frames:v", "1", "-q:v", "2", output],
        { timeout: FRAME_EXTRACT_TIMEOUT_MS },
      );
      const frame = await readFile(output);
      return `data:image/jpeg;base64,${frame.toString("base64")}`;
    });
  } catch {
    return null;
  }
}

export interface StitchResult {
  buffer: Buffer;
  contentType: string;
}

/**
 * Concatenates already-rendered clips (in order) into one film via ffmpeg's
 * concat demuxer (`-c copy`, no re-encode -- shots share the same
 * provider/model so their codecs should match). Throws on failure; the
 * caller (video-storyline-stitch.ts) is responsible for leaving the
 * storyline in a recoverable state rather than losing the shots.
 */
export async function stitchClips(clipBuffers: readonly Buffer[]): Promise<StitchResult> {
  if (clipBuffers.length === 0) throw new Error("No clips to stitch");
  return withTempDir(async (dir) => {
    const listLines: string[] = [];
    for (const [index, buffer] of clipBuffers.entries()) {
      const filename = `clip-${String(index).padStart(6, "0")}.mp4`;
      await writeFile(join(dir, filename), buffer);
      // ffmpeg's concat demuxer file list format; single-quoted, no escaping needed since we control the filenames.
      listLines.push(`file '${filename}'`);
    }
    const listPath = join(dir, "list.txt");
    await writeFile(listPath, listLines.join("\n"));
    const outputPath = join(dir, "out.mp4");
    await execFileAsync(
      FFMPEG_BINARY,
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath],
      { timeout: STITCH_TIMEOUT_MS, cwd: dir },
    );
    const buffer = await readFile(outputPath);
    return { buffer, contentType: "video/mp4" };
  });
}

/**
 * DUR-4196 round 2: transitions and a music bed. SECURITY: every value
 * embedded into an ffmpeg -filter_complex string here is either (a) a number
 * that passed through one of the clamp-prefixed helpers below -- so it is
 * always a finite, in-range value formatted by our own toFixed(3), never a
 * caller-supplied string -- or (b) a transition name checked against
 * XFADE_TRANSITIONS, a hardcoded allow-list. Nothing from a shot prompt,
 * title, or any other free-text field ever reaches this file. execFile (not
 * exec/spawn with shell:true) is used throughout, so even if a value were
 * attacker-controlled it could not break out of its argv slot. See the
 * exported pure helpers' own test file for the injection-safety tests.
 */

/** ffmpeg's xfade filter supports many named transitions; this codebase only ever offers these two (plus "cut", which skips xfade entirely) -- see VIDEO_SHOT_TRANSITIONS in packages/shared. */
const XFADE_TRANSITIONS = new Set(["fade", "dissolve"]);

export function isXfadeTransition(value: string): value is "fade" | "dissolve" {
  return XFADE_TRANSITIONS.has(value);
}

/** Defense in depth: clamps again regardless of what packages/shared's zod schema already enforced at the API boundary, since this function has no way to know its caller validated anything. */
export function clampTransitionDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.min(5_000, Math.max(0, Math.round(durationMs)));
}

/** Same defense-in-depth reasoning as clampTransitionDurationMs. */
export function clampMusicVolumeDb(volumeDb: number): number {
  if (!Number.isFinite(volumeDb)) return 0;
  return Math.min(0, Math.max(-60, Math.round(volumeDb)));
}

/** The ffmpeg xfade+acrossfade filter_complex for merging two already-decoded inputs ([0] = everything so far, [1] = the next clip) with a crossfade. Pure string-building, no I/O -- see buildXfadeFilterComplexTests for the injection-safety coverage. */
export function buildXfadeFilterComplex(params: {
  transition: "fade" | "dissolve";
  durationSeconds: number;
  offsetSeconds: number;
  includeAudio: boolean;
}): string {
  if (!isXfadeTransition(params.transition)) throw new Error(`Unsupported transition "${params.transition}"`);
  const duration = Math.min(5, Math.max(0.1, params.durationSeconds));
  const offset = Math.max(0, params.offsetSeconds);
  const video = `[0:v][1:v]xfade=transition=${params.transition}:duration=${duration.toFixed(3)}:offset=${offset.toFixed(3)}[v]`;
  if (!params.includeAudio) return video;
  return `${video};[0:a][1:a]acrossfade=d=${duration.toFixed(3)}[a]`;
}

/** The ffmpeg filter_complex for laying a volume-adjusted, looped music bed under a stitched film's existing audio (or as the sole audio track when the film has none). Pure string-building, no I/O. */
export function buildMusicBedFilterComplex(params: { volumeDb: number; videoDurationSeconds: number; hasExistingAudio: boolean }): string {
  const volumeDb = clampMusicVolumeDb(params.volumeDb);
  const duration = Math.max(0, params.videoDurationSeconds);
  const music = `[1:a]volume=${volumeDb}dB,atrim=0:${duration.toFixed(3)}[music]`;
  if (!params.hasExistingAudio) return music;
  return `${music};[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
}

/** Real duration via ffprobe (never trusted as a string -- parsed to a number and validated before any caller can use it). */
export async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    FFPROBE_BINARY,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { timeout: PROBE_TIMEOUT_MS },
  );
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error("ffprobe returned an unusable duration");
  return value;
}

/** Whether a file has at least one audio stream, via ffprobe -- clips from a provider that returns silent/video-only output must not crash the acrossfade/amix filters below. */
export async function probeHasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BINARY,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", filePath],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface ShotTransitionInput {
  buffer: Buffer;
  /** The resolved transition into THIS shot from the previous one -- "cut" (or the first shot) never invokes xfade. */
  transitionIn: "cut" | "fade" | "dissolve";
  transitionDurationMs: number;
}

/**
 * Stitches shots pairwise: a run of "cut" transitions uses the fast
 * concat-demuxer path (stitchClips, no re-encode); a "fade"/"dissolve"
 * boundary re-encodes just that one pair via xfade+acrossfade, then folds
 * the result back into the run. This never builds a single N-input filter
 * graph, so the cost of one crossfade never grows with the shot count.
 */
export async function stitchClipsWithTransitions(shots: readonly ShotTransitionInput[]): Promise<StitchResult> {
  if (shots.length === 0) throw new Error("No clips to stitch");
  if (shots.length === 1) return stitchClips([shots[0]!.buffer]);

  return withTempDir(async (dir) => {
    let accumulatedPath = join(dir, "acc-0.mp4");
    await writeFile(accumulatedPath, shots[0]!.buffer);
    let pendingCutRun: Buffer[] = [];

    async function flushCutRun(nextBuffer?: Buffer): Promise<void> {
      if (pendingCutRun.length === 0) return;
      const stitched = await stitchClips(pendingCutRun);
      const nextPath = join(dir, `acc-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      await writeFile(nextPath, stitched.buffer);
      accumulatedPath = nextPath;
      pendingCutRun = [];
      void nextBuffer;
    }

    for (let i = 1; i < shots.length; i += 1) {
      const shot = shots[i]!;
      if (shot.transitionIn === "cut") {
        if (pendingCutRun.length === 0) pendingCutRun.push(await readFile(accumulatedPath));
        pendingCutRun.push(shot.buffer);
        continue;
      }
      await flushCutRun();
      const nextClipPath = join(dir, `next-${i}.mp4`);
      await writeFile(nextClipPath, shot.buffer);
      accumulatedPath = await xfadePair(dir, accumulatedPath, nextClipPath, shot.transitionIn, shot.transitionDurationMs);
    }
    await flushCutRun();

    return { buffer: await readFile(accumulatedPath), contentType: "video/mp4" };
  });
}

async function xfadePair(dir: string, accumulatedPath: string, nextPath: string, transition: "fade" | "dissolve", durationMs: number): Promise<string> {
  const durationSeconds = clampTransitionDurationMs(durationMs) / 1000;
  const accumulatedDuration = await probeDurationSeconds(accumulatedPath);
  const offsetSeconds = Math.max(0, accumulatedDuration - durationSeconds);
  const [accHasAudio, nextHasAudio] = await Promise.all([probeHasAudioStream(accumulatedPath), probeHasAudioStream(nextPath)]);
  const includeAudio = accHasAudio && nextHasAudio;
  const filter = buildXfadeFilterComplex({ transition, durationSeconds, offsetSeconds, includeAudio });
  const outputPath = join(dir, `merge-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const maps = includeAudio ? ["-map", "[v]", "-map", "[a]"] : ["-map", "[v]"];
  await execFileAsync(
    FFMPEG_BINARY,
    ["-y", "-i", accumulatedPath, "-i", nextPath, "-filter_complex", filter, ...maps, outputPath],
    { timeout: STITCH_TIMEOUT_MS, cwd: dir },
  );
  return outputPath;
}

export interface MusicBedInput {
  buffer: Buffer;
  volumeDb: number;
}

/** Lays a (looped, volume-adjusted) music bed under an already-stitched film. Called at most once per stitch, after stitchClips/stitchClipsWithTransitions. */
export async function addMusicBed(video: StitchResult, music: MusicBedInput): Promise<StitchResult> {
  return withTempDir(async (dir) => {
    const videoPath = join(dir, "video.mp4");
    const musicPath = join(dir, "music.audio");
    await writeFile(videoPath, video.buffer);
    await writeFile(musicPath, music.buffer);
    const [videoDuration, hasExistingAudio] = await Promise.all([probeDurationSeconds(videoPath), probeHasAudioStream(videoPath)]);
    const filter = buildMusicBedFilterComplex({ volumeDb: music.volumeDb, videoDurationSeconds: videoDuration, hasExistingAudio });
    const outputPath = join(dir, "with-music.mp4");
    const audioMap = hasExistingAudio ? "[aout]" : "[music]";
    await execFileAsync(
      FFMPEG_BINARY,
      ["-y", "-i", videoPath, "-stream_loop", "-1", "-i", musicPath, "-filter_complex", filter, "-map", "0:v", "-map", audioMap, "-c:v", "copy", "-shortest", outputPath],
      { timeout: STITCH_TIMEOUT_MS, cwd: dir },
    );
    return { buffer: await readFile(outputPath), contentType: "video/mp4" };
  });
}
