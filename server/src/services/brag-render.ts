import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BragFormat } from "@paperclipai/shared";
import { redactForScreen } from "./brag-secret-mask.js";

const execFileAsync = promisify(execFile);
const FFMPEG_BINARY = process.env.PAPERCLIP_FFMPEG_PATH?.trim() || "ffmpeg";
const RENDER_TIMEOUT_MS = 2 * 60_000;

/**
 * DUR-4520: the slim-mode scene renderer -- local tools only. A scene is a
 * text card (still) and a short slow-zoom clip made from that same still.
 * The BragCapturer port exists so a headless-browser HTML capturer can be
 * swapped in without touching the pipeline or its tests; the default is
 * ffmpeg's drawtext because the server process cannot launch the hardened
 * browser itself (browser-worker is a separate, agent-session-bound
 * container). Whatever a capturer draws is passed through redactForScreen
 * here, so no capturer implementation can skip the mask.
 */
export interface BragCapturer {
  captureStill(input: { text: string; format: BragFormat }): Promise<Buffer>;
  /** A clip of `seconds` made from an approved still. */
  makeClip(input: { still: Buffer; seconds: number; format: BragFormat }): Promise<Buffer>;
}

export function frameSize(format: BragFormat): { width: number; height: number } {
  if (format === "vertical") return { width: 1080, height: 1920 };
  if (format === "square") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

/** Pure, exported for tests. The text lives in a file (textfile=) so no user text is ever parsed as filter syntax. */
export function buildStillArgs(params: { width: number; height: number; textFile: string; out: string }): string[] {
  const fontSize = Math.round(params.width / 24);
  const vf = `drawtext=textfile=${params.textFile}:fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12`;
  return ["-y", "-f", "lavfi", "-i", `color=c=0x111827:s=${params.width}x${params.height}:d=1`, "-vf", vf, "-frames:v", "1", params.out];
}

export function buildClipArgs(params: { width: number; height: number; seconds: number; still: string; out: string }): string[] {
  const frames = Math.max(1, Math.round(params.seconds * 30));
  const vf = `zoompan=z='min(zoom+0.0008,1.12)':d=${frames}:s=${params.width}x${params.height}:fps=30,format=yuv420p`;
  return ["-y", "-loop", "1", "-i", params.still, "-vf", vf, "-t", String(params.seconds), "-c:v", "libx264", "-an", params.out];
}

/** Hard-wraps so a long line never runs off the card. */
export function wrapCardText(text: string, maxChars = 36): string {
  const words = redactForScreen(text).replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 6).join("\n");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-brag-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const ffmpegBragCapturer: BragCapturer = {
  captureStill: ({ text, format }) =>
    withTempDir(async (dir) => {
      const { width, height } = frameSize(format);
      const textFile = join(dir, "card.txt");
      const out = join(dir, "still.png");
      await writeFile(textFile, wrapCardText(text), "utf8");
      await execFileAsync(FFMPEG_BINARY, buildStillArgs({ width, height, textFile, out }), { timeout: RENDER_TIMEOUT_MS, cwd: dir });
      return readFile(out);
    }),
  makeClip: ({ still, seconds, format }) =>
    withTempDir(async (dir) => {
      const { width, height } = frameSize(format);
      const stillPath = join(dir, "still.png");
      const out = join(dir, "clip.mp4");
      await writeFile(stillPath, still);
      await execFileAsync(FFMPEG_BINARY, buildClipArgs({ width, height, seconds, still: stillPath, out }), { timeout: RENDER_TIMEOUT_MS, cwd: dir });
      return readFile(out);
    }),
};
