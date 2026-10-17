import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        // Decode only the final half second and keep overwriting the one
        // output picture, so what is left is the clip's real LAST frame --
        // "-sseof -1 -frames:v 1" took the frame a whole second before the
        // end, so every next shot started from a moment that never ended
        // the previous one.
        ["-y", "-sseof", "-0.5", "-i", input, "-update", "1", "-q:v", "2", output],
        { timeout: FRAME_EXTRACT_TIMEOUT_MS },
      );
      const frame = await readFile(output);
      return `data:image/jpeg;base64,${frame.toString("base64")}`;
    });
  } catch {
    return null;
  }
}

/**
 * Storyline strip: a clip's FIRST frame (data: URI JPEG) -- shot B's real
 * opening picture, the end frame an AI transition must arrive at. Null on
 * any failure, like extractLastFrameDataUri.
 */
export async function extractFirstFrameDataUri(clipBuffer: Buffer): Promise<string | null> {
  if (!(await checkFfmpegAvailable())) return null;
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      const output = join(dir, "frame.jpg");
      await writeFile(input, clipBuffer);
      await execFileAsync(FFMPEG_BINARY, ["-y", "-i", input, "-frames:v", "1", "-q:v", "2", output], { timeout: FRAME_EXTRACT_TIMEOUT_MS });
      const frame = await readFile(output);
      return `data:image/jpeg;base64,${frame.toString("base64")}`;
    });
  } catch {
    return null;
  }
}

/** One picture from a clip at a point in time (seconds, clamped number): a trimmed AI clip's new first or last picture. */
export async function extractFrameAtDataUri(clipBuffer: Buffer, atSeconds: number): Promise<string | null> {
  if (!(await checkFfmpegAvailable())) return null;
  const at = Math.min(3600, Math.max(0, Number.isFinite(atSeconds) ? atSeconds : 0));
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      const output = join(dir, "frame.jpg");
      await writeFile(input, clipBuffer);
      await execFileAsync(FFMPEG_BINARY, ["-y", "-ss", at.toFixed(3), "-i", input, "-frames:v", "1", "-q:v", "2", output], { timeout: FRAME_EXTRACT_TIMEOUT_MS });
      const frame = await readFile(output);
      return `data:image/jpeg;base64,${frame.toString("base64")}`;
    });
  } catch {
    return null;
  }
}

/**
 * Storyline strip (design 2.3, "keeping the context cheap"): 4 frames from a
 * clip's last second ("end") or first second ("start") on ONE picture side
 * by side, so the picture-reading model reads one image per side, not four.
 * Returns JPEG bytes, or null when ffmpeg is missing or the clip can't be read.
 */
export async function buildClipContactSheet(clipBuffer: Buffer, side: "start" | "end"): Promise<Buffer | null> {
  if (!(await checkFfmpegAvailable())) return null;
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      const output = join(dir, "sheet.jpg");
      await writeFile(input, clipBuffer);
      const window = side === "end" ? ["-sseof", "-1", "-i", input] : ["-t", "1", "-i", input];
      await execFileAsync(
        FFMPEG_BINARY,
        ["-y", ...window, "-vf", "fps=4,scale=384:-2,tile=4x1", "-frames:v", "1", "-q:v", "3", output],
        { timeout: FRAME_EXTRACT_TIMEOUT_MS },
      );
      return await readFile(output);
    });
  } catch {
    return null;
  }
}

/** A poster picture for a clip card: the first frame, scaled down (JPEG bytes), or null. */
export async function extractPosterJpeg(clipBuffer: Buffer): Promise<Buffer | null> {
  if (!(await checkFfmpegAvailable())) return null;
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      const output = join(dir, "poster.jpg");
      await writeFile(input, clipBuffer);
      await execFileAsync(FFMPEG_BINARY, ["-y", "-i", input, "-vf", "scale=480:-2", "-frames:v", "1", "-q:v", "4", output], { timeout: FRAME_EXTRACT_TIMEOUT_MS });
      return await readFile(output);
    });
  } catch {
    return null;
  }
}

/** Frame rate and frame count of a clip's first video stream (counted, not guessed). */
async function probeFrames(filePath: string): Promise<{ fps: number; frames: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BINARY,
      ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,nb_read_frames", "-of", "csv=p=0", filePath],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const [rate, count] = stdout.trim().split(",");
    const [num, den] = (rate ?? "").split("/").map((v) => Number.parseFloat(v));
    const fps = num && den ? num / den : Number.NaN;
    const frames = Number.parseInt(count ?? "", 10);
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(frames) || frames <= 0) return null;
    return { fps, frames };
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

/**
 * ffmpeg's xfade filter supports many named transitions; this codebase
 * offers these (plus "cut", which skips xfade entirely). A hardcoded
 * allow-list, a copy of VIDEO_XFADE_NAMES in packages/shared: a name only
 * reaches a filter graph after passing this check.
 */
export const XFADE_NAMES = ["fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "zoomin", "pixelize", "radial"] as const;
export type XfadeName = (typeof XFADE_NAMES)[number];
const XFADE_TRANSITIONS = new Set<string>(XFADE_NAMES);

export function isXfadeTransition(value: string): value is XfadeName {
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

/** Normalized clip format for stitching: every clip gets the same size, frame rate, pixel format and codecs so concat (-c copy) and xfade never see mismatched inputs. */
const NORMALIZED_FPS = 30;

export interface NormalizedClips {
  buffers: Buffer[];
  /** Real duration of each normalized clip, via ffprobe. */
  durationsSeconds: number[];
}

/** Width/height of a clip's first video stream (even numbers, as libx264 needs). */
async function probeVideoSize(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    FFPROBE_BINARY,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", filePath],
    { timeout: PROBE_TIMEOUT_MS },
  );
  const [w, h] = stdout.trim().split("x").map((v) => Number.parseInt(v, 10));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) throw new Error("ffprobe could not read the clip's picture size");
  const even = (n: number) => Math.max(2, Math.min(4096, n - (n % 2)));
  return { width: even(w), height: even(h) };
}

/**
 * Re-encodes every rendered clip to one common format before stitching:
 * the first clip's picture size (others are scaled and letterboxed to fit),
 * a fixed frame rate, yuv420p H.264, and -- when any clip has sound --
 * AAC stereo audio (silence is added to clips without any). Providers do
 * not promise identical output across shots (a text-to-video first shot and
 * image-to-video later shots can differ in size/frame rate/audio), and the
 * concat demuxer (-c copy) and xfade both break on mismatched inputs.
 * Returns each clip's real duration too, so the quality check compares the
 * stitched film against what was actually rendered.
 */
export interface NormalizeClipOptions {
  /**
   * An inserted AI transition: its first frame repeats shot A's last frame
   * and its last frame repeats shot B's first frame, so both are dropped and
   * each picture is shown once (design 2.3, "making the joins invisible").
   */
  trimEdgeFrames?: boolean;
  /** "strip" = replaced by silence (a provider that ignored "no sound" can't leak noise in); a number = gain in dB. */
  audio?: "keep" | "strip" | { gainDb: number };
  /** Phase 2 "end frame: trim": drop this clip's last frame (the next AI shot starts on exactly that picture). */
  trimLastFrame?: boolean;
  /** Timeline editor: only this part of the clip (a made AI clip's trim). endMs null = to the end. */
  trimMs?: { startMs: number; endMs: number | null };
}

/** The input-side seek for a trimmed clip: numbers only (clamped), never caller text. */
export function clipTrimInputArgs(trim: NormalizeClipOptions["trimMs"]): string[] {
  if (!trim) return [];
  const start = Math.min(3600, Math.max(0, Math.round(trim.startMs) / 1000));
  const args = start > 0 ? ["-ss", start.toFixed(3)] : [];
  if (trim.endMs !== null && Number.isFinite(trim.endMs)) {
    const length = Math.min(3600, Math.max(0.1, Math.round(trim.endMs) / 1000 - start));
    args.push("-t", length.toFixed(3));
  }
  return args;
}

/**
 * Phase 2 (design 2.7): what every clip is turned into before joining --
 * the export's picture size and frame rate (instead of the first clip's
 * size and a fixed 30 fps), fill or fit, and the encoder quality.
 */
export interface NormalizeTarget {
  width: number;
  height: number;
  fps: number;
  fit: "fill" | "fit";
  quality: "standard" | "high";
}

/** Shapes within this share of each other are "the same shape": cropped to fill, never letterboxed (1280x704 next to 1280x720). */
export const SMALL_ASPECT_MISMATCH = 0.06;

function evenDimension(n: number): number {
  const v = Math.max(2, Math.min(4096, Math.round(n)));
  return v - (v % 2);
}

/**
 * The scale/crop/pad part of a clip's filter: "fill" always crops to fill
 * the frame; "fit" crops only small size differences and letterboxes a
 * really different shape. Numbers only (clamped integers), never caller text.
 */
export function buildFitFilter(source: { width: number; height: number }, target: { width: number; height: number }, fit: "fill" | "fit"): string {
  const w = evenDimension(target.width);
  const h = evenDimension(target.height);
  const sourceAspect = source.width > 0 && source.height > 0 ? source.width / source.height : w / h;
  const mismatch = Math.abs(sourceAspect - w / h) / (w / h);
  if (fit === "fill" || mismatch <= SMALL_ASPECT_MISMATCH) {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
}

/** Encoder settings per quality: Standard is fast; High spends more time for a cleaner picture. */
export function encoderArgs(quality: "standard" | "high"): string[] {
  return quality === "high" ? ["-c:v", "libx264", "-preset", "medium", "-crf", "17"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
}

/** A frame rate the export offers (16/24/25/30/60); anything else becomes 30. */
export function clampExportFps(fps: number): number {
  return [16, 24, 25, 30, 60].includes(fps) ? fps : NORMALIZED_FPS;
}

/** Longer films get longer to finish (design 7.5): 10 minutes plus 4 seconds per second of film. */
export function ffmpegTimeoutMsFor(seconds: number): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 6 * 3600) : 0;
  return STITCH_TIMEOUT_MS + Math.round(s * 4_000);
}

export async function normalizeClipsForStitch(
  clipBuffers: readonly Buffer[],
  clipOptions: ReadonlyArray<NormalizeClipOptions | undefined> = [],
  target?: NormalizeTarget,
): Promise<NormalizedClips> {
  if (clipBuffers.length === 0) throw new Error("No clips to stitch");
  return withTempDir(async (dir) => {
    const inputs: string[] = [];
    for (const [index, buffer] of clipBuffers.entries()) {
      const path = join(dir, `in-${String(index).padStart(6, "0")}.mp4`);
      await writeFile(path, buffer);
      inputs.push(path);
    }
    // No target (older callers): the first clip's size, 30 fps, letterbox -- the round-1 behaviour.
    const first = await probeVideoSize(inputs[0]!);
    const width = evenDimension(target?.width ?? first.width);
    const height = evenDimension(target?.height ?? first.height);
    const fps = target ? clampExportFps(target.fps) : NORMALIZED_FPS;
    const fit = target?.fit ?? "fit";
    const probedAudio = await Promise.all(inputs.map((path) => probeHasAudioStream(path)));
    const hasAudio = probedAudio.map((has, index) => has && clipOptions[index]?.audio !== "strip");
    const anyAudio = hasAudio.some(Boolean);
    const buffers: Buffer[] = [];
    const durationsSeconds: number[] = [];
    for (const [index, input] of inputs.entries()) {
      const output = join(dir, `norm-${String(index).padStart(6, "0")}.mp4`);
      const opts = clipOptions[index];
      const args = ["-y", ...clipTrimInputArgs(opts?.trimMs), "-i", input];
      if (anyAudio && !hasAudio[index]) {
        args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      }
      args.push("-map", "0:v:0");
      if (anyAudio) args.push("-map", hasAudio[index] ? "0:a:0" : "1:a:0");
      const size = target ? await probeVideoSize(input) : first;
      const videoFilter = `${target ? buildFitFilter(size, { width, height }, fit) : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`},setsar=1,fps=${fps},format=yuv420p`;
      let clipVideoFilter = videoFilter;
      const audioFilters: string[] = [];
      // A trimmed clip is already cut where the person chose; frame-exact trims would count the wrong frames.
      if ((opts?.trimEdgeFrames || opts?.trimLastFrame) && !opts?.trimMs) {
        const probe = await probeFrames(input);
        const dropFirst = opts.trimEdgeFrames ? 1 : 0;
        if (probe && probe.frames >= 3) {
          // Integers only, from ffprobe's own count -- never caller text.
          clipVideoFilter = `trim=start_frame=${dropFirst}:end_frame=${Math.floor(probe.frames) - 1},setpts=PTS-STARTPTS,${videoFilter}`;
          if (hasAudio[index] && dropFirst) audioFilters.push(`atrim=start=${(1 / probe.fps).toFixed(4)},asetpts=PTS-STARTPTS`);
        }
      }
      if (hasAudio[index] && opts?.audio && typeof opts.audio === "object") {
        audioFilters.push(`volume=${clampMusicVolumeDb(opts.audio.gainDb)}dB`);
      }
      args.push("-vf", clipVideoFilter, ...encoderArgs(target?.quality ?? "standard"), "-r", String(fps));
      if (anyAudio && audioFilters.length > 0) args.push("-af", audioFilters.join(","));
      if (anyAudio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest");
      else args.push("-an");
      args.push("-movflags", "+faststart", output);
      await execFileAsync(FFMPEG_BINARY, args, { timeout: STITCH_TIMEOUT_MS, cwd: dir });
      buffers.push(await readFile(output));
      durationsSeconds.push(await probeDurationSeconds(output));
    }
    return { buffers, durationsSeconds };
  });
}

/** The ffmpeg xfade+acrossfade filter_complex for merging two already-decoded inputs ([0] = everything so far, [1] = the next clip) with a crossfade. Pure string-building, no I/O -- see buildXfadeFilterComplexTests for the injection-safety coverage. */
export function buildXfadeFilterComplex(params: {
  transition: XfadeName;
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
    ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
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
  transitionIn: "cut" | XfadeName;
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

async function xfadePair(dir: string, accumulatedPath: string, nextPath: string, transition: XfadeName, durationMs: number): Promise<string> {
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
  /** Phase 2 music lane (all optional; absent = the whole file from the start, looped, mixed under the clips). */
  trimInMs?: number;
  trimOutMs?: number | null;
  offsetMs?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  mode?: "mix" | "replace";
}

export interface MusicLaneParams {
  volumeDb: number;
  videoDurationSeconds: number;
  musicDurationSeconds: number;
  hasExistingAudio: boolean;
  trimInMs?: number;
  trimOutMs?: number | null;
  offsetMs?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  mode?: "mix" | "replace";
}

const MUSIC_SAMPLE_RATE = 48_000;

function msToSeconds(ms: number | null | undefined, max: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(max, ms / 1000);
}

/**
 * Phase 2 (design 2.6): the music lane's filter graph. Plays the chosen part
 * of the file (trim in/out), looped when it is shorter than the film, from
 * the start offset, with fades and a volume; then either mixes it under the
 * clips' own sound or replaces that sound. Numbers only, each clamped and
 * formatted by toFixed here -- never caller text. Returns the graph and the
 * output label to map.
 */
export function buildMusicLaneFilterComplex(params: MusicLaneParams): { filter: string; output: "[aout]" | "[music]" } {
  const film = Math.max(0, Number.isFinite(params.videoDurationSeconds) ? params.videoDurationSeconds : 0);
  const fileLength = Math.max(0.1, Number.isFinite(params.musicDurationSeconds) ? params.musicDurationSeconds : 0.1);
  const trimIn = Math.min(msToSeconds(params.trimInMs, 3600), Math.max(0, fileLength - 0.1));
  const trimOutRaw = msToSeconds(params.trimOutMs ?? null, 3600);
  const trimOut = trimOutRaw > trimIn ? Math.min(trimOutRaw, fileLength) : fileLength;
  const segment = Math.max(0.1, trimOut - trimIn);
  const offset = Math.min(msToSeconds(params.offsetMs, 3600), film);
  const playLength = Math.max(0, film - offset);
  const fadeIn = Math.min(msToSeconds(params.fadeInMs, 30), playLength);
  const fadeOut = Math.min(msToSeconds(params.fadeOutMs, 30), playLength);
  const volumeDb = clampMusicVolumeDb(params.volumeDb);
  const chain: string[] = [
    `atrim=start=${trimIn.toFixed(3)}:end=${trimOut.toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
    `aformat=sample_rates=${MUSIC_SAMPLE_RATE}:channel_layouts=stereo`,
  ];
  if (segment < playLength) chain.push(`aloop=loop=-1:size=${Math.max(1, Math.round(segment * MUSIC_SAMPLE_RATE))}`);
  chain.push(`atrim=0:${playLength.toFixed(3)}`, "asetpts=PTS-STARTPTS");
  if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, playLength - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  chain.push(`volume=${volumeDb}dB`);
  if (offset > 0) chain.push(`adelay=delays=${Math.round(offset * 1000)}:all=1`);
  chain.push("apad", `atrim=0:${film.toFixed(3)}`);
  const music = `[1:a]${chain.join(",")}[music]`;
  if (!params.hasExistingAudio || params.mode === "replace") return { filter: music, output: "[music]" };
  return { filter: `${music};[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`, output: "[aout]" };
}

/** Lays the music lane under an already-stitched film (or in place of its sound). Called at most once per stitch. */
export async function addMusicBed(video: StitchResult, music: MusicBedInput): Promise<StitchResult> {
  return withTempDir(async (dir) => {
    const videoPath = join(dir, "video.mp4");
    const musicPath = join(dir, "music.audio");
    await writeFile(videoPath, video.buffer);
    await writeFile(musicPath, music.buffer);
    const [videoDuration, hasExistingAudio, musicDuration] = await Promise.all([
      probeDurationSeconds(videoPath),
      probeHasAudioStream(videoPath),
      probeDurationSeconds(musicPath),
    ]);
    const { filter, output } = buildMusicLaneFilterComplex({
      volumeDb: music.volumeDb,
      videoDurationSeconds: videoDuration,
      musicDurationSeconds: musicDuration,
      hasExistingAudio,
      trimInMs: music.trimInMs,
      trimOutMs: music.trimOutMs,
      offsetMs: music.offsetMs,
      fadeInMs: music.fadeInMs,
      fadeOutMs: music.fadeOutMs,
      mode: music.mode,
    });
    const outputPath = join(dir, "with-music.mp4");
    await execFileAsync(
      FFMPEG_BINARY,
      // The music may be an uploaded file: local files only, never a playlist reaching out (security review DUR-4745).
      ["-y", "-i", videoPath, "-protocol_whitelist", "file", "-i", musicPath, "-filter_complex", filter, "-map", "0:v", "-map", output, "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", outputPath],
      { timeout: ffmpegTimeoutMsFor(videoDuration), cwd: dir },
    );
    return { buffer: await readFile(outputPath), contentType: "video/mp4" };
  });
}

// ─── Phase 2: uploads, prepared clips, photo clips, title cards ─────────────
//
// SECURITY: same rules as above. Every argument list is built here from
// numbers we clamp and paths we create inside our own temp directory; user
// text (titles, credits) is written to a file and read by drawtext's
// `textfile` option with `expansion=none`, so it never appears in a filter
// graph or an argv slot and `%{...}` sequences are drawn literally.

export interface ProbedMedia {
  width: number;
  height: number;
  durationSeconds: number;
  /** The stream's nominal rate (r_frame_rate) and its average (avg_frame_rate). */
  nominalFps: number | null;
  averageFps: number | null;
  colorTransfer: string | null;
  hasDolbyVision: boolean;
  hasAudio: boolean;
  /** Display rotation in degrees (phones store portrait video as rotated landscape). */
  rotation: number;
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [num, den] = value.split("/").map((v) => Number.parseFloat(v));
  if (!num || !Number.isFinite(num)) return null;
  const rate = den ? num / den : num;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Reads ffprobe's JSON for one file into the few facts the upload pipeline needs. Pure (tested without ffprobe). */
export function readProbeJson(json: unknown): ProbedMedia | null {
  if (!json || typeof json !== "object") return null;
  const root = json as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && (s.disposition as Record<string, unknown> | undefined)?.attached_pic !== 1);
  if (!video) return null;
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const sideData = Array.isArray(video.side_data_list) ? (video.side_data_list as Array<Record<string, unknown>>) : [];
  const rotationEntry = sideData.find((d) => typeof d.rotation === "number");
  const tagRotation = Number((video.tags as Record<string, unknown> | undefined)?.rotate ?? 0);
  const rotation = Math.round(Number(rotationEntry?.rotation ?? tagRotation) || 0);
  const duration = Number.parseFloat(String(root.format?.duration ?? video.duration ?? ""));
  return {
    width,
    height,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    nominalFps: parseRate(video.r_frame_rate),
    averageFps: parseRate(video.avg_frame_rate),
    colorTransfer: typeof video.color_transfer === "string" ? video.color_transfer : null,
    hasDolbyVision: sideData.some((d) => typeof d.side_data_type === "string" && /dovi|dolby vision/i.test(d.side_data_type)),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    rotation,
  };
}

/** HDR phone video: iPhone HLG (arib-std-b67), HDR10/Dolby Vision PQ (smpte2084), or a Dolby Vision record. */
export function isHdrMedia(media: Pick<ProbedMedia, "colorTransfer" | "hasDolbyVision">): boolean {
  return media.hasDolbyVision || media.colorTransfer === "arib-std-b67" || media.colorTransfer === "smpte2084";
}

/** Variable frame rate: the average differs from the nominal rate by more than 1% (or the nominal rate is a container timebase like 600). */
export function isVariableFrameRate(media: Pick<ProbedMedia, "nominalFps" | "averageFps">): boolean {
  if (!media.nominalFps || !media.averageFps) return false;
  if (media.nominalFps > 120) return true;
  return Math.abs(media.nominalFps - media.averageFps) / media.nominalFps > 0.01;
}

/** The picture as shown (rotation applied), scaled to fit inside a box (never enlarged), even sides. */
export function fitInside(width: number, height: number, rotation: number, maxEdge: number): { width: number; height: number } {
  const turned = Math.abs(rotation) % 180 === 90;
  const w = turned ? height : width;
  const h = turned ? width : height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: evenDimension(w * scale), height: evenDimension(h * scale) };
}

/** HDR -> normal colour (BT.709 SDR) with the zscale + tonemap filters. */
export const HDR_TO_SDR_FILTER = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

/**
 * The working copy of an uploaded video: HDR tone-mapped to normal colour,
 * a constant frame rate (the storyline's), at most 1920 on its long side,
 * H.264/AAC, and no metadata (phones store GPS positions there).
 */
export function buildUploadTranscodeArgs(params: {
  input: string;
  output: string;
  media: ProbedMedia;
  fps: number;
  maxEdge?: number;
  toneMap: boolean;
  /** The sniffed container of an untrusted upload (see sniffVideoContainer). */
  inputFormat?: "mov" | "matroska" | null;
}): string[] {
  const fps = clampExportFps(params.fps);
  const size = fitInside(params.media.width, params.media.height, params.media.rotation, params.maxEdge ?? 1920);
  const filters = [...(params.toneMap ? [HDR_TO_SDR_FILTER] : []), `fps=${fps}`, `scale=${size.width}:${size.height}`, "setsar=1", "format=yuv420p"];
  return [
    "-y",
    ...untrustedInputArgs(params.inputFormat ?? null),
    "-i",
    params.input,
    "-map",
    "0:v:0",
    ...(params.media.hasAudio ? ["-map", "0:a:0"] : []),
    "-vf",
    filters.join(","),
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    ...encoderArgs("standard"),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    ...(params.media.hasAudio ? ["-c:a", "aac", "-ar", "48000", "-ac", "2"] : ["-an"]),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    params.output,
  ];
}

/** The light preview copy the strip plays: at most 640 on the long side, 24 fps, small bitrate. */
export function buildPreviewArgs(params: { input: string; output: string; width: number; height: number; hasAudio: boolean }): string[] {
  const size = fitInside(params.width, params.height, 0, 640);
  return [
    "-y",
    "-i",
    params.input,
    "-map",
    "0:v:0",
    ...(params.hasAudio ? ["-map", "0:a:0"] : []),
    "-vf",
    `fps=24,scale=${size.width}:${size.height},setsar=1,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    ...(params.hasAudio ? ["-c:a", "aac", "-b:a", "64k", "-ac", "1"] : ["-an"]),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    params.output,
  ];
}

/** One clip cut from a working copy, frame-accurate (re-encoded). */
export function buildTrimClipArgs(params: { input: string; output: string; startMs: number; durationMs: number }): string[] {
  const start = Math.max(0, Math.round(params.startMs)) / 1000;
  const duration = Math.max(0.1, Math.min(3600, Math.round(params.durationMs) / 1000));
  return [
    "-y",
    "-ss",
    start.toFixed(3),
    "-i",
    params.input,
    "-t",
    duration.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    params.output,
  ];
}

/** A photo as a clip: held still, or a slow 12% zoom into the middle (ffmpeg's zoompan, free). */
export function buildStillClipArgs(params: {
  input: string;
  output: string;
  seconds: number;
  motion: "hold" | "slow_zoom";
  source: { width: number; height: number };
  target: { width: number; height: number; fps: number; fit: "fill" | "fit" };
}): string[] {
  const fps = clampExportFps(params.target.fps);
  const w = evenDimension(params.target.width);
  const h = evenDimension(params.target.height);
  const seconds = Math.max(1, Math.min(60, Math.round(params.seconds)));
  const frames = seconds * fps;
  if (params.motion === "slow_zoom") {
    // Zoom on a picture twice the output size, so the slow move does not jitter.
    const big = buildFitFilter(params.source, { width: w * 2, height: h * 2 }, params.target.fit);
    const zoom = `zoompan=z='min(1+0.12*on/${frames},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps}`;
    return ["-y", "-i", params.input, "-vf", `${big},${zoom},setsar=1,format=yuv420p`, "-frames:v", String(frames), ...encoderArgs("standard"), "-r", String(fps), "-an", "-movflags", "+faststart", params.output];
  }
  return [
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    params.input,
    "-t",
    String(seconds),
    "-vf",
    `${buildFitFilter(params.source, { width: w, height: h }, params.target.fit)},setsar=1,format=yuv420p`,
    ...encoderArgs("standard"),
    "-tune",
    "stillimage",
    "-r",
    String(fps),
    "-an",
    "-movflags",
    "+faststart",
    params.output,
  ];
}

/** Paths that may be named inside a filter graph: our own temp files and admin-set font paths only, nothing that needs escaping. */
const FILTER_SAFE_PATH = /^[A-Za-z0-9/_.-]+$/;

export function assertFilterSafePath(path: string): string {
  if (!FILTER_SAFE_PATH.test(path) || path.includes("..")) throw new Error("A file path for the title card contains characters that are not allowed.");
  return path;
}

/** Wraps title text to lines that fit the picture (long words are cut, never run off the edge). */
export function wrapTitleText(text: string, maxCharsPerLine: number): string {
  const limit = Math.max(8, Math.floor(maxCharsPerLine));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      for (let piece = word; piece.length > 0; piece = piece.slice(limit)) {
        const chunk = piece.slice(0, limit);
        if (!line) line = chunk;
        else if (line.length + 1 + chunk.length <= limit) line = `${line} ${chunk}`;
        else {
          out.push(line);
          line = chunk;
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * A title card or credits: white text on black, fading in and out. The text
 * is read from `textFile` (written by us) with expansion off -- see the
 * SECURITY note above.
 */
export function buildTitleCardArgs(params: {
  textFile: string;
  output: string;
  seconds: number;
  kind: "opening" | "credits";
  target: { width: number; height: number; fps: number };
  fontFile?: string | null;
}): string[] {
  const w = evenDimension(params.target.width);
  const h = evenDimension(params.target.height);
  const fps = clampExportFps(params.target.fps);
  const seconds = Math.max(1, Math.min(15, Math.round(params.seconds)));
  const fontSize = Math.max(12, Math.round(Math.min(w, h) * (params.kind === "opening" ? 0.075 : 0.042)));
  const fade = Math.min(0.6, seconds / 4);
  const textFile = assertFilterSafePath(params.textFile);
  const font = params.fontFile ? `:fontfile=${assertFilterSafePath(params.fontFile)}` : "";
  const draw = `drawtext=textfile=${textFile}:expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=${Math.round(fontSize * 0.35)}:x=(w-text_w)/2:y=(h-text_h)/2${font}`;
  const fades = `fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${(seconds - fade).toFixed(2)}:d=${fade.toFixed(2)}`;
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${w}x${h}:r=${fps}:d=${seconds}`,
    "-vf",
    `${draw},${fades},format=yuv420p`,
    ...encoderArgs("standard"),
    "-r",
    String(fps),
    "-an",
    "-movflags",
    "+faststart",
    params.output,
  ];
}

/** Characters per line that fit a card of this size (a rough average glyph width). */
export function titleCharsPerLine(kind: "opening" | "credits", target: { width: number; height: number }): number {
  const fontSize = Math.max(12, Math.round(Math.min(target.width, target.height) * (kind === "opening" ? 0.075 : 0.042)));
  return Math.floor((target.width * 0.9) / (fontSize * 0.58));
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
];
let cachedFont: { value: string | null } | null = null;

/** An installed font for title cards (PAPERCLIP_FFMPEG_FONT_FILE, else DejaVu), or null to let fontconfig choose. */
export async function titleFontFile(): Promise<string | null> {
  if (cachedFont) return cachedFont.value;
  const configured = process.env.PAPERCLIP_FFMPEG_FONT_FILE?.trim();
  for (const candidate of [...(configured ? [configured] : []), ...FONT_CANDIDATES]) {
    try {
      if (!FILTER_SAFE_PATH.test(candidate)) continue;
      await access(candidate);
      cachedFont = { value: candidate };
      return candidate;
    } catch {
      // try the next one
    }
  }
  cachedFont = { value: null };
  return null;
}

let cachedFilters: { checkedAt: number; names: Set<string> } | null = null;

/** Whether this ffmpeg has a filter (zscale is needed for the HDR fix). */
export async function ffmpegHasFilter(name: string): Promise<boolean> {
  if (!cachedFilters || Date.now() - cachedFilters.checkedAt > AVAILABILITY_CACHE_MS) {
    try {
      const { stdout } = await execFileAsync(FFMPEG_BINARY, ["-hide_banner", "-filters"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      const names = new Set(stdout.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter((n): n is string => !!n));
      cachedFilters = { checkedAt: Date.now(), names };
    } catch {
      cachedFilters = { checkedAt: Date.now(), names: new Set() };
    }
  }
  return cachedFilters.names.has(name);
}

/**
 * What an uploaded video really is, from its first bytes (never the name or
 * the browser's claim): MP4/MOV/3GP ("ftyp" or a classic QuickTime atom) or
 * Matroska/WebM. Anything else -- a playlist or concat list named .mp4, say --
 * is refused before ffmpeg ever opens it (security review DUR-4745).
 */
export function sniffVideoContainer(bytes: Buffer): "mov" | "matroska" | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "matroska";
  const atom = bytes.subarray(4, 8).toString("latin1");
  if (["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(atom)) return "mov";
  return null;
}

/** A sound file's real type from its first bytes: MP3/AAC, WAV, M4A, Ogg or FLAC; anything else is refused. */
export function sniffAudioContainer(bytes: Buffer): "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac" | null {
  if (bytes.length < 12) return null;
  const head = bytes.subarray(0, 4).toString("latin1");
  if (bytes.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (head === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE") return "wav";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (head === "OggS") return "ogg";
  if (head === "fLaC") return "flac";
  if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return "aac";
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "mp3";
  return null;
}

/** Input options for an untrusted upload: local files only, and the container we sniffed (no format guessing). */
export function untrustedInputArgs(format: "mov" | "matroska" | null): string[] {
  return ["-protocol_whitelist", "file", ...(format ? ["-f", format] : [])];
}

export async function probeMediaFile(filePath: string, format: "mov" | "matroska" | null = null): Promise<ProbedMedia | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BINARY, ["-v", "error", ...untrustedInputArgs(format), "-show_streams", "-show_format", "-of", "json", filePath], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return readProbeJson(JSON.parse(stdout));
  } catch {
    return null;
  }
}

export interface ProcessedUploadVideo {
  working: Buffer;
  preview: Buffer;
  poster: Buffer;
  media: ProbedMedia;
  output: { width: number; height: number; durationSeconds: number };
  wasHdr: boolean;
  wasVariableFrameRate: boolean;
  /** Plain note when HDR could not be converted (this ffmpeg has no zscale). */
  note: string | null;
}

/** Plain errors for the person who uploaded: what went wrong and what to do. */
export class UploadProcessingError extends Error {}

/** Turns an uploaded video into its working copy, light preview and poster (design 2.5). */
export async function processUploadedVideo(raw: Buffer, opts: { fps: number; maxSeconds: number }): Promise<ProcessedUploadVideo> {
  return withTempDir(async (dir) => {
    const format = sniffVideoContainer(raw);
    if (!format) throw new UploadProcessingError("This file is not a video this server can use. Upload an MP4, MOV or WebM video.");
    const input = join(dir, "raw.video");
    await writeFile(input, raw);
    const media = await probeMediaFile(input, format);
    if (!media) throw new UploadProcessingError("This file could not be read as a video. Try saving it as an MP4 or MOV and upload it again.");
    if (media.durationSeconds > opts.maxSeconds + 0.5) {
      throw new UploadProcessingError(`This video is ${Math.round(media.durationSeconds)} seconds long; this company allows up to ${opts.maxSeconds} seconds per upload. Shorten it and upload it again.`);
    }
    const hdr = isHdrMedia(media);
    const toneMap = hdr && (await ffmpegHasFilter("zscale")) && (await ffmpegHasFilter("tonemap"));
    const working = join(dir, "working.mp4");
    await execFileAsync(FFMPEG_BINARY, buildUploadTranscodeArgs({ input, output: working, media, fps: opts.fps, toneMap, inputFormat: format }), {
      timeout: ffmpegTimeoutMsFor(media.durationSeconds * 3),
      cwd: dir,
    });
    const workingMedia = await probeMediaFile(working);
    if (!workingMedia) throw new UploadProcessingError("The video could not be converted. Try another file.");
    const preview = join(dir, "preview.mp4");
    await execFileAsync(FFMPEG_BINARY, buildPreviewArgs({ input: working, output: preview, width: workingMedia.width, height: workingMedia.height, hasAudio: workingMedia.hasAudio }), {
      timeout: ffmpegTimeoutMsFor(media.durationSeconds),
      cwd: dir,
    });
    const poster = join(dir, "poster.jpg");
    const posterSize = fitInside(workingMedia.width, workingMedia.height, 0, 480);
    await execFileAsync(FFMPEG_BINARY, ["-y", "-i", working, "-vf", `scale=${posterSize.width}:${posterSize.height}`, "-frames:v", "1", "-q:v", "4", poster], {
      timeout: FRAME_EXTRACT_TIMEOUT_MS,
      cwd: dir,
    });
    return {
      working: await readFile(working),
      preview: await readFile(preview),
      poster: await readFile(poster),
      media,
      output: { width: workingMedia.width, height: workingMedia.height, durationSeconds: workingMedia.durationSeconds || media.durationSeconds },
      wasHdr: hdr,
      wasVariableFrameRate: isVariableFrameRate(media),
      note: hdr && !toneMap ? "This video was filmed in HDR, and this server's ffmpeg cannot convert HDR colours, so it may look washed out." : null,
    };
  });
}

/** One clip cut from an uploaded video's working copy. */
export async function prepareTrimmedClip(working: Buffer, startMs: number, durationMs: number): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, "working.mp4");
    const output = join(dir, "clip.mp4");
    await writeFile(input, working);
    await execFileAsync(FFMPEG_BINARY, buildTrimClipArgs({ input, output, startMs, durationMs }), { timeout: ffmpegTimeoutMsFor(durationMs / 1000), cwd: dir });
    return readFile(output);
  });
}

/** A photo turned into a clip (hold or slow zoom). */
export async function renderStillClip(
  photo: Buffer,
  params: { seconds: number; motion: "hold" | "slow_zoom"; source: { width: number; height: number }; target: { width: number; height: number; fps: number; fit: "fill" | "fit" } },
): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, "photo.jpg");
    const output = join(dir, "still.mp4");
    await writeFile(input, photo);
    await execFileAsync(FFMPEG_BINARY, buildStillClipArgs({ input, output, ...params }), { timeout: ffmpegTimeoutMsFor(params.seconds * 3), cwd: dir });
    return readFile(output);
  });
}

/** A title card or credits clip. The text goes to a file, never into the filter graph. */
export async function renderTitleCard(text: string, params: { seconds: number; kind: "opening" | "credits"; target: { width: number; height: number; fps: number } }): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const textFile = join(dir, "title.txt");
    const output = join(dir, "title.mp4");
    await writeFile(textFile, wrapTitleText(text, titleCharsPerLine(params.kind, params.target)), "utf8");
    const args = buildTitleCardArgs({ textFile, output, seconds: params.seconds, kind: params.kind, target: params.target, fontFile: await titleFontFile() });
    await execFileAsync(FFMPEG_BINARY, args, { timeout: FRAME_EXTRACT_TIMEOUT_MS * 4, cwd: dir });
    return readFile(output);
  });
}

/** Width and height of a clip (exported for the stitch's export warnings). */
export async function probeClipSize(clip: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    return await withTempDir(async (dir) => {
      const input = join(dir, "in.mp4");
      await writeFile(input, clip);
      return await probeVideoSize(input);
    });
  } catch {
    return null;
  }
}
