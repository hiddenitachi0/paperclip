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
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

export type CodeRenderWorkerStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface CodeRenderWorkerJob {
  id: string;
  kind: "check" | "snapshot" | "render";
  status: CodeRenderWorkerStatus;
  progress: { pct: number; stage: string | null } | null;
  error: string | null;
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
  body: Buffer;
  contentType: string;
}

export interface CodeRenderWorkerClient {
  /** False until the overlay is deployed and the server has the socket/URL and token. */
  readonly configured: boolean;
  submit(job: CodeRenderWorkerSubmission): Promise<CodeRenderWorkerJob>;
  /** null when the worker does not know the job (it restarted, or the result expired). */
  get(workerJobId: string): Promise<CodeRenderWorkerJob | null>;
  fetchOutput(workerJobId: string, maxBytes: number): Promise<CodeRenderWorkerOutput>;
  /** Cancels a running job, or frees a finished job's files on the worker. Never throws on "unknown job". */
  release(workerJobId: string): Promise<void>;
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

  private request(method: string, path: string, body: Buffer | null, maxBytes: number): Promise<RawResponse> {
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
    return new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest({ ...target, method, headers, timeout: timeoutMs }, (res) => {
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
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`The render worker did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
      req.on("error", (error) => reject(error instanceof CodeRenderWorkerError ? error : new CodeRenderWorkerError(`The render worker could not be reached: ${error.message}`, 502, "unreachable")));
      if (body) req.write(body);
      req.end();
    });
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

  async fetchOutput(workerJobId: string, maxBytes: number): Promise<CodeRenderWorkerOutput> {
    const response = await this.request("GET", `/v1/jobs/${assertWorkerJobId(workerJobId)}/output`, null, maxBytes);
    if (response.status !== 200) throw errorFrom(response, "the finished file");
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    return { body: response.body, contentType };
  }

  async release(workerJobId: string): Promise<void> {
    const response = await this.request("DELETE", `/v1/jobs/${assertWorkerJobId(workerJobId)}`, null, JSON_RESPONSE_MAX_BYTES);
    if (response.status !== 200 && response.status !== 404) throw errorFrom(response, "a cancel");
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
  fetchOutput(): Promise<CodeRenderWorkerOutput> {
    return Promise.reject(new CodeRenderWorkerNotConfiguredError());
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}

export function createCodeRenderWorkerClientFromEnv(env: NodeJS.ProcessEnv = process.env): CodeRenderWorkerClient {
  const socketPath = env.PAPERCLIP_SERVER_RENDER_WORKER_SOCKET?.trim();
  const baseUrl = env.PAPERCLIP_SERVER_RENDER_WORKER_URL?.trim();
  const token = env.PAPERCLIP_SERVER_RENDER_WORKER_TOKEN?.trim();
  if (!token || (!socketPath && !baseUrl)) return new UnconfiguredCodeRenderWorkerClient();
  return new HttpCodeRenderWorkerClient({ socketPath: socketPath || undefined, baseUrl: baseUrl || undefined, token });
}
