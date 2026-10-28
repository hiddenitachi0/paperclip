// Paperclip render worker: how the Hyperframes CLI, ffprobe and the browser
// are started. Every child runs:
//   - with an allowlisted environment (never the worker's bearer token, never
//     anything inherited by accident: see childEnv),
//   - in its own process group, so a timeout or a cancel kills the browser
//     and every helper it started, not only the CLI,
//   - with a hard wall-clock limit.
// Argument builders are pure and exported for test/hyperframes.test.mjs.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const QUALITIES = Object.freeze(["draft", "standard", "high"]);

/**
 * The only variables a child sees. HOME and the caches point into the job's
 * own directory, so one job cannot read what another left behind.
 */
export function childEnv({ jobHome, browserPath, path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" }) {
  const env = {
    PATH: path,
    HOME: jobHome,
    XDG_CACHE_HOME: join(jobHome, ".cache"),
    XDG_CONFIG_HOME: join(jobHome, ".config"),
    HYPERFRAMES_FONT_CACHE_DIR: join(jobHome, ".cache", "fonts"),
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    // Hyperframes' own switches: no telemetry, no update or skills check, no
    // self-install. The container has no route out anyway; these keep it from
    // trying (and from waiting on a timeout).
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HF_NO_BROWSER: "1",
    // Software rendering (SwiftShader): the same pixels on every run.
    PRODUCER_BROWSER_GPU_MODE: "software",
  };
  if (browserPath) env.HYPERFRAMES_BROWSER_PATH = browserPath;
  return env;
}

export function buildCheckArgs(projectDir) {
  return ["check", projectDir, "--json"];
}

export function buildSnapshotArgs(projectDir, outDir, frames) {
  const count = Math.max(1, Math.min(24, Math.round(Number(frames) || 9)));
  return ["snapshot", projectDir, "-o", outDir, "--frames", String(count), "--describe", "false", "--no-browser-gpu"];
}

export function buildRenderArgs({ projectDir, entry, outFile, fps, quality, workers }) {
  const safeFps = Math.max(1, Math.min(60, Math.round(Number(fps) || 30)));
  const safeQuality = QUALITIES.includes(quality) ? quality : "standard";
  const safeWorkers = Math.max(1, Math.min(4, Math.round(Number(workers) || 1)));
  const args = [
    "render", projectDir,
    "-o", outFile,
    "--format", "mp4",
    "--fps", String(safeFps),
    "--quality", safeQuality,
    "--workers", String(safeWorkers),
    "--no-browser-gpu",
    // Lint errors fail the render instead of producing a broken video.
    // (Not --quiet: its output is where the reason for a failure is.)
    "--strict",
  ];
  if (entry && entry !== "index.html") args.push("-c", entry);
  return args;
}

export function buildProbeArgs(file) {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
}

/** Reads ffprobe's JSON: the length in seconds and the first video stream's size. */
export function parseProbe(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((s) => s?.codec_type === "video") ?? null;
  const duration = Number(parsed?.format?.duration ?? video?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    width: Number.isFinite(Number(video?.width)) ? Number(video.width) : null,
    height: Number.isFinite(Number(video?.height)) ? Number(video.height) : null,
    hasVideo: Boolean(video),
  };
}

/** `hyperframes check --json` prints one JSON object; anything before it is progress text. */
export function parseCheckReport(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

const TAIL_BYTES = 64 * 1024;

/** Keeps only the last TAIL_BYTES of a stream: a long render prints a lot, and the reason for a failure is at the end. */
function tailBuffer() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > TAIL_BYTES * 2) buf = buf.subarray(buf.length - TAIL_BYTES);
    },
    text() {
      return (buf.length > TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : buf).toString("utf8");
    },
  };
}

/** Hyperframes prints `@hf-progress {"code":"capture","pct":55,...}` lines while it renders. */
export function parseProgressLine(line) {
  if (!line.startsWith("@hf-progress ")) return null;
  try {
    const parsed = JSON.parse(line.slice("@hf-progress ".length));
    const pct = Number(parsed?.pct);
    if (!Number.isFinite(pct)) return null;
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), stage: typeof parsed.code === "string" ? parsed.code : null };
  } catch {
    return null;
  }
}

/**
 * Runs one child to completion. Resolves (never rejects on a non-zero exit)
 * with its exit code, the tail of its output and whether it was stopped by
 * the time limit or a cancel. The whole process group is killed on stop.
 * `onProgress` gets each Hyperframes progress line as it arrives.
 */
export function runProcess(bin, args, { cwd, env, timeoutMs, signal, onProgress }) {
  return new Promise((resolve) => {
    const out = tailBuffer();
    const err = tailBuffer();
    let pendingLine = "";
    let timedOut = false;
    let cancelled = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(error?.message ?? error), timedOut, cancelled });
      return;
    }
    const killGroup = (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      if (!onProgress) return;
      pendingLine += chunk.toString("utf8");
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      if (pendingLine.length > 4096) pendingLine = "";
      for (const line of lines) {
        const progress = parseProgressLine(line.trim());
        if (progress) onProgress(progress);
      }
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      err.push(Buffer.from(String(error?.message ?? error)));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Leftover helpers (a browser renderer, an ffmpeg) die with the group.
      killGroup("SIGKILL");
      resolve({
        code,
        signal: sig,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        cancelled,
      });
    });
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The last meaningful lines of a child's output, for an error message (never
 * the whole log): colour codes, progress bars, trace lines and the CLI's own
 * advertising line are dropped.
 */
export function tail(text, lines = 12) {
  return String(text ?? "")
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.trim() &&
        !line.startsWith("@hf-progress") &&
        !line.startsWith("[INFO]") &&
        !line.includes("█") &&
        !line.includes("hyperframes.dev/studio"),
    )
    .slice(-lines)
    .join("\n")
    .slice(-2_000);
}

/** The picture a snapshot job hands back: Hyperframes' contact sheet, else the first frame. */
export async function pickSnapshotOutput(outDir) {
  const names = (await readdir(outDir).catch(() => [])).sort();
  const sheet = names.find((n) => n === "contact-sheet.jpg") ?? names.find((n) => /^contact-sheet-1\.jpg$/.test(n));
  if (sheet) return { file: join(outDir, sheet), contentType: "image/jpeg", frames: names.filter((n) => n.endsWith(".png")).length };
  const frame = names.find((n) => n.endsWith(".png"));
  if (frame) return { file: join(outDir, frame), contentType: "image/png", frames: names.filter((n) => n.endsWith(".png")).length };
  return null;
}
