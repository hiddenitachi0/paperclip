// Paperclip render worker: settings, read once at start from the
// environment. Every number has a safe default and a ceiling, so a typo in
// the compose file cannot turn a limit off.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COMPOSITION_LIMITS } from "./composition.mjs";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function intFrom(env, name, fallback, min, max) {
  const raw = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/**
 * The bearer token Paperclip presents. Read from a file when one is named
 * (Docker secret), else from RENDER_WORKER_TOKEN, which is then removed from
 * this process's environment so no child can ever inherit it.
 */
export function readToken(env) {
  let token = "";
  if (env.RENDER_WORKER_TOKEN_FILE) {
    token = readFileSync(env.RENDER_WORKER_TOKEN_FILE, "utf8").trim();
  } else if (env.RENDER_WORKER_TOKEN) {
    token = env.RENDER_WORKER_TOKEN.trim();
  }
  delete env.RENDER_WORKER_TOKEN;
  if (token.length < 32) {
    throw new Error("RENDER_WORKER_TOKEN (or RENDER_WORKER_TOKEN_FILE) must hold a random token of at least 32 characters.");
  }
  return token;
}

export function loadConfig(env = process.env) {
  const maxDurationSeconds = intFrom(env, "RENDER_WORKER_MAX_DURATION_SECONDS", 1800, 1, 7200);
  return {
    // A Unix socket path wins over host/port (production uses the socket; TCP is for local runs).
    socketPath: env.RENDER_WORKER_SOCKET?.trim() || null,
    host: env.RENDER_WORKER_HOST || "127.0.0.1",
    port: intFrom(env, "RENDER_WORKER_PORT", 8790, 1, 65535),
    jobsDir: env.RENDER_WORKER_JOBS_DIR || "/work/jobs",
    concurrency: intFrom(env, "RENDER_WORKER_CONCURRENCY", 1, 1, 4),
    maxQueue: intFrom(env, "RENDER_WORKER_MAX_QUEUE", 8, 0, 100),
    renderWorkers: intFrom(env, "RENDER_WORKER_BROWSERS_PER_JOB", 2, 1, 4),
    // The ceiling for any one job; each kind has its own, shorter budget below.
    jobTimeoutMs: intFrom(env, "RENDER_WORKER_JOB_TIMEOUT_SECONDS", 1800, 30, 4 * 3600) * 1000,
    // A check or contact sheet does not render the whole video: a few minutes is plenty.
    checkTimeoutMs: intFrom(env, "RENDER_WORKER_CHECK_TIMEOUT_SECONDS", 180, 30, 4 * 3600) * 1000,
    snapshotTimeoutMs: intFrom(env, "RENDER_WORKER_SNAPSHOT_TIMEOUT_SECONDS", 300, 30, 4 * 3600) * 1000,
    // A render may take this long to start, plus this many seconds per second
    // of video it asked for: a job that asks for 1 second cannot hold the
    // renderer for half an hour.
    renderBaseTimeoutMs: intFrom(env, "RENDER_WORKER_RENDER_BASE_SECONDS", 120, 10, 3600) * 1000,
    renderTimeoutPerVideoSecond: intFrom(env, "RENDER_WORKER_RENDER_SECONDS_PER_VIDEO_SECOND", 8, 1, 120),
    maxDurationSeconds,
    maxBodyBytes: intFrom(env, "RENDER_WORKER_MAX_BODY_MB", 300, 1, 4096) * 1024 * 1024,
    maxOutputBytes: intFrom(env, "RENDER_WORKER_MAX_OUTPUT_MB", 2048, 1, 8192) * 1024 * 1024,
    resultTtlMs: intFrom(env, "RENDER_WORKER_RESULT_TTL_SECONDS", 3600, 60, 7 * 24 * 3600) * 1000,
    compositionLimits: {
      ...DEFAULT_COMPOSITION_LIMITS,
      maxFiles: intFrom(env, "RENDER_WORKER_MAX_FILES", DEFAULT_COMPOSITION_LIMITS.maxFiles, 1, 2000),
      maxTotalBytes: intFrom(env, "RENDER_WORKER_MAX_COMPOSITION_MB", DEFAULT_COMPOSITION_LIMITS.maxTotalBytes / 1024 / 1024, 1, 4096) * 1024 * 1024,
    },
    hyperframesBin: env.HYPERFRAMES_BIN || join(PACKAGE_DIR, "node_modules", ".bin", "hyperframes"),
    ffprobeBin: env.FFPROBE_BIN || "ffprobe",
    browserPath: env.HYPERFRAMES_BROWSER_PATH || null,
    vendorDir: env.RENDER_WORKER_VENDOR_DIR || join(PACKAGE_DIR, "vendor"),
  };
}
