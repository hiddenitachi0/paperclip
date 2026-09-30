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
const AVAILABILITY_CACHE_MS = 5 * 60_000;
const FRAME_EXTRACT_TIMEOUT_MS = 30_000;
const STITCH_TIMEOUT_MS = 10 * 60_000;

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
