/**
 * Media Studio code-rendered videos (D14): the server's client for the
 * locked-down render worker (docker/render-worker, overlay
 * docker/docker-compose.render-worker.yml). Holds the
 * `PAPERCLIP_SERVER_RENDER_WORKER_TOKEN` bearer token -- never sent to an
 * agent, kept out of agent envs the same way as every other
 * `PAPERCLIP_SERVER_` variable (`packages/adapter-utils/src/server-env-secrets.ts`).
 *
 * Production talks over the Unix socket on the shared `render-control` volume
 * (`PAPERCLIP_SERVER_RENDER_WORKER_SOCKET`): the worker runs with no network
 * at all, so there is no network path to it (or from it). A plain HTTP URL
 * (`PAPERCLIP_SERVER_RENDER_WORKER_URL`) is accepted for local runs; when both
 * are set the socket wins. Same shape as browser-worker-client.ts.
 *
 * The worker's job API (docker/render-worker/README.md "Job API"):
 *   POST /v1/jobs, GET /v1/jobs/:id, GET /v1/jobs/:id/output, DELETE /v1/jobs/:id
 *
 * A finished video can be 2 GB (D18), so the output is never read into
 * memory: downloadOutput streams it straight to a file on the server's disk,
 * counting bytes against the limit as they arrive, and the caller streams
 * that file into storage.
 */

import { createWriteStream, promises as fs } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type CodeRenderWorkerStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface CodeRenderWorkerJob {
  id: string;
  kind: "check" | "snapshot" | "render";
  status: CodeRenderWorkerStatus;
  progress: { pct: number; stage: string | null } | null;
  error: string | null;
  /** When the worker started and stopped running it (ISO); what failed and cancelled jobs are charged by. */
  startedAt?: string | null;
  finishedAt?: string | null;
  result: {
    passed: boolean | null;
    report: Record<string, unknown> | null;
    outputContentType: string | null;
    outputBytes: number | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    frames: number | null;
  } | null;
}

export interface CodeRenderWorkerSubmission {
  kind: "check" | "snapshot" | "render";
  /** Opaque, for the worker's own log line only (letters, digits, " ._:-"). */
  label: string;
  composition: { entry: string; files: Array<{ path: string; contentBase64: string }> };
  options: { fps?: number; quality?: string; frames?: number; maxDurationSeconds?: number };
}

export interface CodeRenderWorkerOutput {
  contentType: string;
  /** Bytes written to the file. */
  bytes: number;
}

export interface CodeRenderWorkerClient {
  /** False until the overlay is deployed and the server has the socket/URL and token. */
  readonly configured: boolean;
  submit(job: CodeRenderWorkerSubmission): Promise<CodeRenderWorkerJob>;
  /** null when the worker does not know the job (it restarted, or the result expired). */
  get(workerJobId: string): Promise<CodeRenderWorkerJob | null>;
  /**
   * Streams a finished job's file to `filePath` (created new, never
   * overwritten) without holding it in memory. Refuses more than `maxBytes`,
   * and a download that ends short; nothing is left at `filePath` on failure.
   */
  downloadOutput(workerJobId: string, maxBytes: number, filePath: string): Promise<CodeRenderWorkerOutput>;
  /**
   * Cancels a running job, or frees a finished job's files on the worker.
   * Answers the job as the worker last saw it, or null for an unknown job;
   * never throws on "unknown job".
   */
  release(workerJobId: string): Promise<CodeRenderWorkerJob | null>;
}

/**
 * A refusal or failure from the worker. `status` is the worker's HTTP status
 * (422 = the composition broke a rule, 429 = queue full, 413 = too large),
 * `code` its machine-readable reason.
 */
export class CodeRenderWorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "CodeRenderWorkerError";
  }
}

export class CodeRenderWorkerNotConfiguredError extends Error {
  constructor() {
    super(
      "Code-drawn videos are not set up on this server yet: the render worker container has not been added. " +
        "An operator adds it once (docker/render-worker/README.md, \"Operator steps\").",
    );
    this.name = "CodeRenderWorkerNotConfiguredError";
  }
}

export interface HttpCodeRenderWorkerClientConfig {
  /** Unix socket on the shared render-control volume. Wins over baseUrl. */
  socketPath?: string;
  /** http:// URL, for local runs only. */
  baseUrl?: string;
  token: string;
  /** Per request; the job API itself is asynchronous, so requests are short. Default 2 minutes. */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const WORKER_JOB_ID_PATTERN = /^[0-9a-f-]{36}$/;

function assertWorkerJobId(id: string): string {
  if (!WORKER_JOB_ID_PATTERN.test(id)) throw new CodeRenderWorkerError("Bad render worker job id", 400, "bad_id");
  return id;
}

function parseJson(response: RawResponse): unknown {
  if (response.body.length === 0) return null;
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return null;
  }
}

function errorFrom(response: RawResponse, path: string): CodeRenderWorkerError {
  const parsed = parseJson(response) as { error?: unknown; message?: unknown; details?: unknown } | null;
  const message =
    typeof parsed?.message === "string" && parsed.message
      ? parsed.message
      : `The render worker refused ${path} (${response.status}).`;
  return new CodeRenderWorkerError(message, response.status, typeof parsed?.error === "string" ? parsed.error : null, parsed?.details ?? null);
}

export class HttpCodeRenderWorkerClient implements CodeRenderWorkerClient {
  readonly configured = true;

  constructor(private readonly config: HttpCodeRenderWorkerClientConfig) {
    if (!config.socketPath && !config.baseUrl) throw new Error("HttpCodeRenderWorkerClient needs socketPath or baseUrl");
    if (!config.socketPath && config.baseUrl && !config.baseUrl.startsWith("http://")) {
      throw new Error("PAPERCLIP_SERVER_RENDER_WORKER_URL must be an http:// URL (local runs only)");
    }
  }

  /**
   * Opens one request and hands back the response as it starts arriving.
   * The timeout is for silence on the connection, not for the whole answer,
   * so a long download keeps going while bytes flow.
   */
  private open(method: string, path: string, body: Buffer | null): Promise<IncomingMessage> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}` };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(body.length);
    }
    const target = this.config.socketPath
      ? { socketPath: this.config.socketPath, path }
      : (() => {
          const url = new URL(path, this.config.baseUrl);
          return { host: url.hostname, port: url.port ? Number(url.port) : 80, path: `${url.pathname}${url.search}` };
        })();
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest({ ...target, method, headers, timeout: timeoutMs }, resolve);
      req.on("timeout", () => req.destroy(new Error(`The render worker did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
      req.on("error", (error) => reject(new CodeRenderWorkerError(`The render worker could not be reached: ${error.message}`, 502, "unreachable")));
      if (body) req.write(body);
      req.end();
    });
  }

  /** Reads a whole (small) answer into memory, refusing more than maxBytes. */
  private readAll(res: IncomingMessage, maxBytes: number): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new CodeRenderWorkerError(`The render worker's answer is larger than ${maxBytes} bytes.`, 413, "too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (error) => reject(new CodeRenderWorkerError(`The render worker's answer broke off: ${error.message}`, 502, "unreachable")));
      res.on("aborted", () => reject(new CodeRenderWorkerError("The render worker's answer broke off.", 502, "unreachable")));
    });
  }

  private async request(method: string, path: string, body: Buffer | null, maxBytes: number): Promise<RawResponse> {
    return this.readAll(await this.open(method, path, body), maxBytes);
  }

  async submit(job: CodeRenderWorkerSubmission): Promise<CodeRenderWorkerJob> {
    const response = await this.request("POST", "/v1/jobs", Buffer.from(JSON.stringify(job), "utf8"), JSON_RESPONSE_MAX_BYTES);
    if (response.status !== 202 && response.status !== 200) throw errorFrom(response, "the job");
    return parseJson(response) as CodeRenderWorkerJob;
  }

  async get(workerJobId: string): Promise<CodeRenderWorkerJob | null> {
    const response = await this.request("GET", `/v1/jobs/${assertWorkerJobId(workerJobId)}`, null, JSON_RESPONSE_MAX_BYTES);
    if (response.status === 404) return null;
    if (response.status !== 200) throw errorFrom(response, "a status check");
    return parseJson(response) as CodeRenderWorkerJob;
  }

  async downloadOutput(workerJobId: string, maxBytes: number, filePath: string): Promise<CodeRenderWorkerOutput> {
    const res = await this.open("GET", `/v1/jobs/${assertWorkerJobId(workerJobId)}/output`, null);
    if (res.statusCode !== 200) throw errorFrom(await this.readAll(res, JSON_RESPONSE_MAX_BYTES), "the finished file");
    const contentType = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const declared = Number(res.headers["content-length"] ?? Number.NaN);
    const tooLarge = () => new CodeRenderWorkerError(`The finished file is larger than the ${maxBytes} bytes the server accepts.`, 413, "too_large");
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw tooLarge();
    }
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? tooLarge() : null, chunk);
      },
    });
    // The worker closing the connection early must fail the copy, not end it quietly.
    res.on("aborted", () => res.destroy(new Error("the connection closed before the whole file arrived")));
    // "wx": a file already at filePath is never overwritten, nor removed on failure.
    const target = createWriteStream(filePath, { flags: "wx" });
    let created = false;
    target.once("open", () => {
      created = true;
    });
    try {
      await pipeline(res, counter, target);
      if (Number.isFinite(declared) && bytes !== declared) {
        throw new CodeRenderWorkerError(`The finished file arrived incomplete (${bytes} of ${declared} bytes).`, 502, "incomplete");
      }
    } catch (error) {
      res.destroy();
      if (created) await fs.rm(filePath, { force: true }).catch(() => undefined);
      if (error instanceof CodeRenderWorkerError) throw error;
      throw new CodeRenderWorkerError(`The finished file could not be copied from the render worker: ${error instanceof Error ? error.message : String(error)}`, 502, "incomplete");
    }
    return { contentType, bytes };
  }

  async release(workerJobId: string): Promise<CodeRenderWorkerJob | null> {
    const response = await this.request("DELETE", `/v1/jobs/${assertWorkerJobId(workerJobId)}`, null, JSON_RESPONSE_MAX_BYTES);
    if (response.status === 404) return null;
    if (response.status !== 200) throw errorFrom(response, "a cancel");
    return parseJson(response) as CodeRenderWorkerJob | null;
  }
}

/** Refuses every call: the safe default before the overlay is deployed. */
export class UnconfiguredCodeRenderWorkerClient implements CodeRenderWorkerClient {
  readonly configured = false;
  submit(): Promise<CodeRenderWorkerJob> {
    return Promise.reject(new CodeRenderWorkerNotConfiguredError());
  }
  get(): Promise<CodeRenderWorkerJob | null> {
    return Promise.reject(new CodeRenderWorkerNotConfiguredError());
  }
  downloadOutput(): Promise<CodeRenderWorkerOutput> {
    return Promise.reject(new CodeRenderWorkerNotConfiguredError());
  }
  release(): Promise<CodeRenderWorkerJob | null> {
    return Promise.resolve(null);
  }
}

export function createCodeRenderWorkerClientFromEnv(env: NodeJS.ProcessEnv = process.env): CodeRenderWorkerClient {
  const socketPath = env.PAPERCLIP_SERVER_RENDER_WORKER_SOCKET?.trim();
  const baseUrl = env.PAPERCLIP_SERVER_RENDER_WORKER_URL?.trim();
  const token = env.PAPERCLIP_SERVER_RENDER_WORKER_TOKEN?.trim();
  if (!token || (!socketPath && !baseUrl)) return new UnconfiguredCodeRenderWorkerClient();
  return new HttpCodeRenderWorkerClient({ socketPath: socketPath || undefined, baseUrl: baseUrl || undefined, token });
}
