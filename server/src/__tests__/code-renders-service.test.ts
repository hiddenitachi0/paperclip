/**
 * Media Studio code-rendered videos (D14): the service against a real
 * database with the render worker mocked. Covers the job lifecycle (submit ->
 * worker -> file in Files), company scope, the caps that stop and ask (D7:
 * charged by real length and real renderer time, failed and in-flight jobs
 * included), the budget gate, the single-save claim, and that a finished file
 * goes worker -> temp file -> storage without being held in memory (D18).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, assets, budgetPolicies, codeRenderJobs, companies, createDb, issueAttachments, issues } from "@paperclipai/db";
import type {
  CodeRenderWorkerClient,
  CodeRenderWorkerJob,
  CodeRenderWorkerSubmission,
} from "../services/code-render-worker-client.ts";
import { CodeRenderWorkerError } from "../services/code-render-worker-client.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const store = new Map<string, Buffer>();
/** The files the service asked storage to stream in (D18: by path, never a Buffer). */
const streamedPaths: string[] = [];
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    putFile: async () => {
      throw new Error("code renders must stream finished files (putFileFromPath), never buffer them");
    },
    putFileFromPath: async (i: { filePath: string; originalFilename: string; contentType: string; maxBytes?: number }) => {
      streamedPaths.push(i.filePath);
      const body = readFileSync(i.filePath);
      const objectKey = `k/${randomUUID()}`;
      store.set(objectKey, body);
      return { provider: "local_disk", objectKey, contentType: i.contentType, byteSize: body.length, sha256: "x", originalFilename: i.originalFilename };
    },
    getObject: async (_c: string, key: string) => ({ stream: Readable.from([store.get(key)!]) }),
  }),
}));

import { codeRenderService } from "../services/code-renders.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

/** The worker's clock for a job that ran `seconds`, ending now. */
function ranFor(seconds: number) {
  const finishedAt = new Date();
  return { startedAt: new Date(finishedAt.getTime() - seconds * 1000).toISOString(), finishedAt: finishedAt.toISOString() };
}

/** An in-memory render worker: jobs stay queued until a test finishes them. */
class FakeWorker implements CodeRenderWorkerClient {
  readonly configured = true;
  submissions: CodeRenderWorkerSubmission[] = [];
  released: string[] = [];
  jobs = new Map<string, CodeRenderWorkerJob & { output?: { body: Buffer; contentType: string } }>();
  refuseNext: CodeRenderWorkerError | null = null;
  outputDelayMs = 0;
  fetches = 0;
  /** Where each download was written (a temp file the service must remove). */
  downloadPaths: string[] = [];

  async submit(job: CodeRenderWorkerSubmission): Promise<CodeRenderWorkerJob> {
    if (this.refuseNext) {
      const error = this.refuseNext;
      this.refuseNext = null;
      throw error;
    }
    this.submissions.push(job);
    const id = randomUUID();
    const record = { id, kind: job.kind, status: "queued" as const, progress: null, error: null, result: null, startedAt: null, finishedAt: null };
    this.jobs.set(id, record);
    return record;
  }

  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }

  async downloadOutput(id: string, maxBytes: number, filePath: string) {
    this.fetches += 1;
    this.downloadPaths.push(filePath);
    if (this.outputDelayMs) await new Promise((resolve) => setTimeout(resolve, this.outputDelayMs));
    const job = this.jobs.get(id);
    if (!job?.output) throw new CodeRenderWorkerError("no output", 404, "no_output");
    if (job.output.body.length > maxBytes) throw new CodeRenderWorkerError(`The finished file is larger than the ${maxBytes} bytes the server accepts.`, 413, "too_large");
    await writeFile(filePath, job.output.body, { flag: "wx" });
    return { contentType: job.output.contentType, bytes: job.output.body.length };
  }

  async release(id: string) {
    this.released.push(id);
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      job.error = "The job was cancelled.";
      job.finishedAt = new Date().toISOString();
    }
    return { ...job, output: undefined };
  }

  /** The worker has started the job (its own clock: `secondsAgo` before now). */
  start(id: string, secondsAgo = 0) {
    const job = this.jobs.get(id)!;
    job.status = "running";
    job.startedAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
  }

  finish(
    id: string,
    result: Partial<NonNullable<CodeRenderWorkerJob["result"]>>,
    output?: { body: Buffer; contentType: string },
    clock: { startedAt: string; finishedAt: string } = ranFor(5),
  ) {
    const job = this.jobs.get(id)!;
    job.status = "done";
    Object.assign(job, clock);
    job.result = {
      passed: null,
      report: null,
      outputContentType: output?.contentType ?? null,
      outputBytes: output?.body.length ?? null,
      durationSeconds: null,
      width: null,
      height: null,
      frames: null,
      ...result,
    };
    job.output = output;
  }

  /** Fails the job; `runSeconds` null = it never started (refused before a browser ran). */
  failJob(id: string, error: string, runSeconds: number | null = null) {
    const job = this.jobs.get(id)!;
    job.status = "failed";
    job.error = error;
    if (runSeconds === null) {
      job.startedAt = null;
      job.finishedAt = new Date().toISOString();
    } else {
      Object.assign(job, ranFor(runSeconds));
    }
  }
}

const HTML = '<!doctype html><html><body><div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="20"></div></body></html>';

/** A composition that names its length: `seconds` long. */
function htmlOf(seconds: number) {
  return `<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" data-duration="${seconds}"></div></body></html>`;
}

function renderInput(extra: Record<string, unknown> = {}) {
  return { kind: "render" as const, title: "Q3 orders", files: [{ path: "index.html", content: HTML }], durationSeconds: 20, ...extra };
}

d("codeRenderService (worker mocked)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("code-renders-service");
    stop = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C", issuePrefix: "CR" + Math.floor(Math.random() * 1e6) } as never);
    await db.insert(agents).values({ id: agentId, companyId, name: "Explainer agent", role: "engineer" } as never);
    return { companyId, agentId };
  }

  async function seedFile(companyId: string, bytes: Buffer, contentType = "image/png") {
    const assetId = randomUUID();
    const fileId = randomUUID();
    const objectKey = `seed/${randomUUID()}`;
    store.set(objectKey, bytes);
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey, contentType, byteSize: bytes.length, sha256: "s", originalFilename: "logo.png" });
    await db.insert(issueAttachments).values({ id: fileId, companyId, issueId: null, assetId });
    return fileId;
  }

  function service(worker: CodeRenderWorkerClient, limits = {}, deps: { workDir?: string; maxOutputBytes?: number } = {}) {
    return codeRenderService(db, { worker, limits, ...deps });
  }

  async function workerJobIdOf(jobId: string) {
    const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, jobId));
    return row!.workerJobId!;
  }

  async function chargedOf(jobId: string) {
    const [row] = await db.select({ requestedSeconds: codeRenderJobs.requestedSeconds }).from(codeRenderJobs).where(eq(codeRenderJobs.id, jobId));
    return row!.requestedSeconds;
  }

  it("renders: sends the composition and the company's own file, then saves the MP4 into Files", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const logo = Buffer.from("PNG-LOGO");
    const fileId = await seedFile(companyId, logo);

    const job = await svc.submit(
      companyId,
      { agentId, userId: null },
      renderInput({
        durationSeconds: 19.5,
        files: [{ path: "index.html", content: HTML }, { path: "sfx/click.ogg", contentBase64: Buffer.from("OggS").toString("base64") }],
        assets: [{ fileId, path: "assets/logo.png" }],
        fps: 24,
      }),
    );
    expect(job).toMatchObject({ status: "queued", kind: "render", durationSeconds: 20, createdByAgentId: agentId });
    const sent = worker.submissions[0]!;
    expect(sent.options).toMatchObject({ fps: 24, maxDurationSeconds: 20 });
    expect(sent.composition.entry).toBe("index.html");
    expect(sent.composition.files.map((f) => f.path)).toEqual(["index.html", "sfx/click.ogg", "assets/logo.png"]);
    expect(Buffer.from(sent.composition.files[0]!.contentBase64, "base64").toString()).toBe(HTML);
    expect(Buffer.from(sent.composition.files[1]!.contentBase64, "base64").toString()).toBe("OggS");
    expect(Buffer.from(sent.composition.files[2]!.contentBase64, "base64").toString()).toBe("PNG-LOGO");

    const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, job.id));
    worker.jobs.get(row!.workerJobId!)!.status = "running";
    worker.jobs.get(row!.workerJobId!)!.progress = { pct: 40, stage: "capture" };
    expect(await svc.get(companyId, job.id)).toMatchObject({ status: "running", progressPct: 40 });

    worker.finish(row!.workerJobId!, { durationSeconds: 19.9 }, { body: Buffer.from("MP4"), contentType: "video/mp4" });
    const done = await svc.get(companyId, job.id);
    expect(done).toMatchObject({ status: "done", resultContentType: "video/mp4", resultBytes: 3, videoSeconds: 19.9, error: null });
    expect(worker.released).toContain(row!.workerJobId);

    const [file] = await db
      .select({ companyId: issueAttachments.companyId, issueId: issueAttachments.issueId, agent: assets.createdByAgentId, name: assets.originalFilename })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(eq(issueAttachments.id, done.resultFileId!));
    expect(file).toEqual({ companyId, issueId: null, agent: agentId, name: "Q3-orders.mp4" });
  });

  it("snapshot attached to a task: the contact sheet lands on that task", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Explainer", status: "todo" } as never);
    const worker = new FakeWorker();
    const svc = service(worker);
    const job = await svc.submit(companyId, { agentId, userId: null }, { kind: "snapshot", title: "Sheet", files: [{ path: "index.html", content: HTML }], issueId, frames: 6 });
    expect(worker.submissions[0]!.options.frames).toBe(6);
    const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, job.id));
    worker.finish(row!.workerJobId!, { frames: 6 }, { body: Buffer.from("JPG"), contentType: "image/jpeg" });
    const done = await svc.get(companyId, job.id);
    expect(done.status).toBe("done");
    const [file] = await db.select().from(issueAttachments).where(eq(issueAttachments.id, done.resultFileId!));
    expect(file!.issueId).toBe(issueId);
  });

  it("check: keeps Hyperframes' report without the worker's folder names, and makes no file", async () => {
    const { companyId } = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const job = await svc.submit(companyId, { agentId: null, userId: "user-1" }, { kind: "check", title: "Lint", files: [{ path: "index.html", content: HTML }] });
    const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, job.id));
    worker.finish(row!.workerJobId!, {
      passed: false,
      report: { ok: false, lint: { errorCount: 1, findings: [{ code: "missing_timeline_registry", sourceFile: `/work/jobs/${row!.workerJobId}/project/index.html` }] } },
    });
    const done = await svc.get(companyId, job.id);
    expect(done).toMatchObject({ status: "done", passed: false, resultFileId: null });
    expect(JSON.stringify(done.report)).toContain('"sourceFile":"index.html"');
    expect(JSON.stringify(done.report)).not.toContain("/work/jobs/");
  });

  it("marks a failed or forgotten worker job failed, with the reason", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const a = await svc.submit(companyId, { agentId, userId: null }, renderInput());
    const b = await svc.submit(companyId, { agentId, userId: null }, renderInput());
    const [rowA] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, a.id));
    const [rowB] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, b.id));
    worker.failJob(rowA!.workerJobId!, "The render failed.\n  Aborting render due to lint issues (--strict mode).");
    worker.jobs.delete(rowB!.workerJobId!);
    expect(await svc.get(companyId, a.id)).toMatchObject({ status: "failed", error: expect.stringContaining("lint issues") });
    expect(await svc.get(companyId, b.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Send the job again") });
  });

  it("saves a finished job once, even when two readers collect it at the same time", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    worker.outputDelayMs = 150;
    const svc = service(worker);
    const job = await svc.submit(companyId, { agentId, userId: null }, renderInput());
    const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, job.id));
    worker.finish(row!.workerJobId!, { durationSeconds: 20 }, { body: Buffer.from("MP4"), contentType: "video/mp4" });
    await Promise.all([svc.get(companyId, job.id), svc.get(companyId, job.id), svc.tick()]);
    expect(worker.fetches).toBe(1);
    expect((await svc.get(companyId, job.id)).status).toBe("done");
  });

  it("is company scoped: another company cannot read a job or send this company's files", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const job = await svc.submit(a.companyId, { agentId: a.agentId, userId: null }, renderInput());
    await expect(svc.get(b.companyId, job.id)).rejects.toThrow(/not found/i);
    expect((await svc.list(b.companyId)).map((j) => j.id)).not.toContain(job.id);

    const fileOfA = await seedFile(a.companyId, Buffer.from("A-ONLY"));
    const before = worker.submissions.length;
    await expect(
      svc.submit(b.companyId, { agentId: b.agentId, userId: null }, renderInput({ assets: [{ fileId: fileOfA, path: "assets/a.png" }] })),
    ).rejects.toThrow(/not found in this company/);
    expect(worker.submissions.length).toBe(before);
    await expect(svc.submit(b.companyId, { agentId: b.agentId, userId: null }, renderInput({ issueId: randomUUID() }))).rejects.toThrow(/task not found/i);
  });

  it("refuses files that are not pictures, video, sound or fonts", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    const fileId = await seedFile(companyId, Buffer.from("#!/bin/sh"), "application/x-sh");
    await expect(
      service(worker).submit(companyId, { agentId, userId: null }, renderInput({ assets: [{ fileId, path: "assets/x.png" }] })),
    ).rejects.toMatchObject({ status: 422 });
  });

  describe("caps: stop and ask", () => {
    it("refuses a render longer than the per-render limit", async () => {
      const { companyId, agentId } = await seedCompany();
      await expect(service(new FakeWorker(), { maxVideoSeconds: 60 }).submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 61 }))).rejects.toMatchObject({
        status: 422,
        details: { reason: "too_long" },
      });
    });

    it("allows only so many jobs at once per company", async () => {
      const { companyId, agentId } = await seedCompany();
      const svc = service(new FakeWorker(), { maxActiveJobsPerCompany: 2 });
      await svc.submit(companyId, { agentId, userId: null }, renderInput());
      await svc.submit(companyId, { agentId, userId: null }, { kind: "check", title: "c", files: [{ path: "index.html", content: HTML }] });
      await expect(svc.submit(companyId, { agentId, userId: null }, renderInput())).rejects.toMatchObject({ status: 429, details: { reason: "too_many_at_once" } });
    });

    it("holds the at-once limit when several submits arrive together", async () => {
      const { companyId, agentId } = await seedCompany();
      const worker = new FakeWorker();
      const svc = service(worker, { maxActiveJobsPerCompany: 1 });
      const results = await Promise.allSettled([1, 2, 3].map(() => svc.submit(companyId, { agentId, userId: null }, renderInput())));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(worker.submissions).toHaveLength(1);
    });

    it("stops an agent at its daily minutes, checks included, but not a person", async () => {
      const { companyId, agentId } = await seedCompany();
      const svc = service(new FakeWorker(), { agentDailyVideoSeconds: 100, maxActiveJobsPerCompany: 10 });
      await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
      await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
      // A check holds a minute of renderer time until it is done (D7: no job is free).
      const check = await svc.submit(companyId, { agentId, userId: null }, { kind: "check", title: "c", files: [{ path: "index.html", content: HTML }] });
      expect(check.chargedSeconds).toBe(60);
      const refusal = svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
      await expect(refusal).rejects.toMatchObject({ status: 429, details: { reason: "agent_daily_cap", usedSeconds: 100, neededSeconds: 20 } });
      await expect(refusal).rejects.toThrow(/ask a person/);
      await expect(svc.submit(companyId, { agentId, userId: null }, { kind: "snapshot", title: "s", files: [{ path: "index.html", content: HTML }] })).rejects.toMatchObject({
        status: 429,
        details: { reason: "agent_daily_cap" },
      });
      // A person asking is not held to the agent's daily minutes.
      await expect(svc.submit(companyId, { agentId: null, userId: "user-1" }, renderInput({ durationSeconds: 20 }))).resolves.toMatchObject({ status: "queued" });
    });

    it("stops agents at the company's daily minutes; a render refused before it ran gives its minutes back", async () => {
      const { companyId, agentId } = await seedCompany();
      const other = randomUUID();
      await db.insert(agents).values({ id: other, companyId, name: "Second agent", role: "engineer" } as never);
      const worker = new FakeWorker();
      const svc = service(worker, { companyDailyVideoSeconds: 40, agentDailyVideoSeconds: 1000, maxActiveJobsPerCompany: 10 });
      const first = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 30, files: [{ path: "index.html", content: htmlOf(30) }] }));
      await expect(svc.submit(companyId, { agentId: other, userId: null }, renderInput({ durationSeconds: 20 }))).rejects.toMatchObject({
        status: 429,
        details: { reason: "company_daily_cap" },
      });
      worker.failJob(await workerJobIdOf(first.id), "boom", null);
      expect(await svc.get(companyId, first.id)).toMatchObject({ status: "failed", chargedSeconds: 0 });
      await expect(svc.submit(companyId, { agentId: other, userId: null }, renderInput({ durationSeconds: 20 }))).resolves.toMatchObject({ status: "queued" });
      expect((await svc.usage(companyId)).companySecondsToday).toBe(20);
    });

    describe("D7: charged by the real length and the renderer's real time (SR2 F1)", () => {
      it("refuses a render whose composition runs longer than the length it asks for, before anything is sent", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { maxActiveJobsPerCompany: 10 });
        // The SR2 misuse: declare 1 second, compose 600.
        const refusal = svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 1, files: [{ path: "index.html", content: htmlOf(600) }] }));
        await expect(refusal).rejects.toMatchObject({ status: 422, details: { reason: "duration_mismatch", compositionSeconds: 600, durationSeconds: 1 } });
        // Clips count too: the latest data-start + data-duration.
        const clipped = '<div id="root" data-composition-id="main" data-duration="10"><div class="clip" data-start="8" data-duration="30"></div></div>';
        await expect(svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 10, files: [{ path: "index.html", content: clipped }] }))).rejects.toMatchObject({
          status: 422,
          details: { reason: "duration_mismatch", compositionSeconds: 38 },
        });
        expect(worker.submissions).toHaveLength(0);
        expect(await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.companyId, companyId))).toHaveLength(0);
        // Matching lengths (within half a second of encoder rounding) pass.
        await expect(svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 599.5, files: [{ path: "index.html", content: htmlOf(600) }] }))).resolves.toMatchObject({
          status: "queued",
        });
      });

      it("refuses a check or contact sheet of a composition longer than any render may be", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { maxVideoSeconds: 60 });
        for (const kind of ["check", "snapshot"] as const) {
          await expect(svc.submit(companyId, { agentId, userId: null }, { kind, title: "long", files: [{ path: "index.html", content: htmlOf(600) }] })).rejects.toMatchObject({
            status: 422,
            details: { reason: "too_long" },
          });
        }
        expect(worker.submissions).toHaveLength(0);
      });

      it("reserves the longer of the asked and the composed length, and holds the worker to it", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const job = await service(worker).submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 12, files: [{ path: "index.html", content: htmlOf(12.4) }] }));
        expect(job).toMatchObject({ durationSeconds: 12, chargedSeconds: 13 });
        expect(worker.submissions[0]!.options.maxDurationSeconds).toBe(13);
      });

      it("charges a failed render the time the renderer spent on it, so failing jobs cannot run free", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { agentDailyVideoSeconds: 300, maxActiveJobsPerCompany: 10 });
        const job = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
        // The worker stopped it at its time limit after 290 s (its own clock).
        worker.failJob(await workerJobIdOf(job.id), "The render took longer than 280 seconds and was stopped.", 290);
        expect(await svc.get(companyId, job.id)).toMatchObject({ status: "failed", chargedSeconds: 290 });
        expect(await chargedOf(job.id)).toBe(290);
        await expect(svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }))).rejects.toMatchObject({
          status: 429,
          details: { reason: "agent_daily_cap", usedSeconds: 290 },
        });
        expect((await svc.usage(companyId)).companySecondsToday).toBe(290);
      });

      it("charges a cancelled job the time the renderer had spent on it", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { maxActiveJobsPerCompany: 10 });
        const running = await svc.submit(companyId, { agentId, userId: null }, { kind: "check", title: "loop", files: [{ path: "index.html", content: HTML }] });
        worker.start(await workerJobIdOf(running.id), 95);
        const cancelled = await svc.cancel(companyId, running.id, { agentId, userId: null });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.chargedSeconds).toBeGreaterThanOrEqual(95);
        expect(cancelled.chargedSeconds).toBeLessThan(105);

        const waiting = await svc.submit(companyId, { agentId, userId: null }, renderInput());
        expect(await svc.cancel(companyId, waiting.id, { agentId, userId: null })).toMatchObject({ status: "cancelled", chargedSeconds: 0 });
      });

      it("counts any job in flight at its run time so far once that passes its reservation", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { agentDailyVideoSeconds: 1000, maxActiveJobsPerCompany: 10 });
        // A while(true){} check the worker has been running for 400 s.
        const check = await svc.submit(companyId, { agentId, userId: null }, { kind: "check", title: "loop", files: [{ path: "index.html", content: HTML }] });
        worker.start(await workerJobIdOf(check.id), 400);
        const seen = await svc.get(companyId, check.id);
        expect(seen.status).toBe("running");
        expect(seen.chargedSeconds).toBeGreaterThanOrEqual(400);
        // A render that runs longer than its video is long counts its run time, not its length.
        const render = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
        worker.start(await workerJobIdOf(render.id), 400);
        const rendering = await svc.get(companyId, render.id);
        expect(rendering.status).toBe("running");
        expect(rendering.chargedSeconds).toBeGreaterThanOrEqual(400);
        const used = (await svc.usage(companyId)).companySecondsToday;
        expect(used).toBeGreaterThanOrEqual(800);
        expect(used).toBeLessThan(820);
        await expect(svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 600, files: [{ path: "index.html", content: htmlOf(600) }] }))).rejects.toMatchObject({
          status: 429,
          details: { reason: "agent_daily_cap" },
        });
      });

      it("charges a finished check or contact sheet its real run time, and a finished render the longer of its real length and its run time", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { maxActiveJobsPerCompany: 10 });
        const check = await svc.submit(companyId, { agentId, userId: null }, { kind: "check", title: "c", files: [{ path: "index.html", content: HTML }] });
        worker.finish(await workerJobIdOf(check.id), { passed: true }, undefined, ranFor(7));
        expect(await svc.get(companyId, check.id)).toMatchObject({ status: "done", chargedSeconds: 7 });

        const sheet = await svc.submit(companyId, { agentId, userId: null }, { kind: "snapshot", title: "s", files: [{ path: "index.html", content: HTML }] });
        worker.finish(await workerJobIdOf(sheet.id), { frames: 9 }, { body: Buffer.from("JPG"), contentType: "image/jpeg" }, ranFor(42));
        expect(await svc.get(companyId, sheet.id)).toMatchObject({ status: "done", chargedSeconds: 42 });

        const render = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
        worker.finish(await workerJobIdOf(render.id), { durationSeconds: 20.3 }, { body: Buffer.from("MP4"), contentType: "video/mp4" }, ranFor(5));
        expect(await svc.get(companyId, render.id)).toMatchObject({ status: "done", videoSeconds: 20.3, chargedSeconds: 21 });

        const slow = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
        worker.finish(await workerJobIdOf(slow.id), { durationSeconds: 20.3 }, { body: Buffer.from("MP4"), contentType: "video/mp4" }, ranFor(160));
        expect(await svc.get(companyId, slow.id)).toMatchObject({ status: "done", videoSeconds: 20.3, chargedSeconds: 160 });
        expect((await svc.usage(companyId)).companySecondsToday).toBe(7 + 42 + 21 + 160);
      });

      it("charges a slow 1-second render the renderer's time, so looping tiny renders reaches the cap (SR N1)", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker, { agentDailyVideoSeconds: 300, maxActiveJobsPerCompany: 10 });
        const tiny = () => renderInput({ durationSeconds: 1, files: [{ path: "index.html", content: htmlOf(1) }] });
        for (let i = 0; i < 2; i++) {
          const job = await svc.submit(companyId, { agentId, userId: null }, tiny());
          // A busy-waiting composition: 125 s of renderer time for 1 s of video.
          worker.finish(await workerJobIdOf(job.id), { durationSeconds: 1 }, { body: Buffer.from("MP4"), contentType: "video/mp4" }, ranFor(125));
          expect(await svc.get(companyId, job.id)).toMatchObject({ status: "done", videoSeconds: 1, chargedSeconds: 125 });
        }
        expect((await svc.usage(companyId)).companySecondsToday).toBe(250);
        await expect(svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 60, files: [{ path: "index.html", content: htmlOf(60) }] }))).rejects.toMatchObject({
          status: 429,
          details: { reason: "agent_daily_cap", usedSeconds: 250 },
        });
      });

      it("re-checks the real length: a video longer than allowed is not saved, and is charged its real length", async () => {
        const { companyId, agentId } = await seedCompany();
        const worker = new FakeWorker();
        const svc = service(worker);
        const job = await svc.submit(companyId, { agentId, userId: null }, renderInput({ durationSeconds: 20 }));
        const storedBefore = store.size;
        worker.finish(await workerJobIdOf(job.id), { durationSeconds: 95 }, { body: Buffer.from("MP4"), contentType: "video/mp4" });
        const failed = await svc.get(companyId, job.id);
        expect(failed).toMatchObject({ status: "failed", resultFileId: null, chargedSeconds: 95 });
        expect(failed.error).toMatch(/95\.0 seconds long, more than the 20 seconds/);
        expect(store.size).toBe(storedBefore);
        expect(worker.fetches).toBe(0);
      });
    });

    it("refuses any job while the company's budget is paused", async () => {
      const { companyId, agentId } = await seedCompany();
      await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, windowKind: "calendar_month_utc", amount: 1000 } as never);
      await db.update(companies).set({ status: "paused", pausedAt: new Date() } as never).where(eq(companies.id, companyId));
      const worker = new FakeWorker();
      await expect(service(worker).submit(companyId, { agentId, userId: null }, renderInput())).rejects.toMatchObject({ status: 422, details: { reason: "budget_paused" } });
      expect(worker.submissions).toHaveLength(0);
    });
  });

  it("maps a worker refusal to a plain error and records the job as failed", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    worker.refuseNext = new CodeRenderWorkerError("The composition loads files from the internet: https://cdn.example.com/x.js", 422, "remote_urls");
    const svc = service(worker);
    await expect(svc.submit(companyId, { agentId, userId: null }, renderInput())).rejects.toMatchObject({ status: 422, message: expect.stringContaining("internet") });
    const rows = await db.select().from(codeRenderJobs).where(and(eq(codeRenderJobs.companyId, companyId), eq(codeRenderJobs.status, "failed")));
    expect(rows).toHaveLength(1);
  });

  it("answers 503 in plain words while the render worker is not set up", async () => {
    const { companyId, agentId } = await seedCompany();
    const svc = codeRenderService(db, {
      worker: {
        configured: false,
        submit: () => Promise.reject(new Error("unreachable")),
        get: () => Promise.resolve(null),
        downloadOutput: () => Promise.reject(new Error("unreachable")),
        release: () => Promise.resolve(null),
      },
    });
    await expect(svc.submit(companyId, { agentId, userId: null }, renderInput())).rejects.toMatchObject({ status: 503, message: expect.stringContaining("not set up") });
    expect(await svc.tick()).toEqual({ checked: 0, finished: 0, failed: 0 });
  });

  it("cancels a waiting job and frees it on the worker", async () => {
    const { companyId, agentId } = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const job = await svc.submit(companyId, { agentId, userId: null }, renderInput());
    const cancelled = await svc.cancel(companyId, job.id, { agentId, userId: null });
    expect(cancelled.status).toBe("cancelled");
    expect(worker.released).toHaveLength(1);
  });

  it("tick collects finished jobs nobody is watching, across companies", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const worker = new FakeWorker();
    const svc = service(worker);
    const ja = await svc.submit(a.companyId, { agentId: a.agentId, userId: null }, renderInput());
    const jb = await svc.submit(b.companyId, { agentId: b.agentId, userId: null }, renderInput());
    for (const id of [ja.id, jb.id]) {
      const [row] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, id));
      worker.finish(row!.workerJobId!, { durationSeconds: 20 }, { body: Buffer.from("MP4"), contentType: "video/mp4" });
    }
    const result = await svc.tick();
    expect(result.finished).toBeGreaterThanOrEqual(2);
    const [ra] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, ja.id));
    const [rb] = await db.select().from(codeRenderJobs).where(eq(codeRenderJobs.id, jb.id));
    expect(ra!.status).toBe("done");
    expect(rb!.status).toBe("done");
    const [fileB] = await db.select().from(issueAttachments).where(eq(issueAttachments.id, rb!.resultFileId!));
    expect(fileB!.companyId).toBe(b.companyId);
  });

  describe("D18: a finished file is streamed to storage, never held in memory (SR2 F2)", () => {
    let workDir: string;

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "code-render-service-work-"));
    });

    afterAll(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it("downloads to a temp file, streams that file into storage, then removes it", async () => {
      const { companyId, agentId } = await seedCompany();
      const worker = new FakeWorker();
      const svc = service(worker, {}, { workDir });
      const job = await svc.submit(companyId, { agentId, userId: null }, renderInput());
      const video = Buffer.alloc(256 * 1024, 3);
      worker.finish(await workerJobIdOf(job.id), { durationSeconds: 20 }, { body: video, contentType: "video/mp4" });
      const before = streamedPaths.length;
      const done = await svc.get(companyId, job.id);
      expect(done).toMatchObject({ status: "done", resultBytes: video.length });
      // Storage was handed the downloaded file's path, inside the work folder.
      expect(streamedPaths.length).toBe(before + 1);
      expect(streamedPaths.at(-1)).toBe(worker.downloadPaths.at(-1));
      expect(streamedPaths.at(-1)!.startsWith(workDir)).toBe(true);
      const [file] = await db
        .select({ objectKey: assets.objectKey })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, done.resultFileId!));
      expect(store.get(file!.objectKey)!.equals(video)).toBe(true);
      // Nothing is left behind on the server's disk.
      expect(existsSync(streamedPaths.at(-1)!)).toBe(false);
      expect(await readdir(workDir)).toEqual([]);
    });

    it("refuses a finished file over the server's output limit: the job fails, nothing is stored or left on disk", async () => {
      const { companyId, agentId } = await seedCompany();
      const worker = new FakeWorker();
      const svc = service(worker, {}, { workDir, maxOutputBytes: 1024 });
      const job = await svc.submit(companyId, { agentId, userId: null }, renderInput());
      const storedBefore = store.size;
      worker.finish(await workerJobIdOf(job.id), { durationSeconds: 20 }, { body: Buffer.alloc(4096), contentType: "video/mp4" });
      const failed = await svc.get(companyId, job.id);
      expect(failed).toMatchObject({ status: "failed", resultFileId: null, chargedSeconds: 20 });
      expect(failed.error).toMatch(/could not be saved: The finished file is larger than the 1024 bytes/);
      expect(store.size).toBe(storedBefore);
      expect(await readdir(workDir)).toEqual([]);
      expect(worker.released).toContain(await workerJobIdOf(job.id));
    });
  });
});
