// Paperclip render worker: the HTTP API Paperclip's server calls, over a
// Unix socket on the shared `render-control` volume in production (see
// docker/docker-compose.render-worker.yml and ../README.md "Job API").
//
//   GET    /healthz               liveness, no token (says nothing about jobs)
//   POST   /v1/jobs               submit { kind, composition, options, label }
//   GET    /v1/jobs/:id           status + result summary
//   GET    /v1/jobs/:id/output    the finished file (MP4 or contact sheet)
//   DELETE /v1/jobs/:id           cancel, or release a finished job's files
//
// Every /v1 route needs `Authorization: Bearer <token>`.

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CompositionError } from "./composition.mjs";
import { loadConfig, readToken } from "./config.mjs";
import { QueueFullError, createHyperframesRunner, createJobManager } from "./jobs.mjs";

export const WORKER_API_VERSION = 1;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time bearer check (hashing first makes the lengths equal). */
export function isAuthorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length).trim()), digest(token));
}

async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "too_large", `The request is larger than ${maxBytes} bytes.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "too_large", `The request is larger than ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "The request body is not valid JSON.");
  }
}

const JOB_PATH = /^\/v1\/jobs\/([0-9a-f-]{36})(\/output)?$/;

/** The request handler, separate from listen() so tests can drive it. */
export function createHandler({ config, manager, token }) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://worker.local");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        sendJson(res, 200, { ok: true, apiVersion: WORKER_API_VERSION });
        return;
      }
      if (!path.startsWith("/v1/")) throw new HttpError(404, "not_found", "Not found.");
      if (!isAuthorized(req.headers.authorization, token)) throw new HttpError(401, "unauthorized", "Missing or wrong token.");

      if (path === "/v1/status" && req.method === "GET") {
        sendJson(res, 200, { ok: true, apiVersion: WORKER_API_VERSION, queue: manager.counts(), maxDurationSeconds: config.maxDurationSeconds });
        return;
      }

      if (path === "/v1/jobs" && req.method === "POST") {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const job = await manager.submit(body);
        sendJson(res, 202, job);
        return;
      }

      const match = JOB_PATH.exec(path);
      if (!match) throw new HttpError(404, "not_found", "Not found.");
      const id = match[1];

      if (match[2]) {
        if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
        const out = manager.output(id);
        if (!out) throw new HttpError(404, "no_output", "This job has no output to fetch (not finished, failed, or already released).");
        const info = await stat(out.file).catch(() => null);
        if (!info) throw new HttpError(404, "no_output", "The output file is gone.");
        res.writeHead(200, {
          "Content-Type": out.contentType,
          "Content-Length": info.size,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        createReadStream(out.file).on("error", () => res.destroy()).pipe(res);
        return;
      }

      if (req.method === "GET") {
        const job = manager.get(id);
        if (!job) throw new HttpError(404, "unknown_job", "Unknown job (the renderer may have restarted).");
        sendJson(res, 200, job);
        return;
      }
      if (req.method === "DELETE") {
        const job = await manager.cancel(id);
        if (!job) throw new HttpError(404, "unknown_job", "Unknown job.");
        sendJson(res, 200, job);
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
      } else if (error instanceof CompositionError) {
        sendJson(res, 422, { error: error.code, message: error.message, details: error.details ?? null });
      } else if (error instanceof QueueFullError) {
        sendJson(res, 429, { error: "busy", message: error.message });
      } else {
        console.error("[render-worker] request failed:", error);
        if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "The renderer hit an internal error." });
        else res.destroy();
      }
    }
  };
}

/** Leftover job folders from before a restart belong to jobs nobody can ask about any more. */
async function clearJobsDir(jobsDir) {
  await mkdir(jobsDir, { recursive: true });
  for (const name of await readdir(jobsDir)) {
    await rm(join(jobsDir, name), { recursive: true, force: true });
  }
}

export async function main(env = process.env) {
  const token = readToken(env);
  const config = loadConfig(env);
  await clearJobsDir(config.jobsDir);
  const vendorFile = (rel) => join(config.vendorDir, rel);
  const vendorFiles = new Set();
  for (const lib of await readdir(config.vendorDir).catch(() => [])) {
    for (const name of await readdir(join(config.vendorDir, lib)).catch(() => [])) vendorFiles.add(`${lib}/${name}`);
  }
  const manager = createJobManager({
    config,
    runner: createHyperframesRunner(config),
    vendorAvailable: (rel) => vendorFiles.has(rel),
    vendorPath: vendorFile,
  });
  const server = createServer(createHandler({ config, manager, token }));
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 60_000;
  const sweep = setInterval(() => void manager.sweep(), 60_000);
  sweep.unref();

  const shutdown = async (signal) => {
    console.log(`[render-worker] ${signal}: stopping`);
    server.close();
    await manager.drain();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  let where;
  if (config.socketPath) {
    // Production: a Unix socket on the volume shared with Paperclip's server.
    // The container itself has no network at all (network_mode: none), so
    // there is no route from a composition to the server, the database or
    // the internet. A crashed run can leave a stale socket file behind.
    await mkdir(dirname(config.socketPath), { recursive: true });
    await rm(config.socketPath, { force: true });
    await new Promise((resolve) => server.listen(config.socketPath, resolve));
    // Owner (this worker) and group (the server's) only.
    await chmod(config.socketPath, 0o660);
    where = config.socketPath;
  } else {
    await new Promise((resolve) => server.listen(config.port, config.host, resolve));
    where = `${config.host}:${config.port}`;
  }
  console.log(
    `[render-worker] listening on ${where} (concurrency ${config.concurrency}, queue ${config.maxQueue}, ` +
      `max ${config.maxDurationSeconds}s per video, vendored: ${[...vendorFiles].join(", ") || "none"})`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[render-worker] failed to start:", error?.message ?? error);
    process.exit(1);
  });
}
