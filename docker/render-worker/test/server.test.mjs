import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMPOSITION_LIMITS } from "../src/composition.mjs";
import { JobFailure, createJobManager } from "../src/jobs.mjs";
import { createHandler, isAuthorized, main } from "../src/server.mjs";

const TOKEN = "k".repeat(48);
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const composition = (html = "<html><body>hi</body></html>") => ({ files: [{ path: "index.html", contentBase64: b64(html) }] });

function testConfig(jobsDir) {
  return {
    jobsDir,
    concurrency: 1,
    maxQueue: 2,
    maxDurationSeconds: 120,
    maxBodyBytes: 64 * 1024,
    maxOutputBytes: 1024 * 1024,
    resultTtlMs: 60_000,
    compositionLimits: DEFAULT_COMPOSITION_LIMITS,
  };
}

/** A runner that "renders" by writing a small file, or waits until released. */
function fakeRunner() {
  const gates = [];
  const calls = [];
  const runner = async (job, { signal }) => {
    calls.push({ kind: job.kind, options: job.options, entry: job.entry });
    if (job.label === "slow") {
      await new Promise((resolve, reject) => {
        gates.push(resolve);
        signal.addEventListener("abort", () => reject(new JobFailure("The job was cancelled.")), { once: true });
      });
    }
    if (job.label === "broken") throw new JobFailure("The render failed.\nlint: missing duration");
    if (job.kind === "check") return { passed: true, report: { ok: true, errorCount: 0 } };
    const outputFile = join(job.paths.out, job.kind === "render" ? "video.mp4" : "contact-sheet.jpg");
    await writeFile(outputFile, job.kind === "render" ? "MP4DATA" : "JPGDATA");
    return {
      outputFile,
      outputContentType: job.kind === "render" ? "video/mp4" : "image/jpeg",
      outputBytes: 7,
      durationSeconds: job.kind === "render" ? 20 : null,
      width: 1920,
      height: 1080,
    };
  };
  return { runner, calls, releaseAll: () => gates.splice(0).forEach((g) => g()) };
}

describe("render worker HTTP API", () => {
  let dir;
  let server;
  let base;
  let fake;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "render-worker-test-"));
    fake = fakeRunner();
    const config = testConfig(dir);
    const manager = createJobManager({ config, runner: fake.runner });
    server = createServer(createHandler({ config, manager, token: TOKEN }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    fake.releaseAll();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  async function waitFor(id, statuses) {
    for (let i = 0; i < 100; i += 1) {
      const job = await (await call(`/v1/jobs/${id}`)).json();
      if (statuses.includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`job ${id} never reached ${statuses.join("/")}`);
  }

  it("answers /healthz without a token and refuses /v1 without one", async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/jobs`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/v1/status`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  });

  it("isAuthorized needs the exact bearer token", () => {
    assert.equal(isAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(isAuthorized(`Bearer ${TOKEN}x`, TOKEN), false);
    assert.equal(isAuthorized(TOKEN, TOKEN), false);
    assert.equal(isAuthorized(undefined, TOKEN), false);
  });

  it("renders: submit, poll, fetch the MP4, release", async () => {
    const res = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "render", composition: composition(), options: { fps: 24, maxDurationSeconds: 9999 } }) });
    assert.equal(res.status, 202);
    const submitted = await res.json();
    assert.ok(["queued", "running", "done"].includes(submitted.status));
    const done = await waitFor(submitted.id, ["done"]);
    assert.equal(done.result.outputContentType, "video/mp4");
    assert.equal(done.result.durationSeconds, 20);
    // Clamped to the worker's own ceiling.
    assert.equal(fake.calls.at(-1).options.maxDurationSeconds, 120);
    assert.equal(fake.calls.at(-1).options.fps, 24);

    const output = await call(`/v1/jobs/${submitted.id}/output`);
    assert.equal(output.status, 200);
    assert.equal(output.headers.get("content-type"), "video/mp4");
    assert.equal(await output.text(), "MP4DATA");

    const released = await call(`/v1/jobs/${submitted.id}`, { method: "DELETE" });
    assert.equal(released.status, 200);
    assert.equal((await call(`/v1/jobs/${submitted.id}/output`)).status, 404);
    assert.equal(existsSync(join(dir, submitted.id)), false);
  });

  it("returns a check report", async () => {
    const res = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "check", composition: composition() }) });
    const job = await waitFor((await res.json()).id, ["done"]);
    assert.equal(job.result.passed, true);
    assert.deepEqual(job.result.report, { ok: true, errorCount: 0 });
  });

  it("reports a failed render with the tool's reason", async () => {
    const res = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "render", label: "broken", composition: composition() }) });
    const job = await waitFor((await res.json()).id, ["failed"]);
    assert.match(job.error, /missing duration/);
    assert.equal(job.result, null);
  });

  it("refuses a composition that loads from the internet (422) and a bad path", async () => {
    const remote = await call("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "render", composition: composition('<img src="http://169.254.169.254/latest/meta-data">') }),
    });
    assert.equal(remote.status, 422);
    const body = await remote.json();
    assert.equal(body.error, "remote_urls");
    assert.match(body.message, /169\.254\.169\.254/);

    const traversal = await call("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "render", composition: { files: [{ path: "../escape.html", contentBase64: b64("x") }], entry: "../escape.html" } }),
    });
    assert.equal(traversal.status, 422);
    // Nothing was written for refused jobs.
    const leftovers = (await readdir(dir)).length;
    assert.ok(leftovers <= 1);
  });

  it("refuses an unknown kind, bad JSON and an oversized body", async () => {
    assert.equal((await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "shell", composition: composition() }) })).status, 422);
    assert.equal((await call("/v1/jobs", { method: "POST", body: "{not json" })).status, 400);
    const big = JSON.stringify({ kind: "render", composition: composition("x".repeat(100 * 1024)) });
    assert.equal((await call("/v1/jobs", { method: "POST", body: big })).status, 413);
  });

  it("queues up to the limit, answers 429 beyond it, and cancels a running job", async () => {
    const slow = await (await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "render", label: "slow", composition: composition() }) })).json();
    await waitFor(slow.id, ["running"]);
    const q1 = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "check", composition: composition() }) });
    const q2 = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "check", composition: composition() }) });
    assert.equal(q1.status, 202);
    assert.equal(q2.status, 202);
    const q3 = await call("/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "check", composition: composition() }) });
    assert.equal(q3.status, 429);

    const cancelled = await (await call(`/v1/jobs/${slow.id}`, { method: "DELETE" })).json();
    assert.equal(cancelled.status, "cancelled");
    await waitFor((await q1.json()).id, ["done"]);
    await waitFor((await q2.json()).id, ["done"]);
    assert.equal((await waitFor(slow.id, ["cancelled"])).status, "cancelled");
  });

  it("answers 404 for an unknown job", async () => {
    assert.equal((await call("/v1/jobs/00000000-0000-4000-8000-000000000000")).status, 404);
  });
});

describe("main() on a Unix socket", () => {
  it("binds the socket owner+group only, clears old job folders and keeps the token out of the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "render-worker-sock-"));
    const jobsDir = join(root, "jobs");
    await mkdir(join(jobsDir, "leftover-from-before"), { recursive: true });
    const socketPath = join(root, "control", "render.sock");
    const env = { RENDER_WORKER_SOCKET: socketPath, RENDER_WORKER_JOBS_DIR: jobsDir, RENDER_WORKER_TOKEN: TOKEN, RENDER_WORKER_VENDOR_DIR: join(root, "none") };
    const server = await main(env);
    try {
      assert.equal(env.RENDER_WORKER_TOKEN, undefined);
      assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
      assert.deepEqual(await readdir(jobsDir), []);
      const get = (path, headers = {}) =>
        new Promise((resolve, reject) => {
          httpRequest({ socketPath, path, headers }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          })
            .on("error", reject)
            .end();
        });
      assert.equal(await get("/healthz"), 200);
      assert.equal(await get("/v1/status"), 401);
      assert.equal(await get("/v1/status", { Authorization: `Bearer ${TOKEN}` }), 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      await rm(root, { recursive: true, force: true });
    }
  });
});
