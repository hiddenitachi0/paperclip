/**
 * The server's client for the render worker, against a fake worker over a
 * real Unix socket (production transport) and over TCP (local runs).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CodeRenderWorkerError,
  CodeRenderWorkerNotConfiguredError,
  HttpCodeRenderWorkerClient,
  UnconfiguredCodeRenderWorkerClient,
  createCodeRenderWorkerClientFromEnv,
} from "../services/code-render-worker-client.js";

const TOKEN = "t".repeat(48);
const JOB_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
/** Its output is sent in many chunks without a Content-Length (chunked encoding). */
const CHUNKED_JOB_ID = "1f1e2d3c-4b5a-4968-8776-655443322111";
/** Its output promises more bytes than it sends, then the connection drops. */
const TRUNCATED_JOB_ID = "2f1e2d3c-4b5a-4968-8776-655443322112";
const CHUNK = Buffer.alloc(64 * 1024, 1);
const CHUNK_COUNT = 40;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

function fakeWorker(seen: Seen[]) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized", message: "Missing or wrong token." });
    if (req.method === "POST" && req.url === "/v1/jobs") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.label === "remote") return json(422, { error: "remote_urls", message: "The composition loads files from the internet", details: { urls: [{ url: "https://x.test" }] } });
      if (body.label === "busy") return json(429, { error: "busy", message: "The renderer is busy" });
      return json(202, { id: JOB_ID, kind: body.kind, status: "queued", progress: null, error: null, result: null });
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${JOB_ID}`) {
      return json(200, { id: JOB_ID, kind: "render", status: "running", progress: { pct: 40, stage: "capture" }, error: null, result: null });
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${JOB_ID}/output`) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "9" });
      res.end("MP4-BYTES");
      return;
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${CHUNKED_JOB_ID}/output`) {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      for (let i = 0; i < CHUNK_COUNT; i += 1) {
        if (!res.write(CHUNK)) await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${TRUNCATED_JOB_ID}/output`) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "1000" });
      res.write("only part of it");
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    if (req.method === "DELETE" && req.url === `/v1/jobs/${JOB_ID}`) {
      return json(200, { id: JOB_ID, status: "cancelled", startedAt: "2026-10-28T10:00:00.000Z", finishedAt: "2026-10-28T10:02:00.000Z" });
    }
    return json(404, { error: "unknown_job", message: "Unknown job." });
  });
}

describe("HttpCodeRenderWorkerClient", () => {
  let dir: string;
  let socketServer: Server;
  let tcpServer: Server;
  let tcpUrl: string;
  const seen: Seen[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-render-client-"));
    socketServer = fakeWorker(seen);
    await new Promise<void>((resolve) => socketServer.listen(join(dir, "render.sock"), resolve));
    tcpServer = fakeWorker(seen);
    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
    const address = tcpServer.address();
    tcpUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => socketServer.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const overSocket = () => new HttpCodeRenderWorkerClient({ socketPath: join(dir, "render.sock"), token: TOKEN });

  it("submits over the Unix socket with the bearer token and the composition", async () => {
    const job = await overSocket().submit({
      kind: "render",
      label: "paperclip job",
      composition: { entry: "index.html", files: [{ path: "index.html", contentBase64: "PGh0bWw+" }] },
      options: { fps: 30, maxDurationSeconds: 20 },
    });
    expect(job).toMatchObject({ id: JOB_ID, status: "queued" });
    const last = seen.at(-1)!;
    expect(last.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(last.body)).toMatchObject({ kind: "render", options: { maxDurationSeconds: 20 } });
  });

  it("reads status and progress, downloads the output to a file and releases the job", async () => {
    const client = overSocket();
    expect(await client.get(JOB_ID)).toMatchObject({ status: "running", progress: { pct: 40 } });
    const file = join(dir, "output-basic.mp4");
    const output = await client.downloadOutput(JOB_ID, 1024, file);
    expect(output).toEqual({ contentType: "video/mp4", bytes: 9 });
    expect(await readFile(file, "utf8")).toBe("MP4-BYTES");
    // The worker's last view of the job: what a cancelled job is charged by.
    expect(await client.release(JOB_ID)).toMatchObject({ status: "cancelled", startedAt: "2026-10-28T10:00:00.000Z", finishedAt: "2026-10-28T10:02:00.000Z" });
    expect(seen.at(-1)!.method).toBe("DELETE");
    expect(await client.release("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBeNull();
  });

  it("streams a large output to disk chunk by chunk (D18: never held in memory)", async () => {
    const file = join(dir, "output-chunked.mp4");
    const output = await overSocket().downloadOutput(CHUNKED_JOB_ID, CHUNK.length * CHUNK_COUNT, file);
    expect(output).toEqual({ contentType: "video/mp4", bytes: CHUNK.length * CHUNK_COUNT });
    const written = await readFile(file);
    expect(written.length).toBe(CHUNK.length * CHUNK_COUNT);
    expect(written.every((b) => b === 1)).toBe(true);
  });

  it("never overwrites an existing file", async () => {
    const file = join(dir, "output-basic.mp4");
    await expect(overSocket().downloadOutput(JOB_ID, 1024, file)).rejects.toMatchObject({ status: 502 });
    expect(await readFile(file, "utf8")).toBe("MP4-BYTES");
  });

  it("answers null for a job the worker does not know", async () => {
    expect(await overSocket().get("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBeNull();
  });

  it("turns refusals into CodeRenderWorkerError with the worker's status and reason", async () => {
    const client = overSocket();
    const base = { kind: "render" as const, composition: { entry: "index.html", files: [] }, options: {} };
    await expect(client.submit({ ...base, label: "remote" })).rejects.toMatchObject({ status: 422, code: "remote_urls" });
    await expect(client.submit({ ...base, label: "busy" })).rejects.toMatchObject({ status: 429, code: "busy" });
    const wrong = new HttpCodeRenderWorkerClient({ socketPath: join(dir, "render.sock"), token: "wrong".repeat(10) });
    await expect(wrong.get(JOB_ID)).rejects.toBeInstanceOf(CodeRenderWorkerError);
  });

  it("refuses an output larger than asked for, by its Content-Length or while it streams, and leaves no file", async () => {
    const declared = join(dir, "output-declared-too-large.mp4");
    await expect(overSocket().downloadOutput(JOB_ID, 4, declared)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(existsSync(declared)).toBe(false);
    const streamed = join(dir, "output-streamed-too-large.mp4");
    await expect(overSocket().downloadOutput(CHUNKED_JOB_ID, CHUNK.length * 3, streamed)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(existsSync(streamed)).toBe(false);
  });

  it("fails a download that breaks off, and leaves no partial file", async () => {
    const file = join(dir, "output-truncated.mp4");
    await expect(overSocket().downloadOutput(TRUNCATED_JOB_ID, 4096, file)).rejects.toMatchObject({ status: 502, code: "incomplete" });
    expect(existsSync(file)).toBe(false);
  });

  it("passes on the worker's refusal of the output", async () => {
    const file = join(dir, "output-unknown.mp4");
    await expect(overSocket().downloadOutput("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 4096, file)).rejects.toMatchObject({ status: 404, code: "unknown_job" });
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a malformed worker job id before sending anything", async () => {
    const before = seen.length;
    await expect(overSocket().get("../../etc/passwd")).rejects.toMatchObject({ code: "bad_id" });
    expect(seen.length).toBe(before);
  });

  it("works over plain HTTP for local runs, and only http://", async () => {
    const client = new HttpCodeRenderWorkerClient({ baseUrl: tcpUrl, token: TOKEN });
    expect(await client.get(JOB_ID)).toMatchObject({ status: "running" });
    expect(() => new HttpCodeRenderWorkerClient({ baseUrl: "https://example.com", token: TOKEN })).toThrow(/http:\/\//);
  });

  it("reports an unreachable worker as a 502-style error", async () => {
    const client = new HttpCodeRenderWorkerClient({ socketPath: join(dir, "missing.sock"), token: TOKEN });
    await expect(client.get(JOB_ID)).rejects.toMatchObject({ status: 502, code: "unreachable" });
  });
});

describe("createCodeRenderWorkerClientFromEnv", () => {
  it("is unconfigured without a token or an address", async () => {
    for (const env of [{}, { PAPERCLIP_SERVER_RENDER_WORKER_TOKEN: TOKEN }, { PAPERCLIP_SERVER_RENDER_WORKER_SOCKET: "/run/x.sock" }]) {
      const client = createCodeRenderWorkerClientFromEnv(env as NodeJS.ProcessEnv);
      expect(client.configured).toBe(false);
      expect(client).toBeInstanceOf(UnconfiguredCodeRenderWorkerClient);
      await expect(client.get(JOB_ID)).rejects.toBeInstanceOf(CodeRenderWorkerNotConfiguredError);
    }
  });

  it("is configured with a socket (or URL) and a token", () => {
    const client = createCodeRenderWorkerClientFromEnv({
      PAPERCLIP_SERVER_RENDER_WORKER_SOCKET: "/run/render-control/render.sock",
      PAPERCLIP_SERVER_RENDER_WORKER_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv);
    expect(client.configured).toBe(true);
  });
});
