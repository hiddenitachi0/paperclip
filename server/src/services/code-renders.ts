import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, codeRenderJobs, issueAttachments, issues as issuesTable, withCompanyScope } from "@paperclipai/db";
import {
  CODE_RENDER_ACTIVE_STATUSES,
  CODE_RENDER_DEFAULT_LIMITS,
  CODE_RENDER_HARD_MAX_VIDEO_SECONDS,
  type CodeRenderJob,
  type CodeRenderKind,
  type CodeRenderLimits,
  type CodeRenderStatus,
  type CodeRenderUsage,
  type SubmitCodeRenderInput,
} from "@paperclipai/shared";
import { HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import {
  CodeRenderWorkerError,
  CodeRenderWorkerNotConfiguredError,
  createCodeRenderWorkerClientFromEnv,
  type CodeRenderWorkerClient,
  type CodeRenderWorkerJob,
} from "./code-render-worker-client.js";

/**
 * Media Studio code-rendered videos (D14; plan card "Code-rendered video
 * worker for infographics and explainers"). An agent or a person sends a
 * Hyperframes composition; this service checks it against the caps, adds the
 * company's own Media Studio files it names, hands it to the render worker,
 * and -- when the worker is done -- copies the MP4 (or contact sheet) into
 * the company's Files, or attaches it to the task.
 *
 * Company scope: every row carries company_id and every read filters on it;
 * assets are looked up by (file id, company id), so a job can only ever carry
 * this company's own files, and the result is saved into the job's company.
 *
 * Caps (CodeRenderLimits; env PAPERCLIP_CODE_RENDER_*): rendering costs no
 * provider money but takes the box's CPU, so they count video seconds, not
 * cents. An agent's render is refused with a plain "ask a person" sentence
 * when it would pass its own or the company's daily minutes; a person's
 * render only meets the per-render length and the at-once limit. A paused or
 * hard-stopped budget (company, or the asking agent's own) refuses any job,
 * the same rule every other spend path follows.
 *
 * Progress is collected two ways: lazily when someone reads a job, and by
 * the `codeRenders` scheduler chain for jobs nobody is watching. A finished
 * job is claimed (status `saving`) by a conditional update before its file is
 * copied, so two pollers can never save it twice.
 */

type Row = typeof codeRenderJobs.$inferSelect;
/** The transaction withCompanyScope hands its callback. */
type ScopedTx = Parameters<Parameters<typeof withCompanyScope>[2]>[0];

export interface CodeRenderActor {
  agentId: string | null;
  userId: string | null;
  runId?: string | null;
}

export interface CodeRenderSavedFile {
  id: string;
}

export interface CodeRenderServiceDeps {
  worker?: CodeRenderWorkerClient;
  limits?: Partial<CodeRenderLimits>;
  /** Largest finished file the server accepts from the worker (default 2 GB, D18). */
  maxOutputBytes?: number;
  /** Reads one of the company's files. Default: the Files tables + company storage. */
  readCompanyFile?: (companyId: string, fileId: string, maxBytes: number) => Promise<{ bytes: Buffer; contentType: string }>;
  /** Saves the result. Default: company storage + a Files row (or a task attachment). */
  saveFile?: (input: { companyId: string; job: Row; filename: string; contentType: string; body: Buffer }) => Promise<CodeRenderSavedFile>;
  now?: () => Date;
}

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
/** A `saving` claim older than this belongs to a poller that died; another may take over. */
const SAVING_STALE_MS = 10 * 60_000;
/** A row the worker never acknowledged (server crashed mid-submit). */
const UNSUBMITTED_STALE_MS = 5 * 60_000;
const REPORT_MAX_CHARS = 256 * 1024;
const TICK_BATCH = 25;
const ASSET_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/", "font/", "application/font-", "application/x-font-"];

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/** The caps in force: defaults, then PAPERCLIP_CODE_RENDER_* overrides, each clamped. */
export function codeRenderLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): CodeRenderLimits {
  const d = CODE_RENDER_DEFAULT_LIMITS;
  return {
    maxVideoSeconds: intFromEnv(env, "PAPERCLIP_CODE_RENDER_MAX_VIDEO_SECONDS", d.maxVideoSeconds, 1, CODE_RENDER_HARD_MAX_VIDEO_SECONDS),
    agentDailyVideoSeconds: intFromEnv(env, "PAPERCLIP_CODE_RENDER_AGENT_DAILY_SECONDS", d.agentDailyVideoSeconds, 0, 24 * 3600),
    companyDailyVideoSeconds: intFromEnv(env, "PAPERCLIP_CODE_RENDER_COMPANY_DAILY_SECONDS", d.companyDailyVideoSeconds, 0, 24 * 3600),
    maxActiveJobsPerCompany: intFromEnv(env, "PAPERCLIP_CODE_RENDER_MAX_ACTIVE_JOBS", d.maxActiveJobsPerCompany, 1, 20),
    maxAssetBytes: intFromEnv(env, "PAPERCLIP_CODE_RENDER_MAX_ASSET_MB", d.maxAssetBytes / 1024 / 1024, 1, 1024) * 1024 * 1024,
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function minutes(seconds: number): string {
  const m = seconds / 60;
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
}

/** The worker's paths are meaningless to a reader ("/work/jobs/<id>/project/index.html" -> "index.html"). */
function tidyReport(report: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!report) return null;
  const text = JSON.stringify(report).replace(/\/[^"]*?\/jobs\/[0-9a-f-]{36}\/project\//g, "");
  if (text.length <= REPORT_MAX_CHARS) return JSON.parse(text) as Record<string, unknown>;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const summary: Record<string, unknown> = { ok: parsed.ok ?? null, truncated: true };
  for (const [key, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && "errorCount" in value) {
      const v = value as { ok?: unknown; errorCount?: unknown; warningCount?: unknown; findings?: unknown };
      summary[key] = {
        ok: v.ok ?? null,
        errorCount: v.errorCount ?? null,
        warningCount: v.warningCount ?? null,
        findings: Array.isArray(v.findings) ? v.findings.slice(0, 20) : [],
      };
    }
  }
  return summary;
}

function toJob(row: Row): CodeRenderJob {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as CodeRenderKind,
    status: row.status as CodeRenderStatus,
    title: row.title,
    issueId: row.issueId,
    durationSeconds: row.kind === "render" ? row.requestedSeconds : null,
    videoSeconds: row.videoMs === null ? null : row.videoMs / 1000,
    progressPct: row.progressPct,
    resultFileId: row.resultFileId,
    resultContentType: row.resultContentType,
    resultBytes: row.resultBytes,
    passed: row.passed,
    report: row.report ?? null,
    error: row.error,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** The worker's refusal in words a person or agent can act on, with a matching HTTP status. */
function httpErrorFromWorker(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CodeRenderWorkerError) {
    if (error.status === 422 || error.status === 400) return unprocessable(error.message, { reason: error.code, details: error.details });
    if (error.status === 413) return unprocessable(error.message, { reason: "too_large" });
    if (error.status === 429) return tooManyRequests(error.message, { reason: "renderer_busy" });
    return new HttpError(502, `The render worker could not take the job: ${error.message}`);
  }
  if (error instanceof CodeRenderWorkerNotConfiguredError) return new HttpError(503, error.message);
  return new HttpError(502, "The render worker could not take the job.");
}

export function codeRenderService(db: Db, deps: CodeRenderServiceDeps = {}) {
  const worker = deps.worker ?? createCodeRenderWorkerClientFromEnv();
  const limits: CodeRenderLimits = { ...codeRenderLimitsFromEnv(), ...deps.limits };
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const now = deps.now ?? (() => new Date());
  const budgets = budgetService(db);
  const issues = issueService(db);

  async function defaultReadCompanyFile(companyId: string, fileId: string, maxBytes: number) {
    const row = await withCompanyScope(db, companyId, (tx) =>
      tx
        .select({ objectKey: assets.objectKey, contentType: assets.contentType, byteSize: assets.byteSize })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(and(eq(issueAttachments.id, fileId), eq(issueAttachments.companyId, companyId), eq(assets.companyId, companyId)))
        .then((rows) => rows[0] ?? null),
    );
    if (!row) throw notFound(`File ${fileId} was not found in this company's Files.`);
    if (row.byteSize > maxBytes) throw unprocessable(`File ${fileId} is larger than the ${maxBytes} bytes a render may carry.`);
    const object = await getStorageService().getObject(companyId, row.objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.stream as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) throw unprocessable(`File ${fileId} is larger than the ${maxBytes} bytes a render may carry.`);
      chunks.push(buf);
    }
    return { bytes: Buffer.concat(chunks), contentType: row.contentType };
  }

  /** One object, one asset row: a task attachment when the job names a task, else a company file. */
  async function defaultSaveFile(input: { companyId: string; job: Row; filename: string; contentType: string; body: Buffer }) {
    const stored = await getStorageService().putFile({
      companyId: input.companyId,
      namespace: "code-renders",
      originalFilename: input.filename,
      contentType: input.contentType,
      body: input.body,
    });
    const common = {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: input.job.createdByAgentId,
      createdByUserId: input.job.createdByUserId,
    };
    if (input.job.issueId) return issues.createAttachment({ issueId: input.job.issueId, ...common });
    return issues.createCompanyFile({ companyId: input.companyId, ...common });
  }

  const readCompanyFile = deps.readCompanyFile ?? defaultReadCompanyFile;
  const saveFile = deps.saveFile ?? defaultSaveFile;

  async function loadRow(companyId: string, jobId: string): Promise<Row> {
    const row = await withCompanyScope(db, companyId, (tx) =>
      tx
        .select()
        .from(codeRenderJobs)
        .where(and(eq(codeRenderJobs.id, jobId), eq(codeRenderJobs.companyId, companyId)))
        .then((rows) => rows[0] ?? null),
    );
    if (!row) throw notFound("Code render job not found");
    return row;
  }

  async function update(row: Row, patch: Partial<typeof codeRenderJobs.$inferInsert>, onlyIfStatus?: string[]): Promise<Row | null> {
    const conditions = [eq(codeRenderJobs.id, row.id), eq(codeRenderJobs.companyId, row.companyId)];
    if (onlyIfStatus) conditions.push(inArray(codeRenderJobs.status, onlyIfStatus));
    return withCompanyScope(db, row.companyId, (tx) =>
      tx
        .update(codeRenderJobs)
        .set({ ...patch, updatedAt: now() })
        .where(and(...conditions))
        .returning()
        .then((rows) => rows[0] ?? null),
    );
  }

  async function logJob(row: Row, action: string, details: Record<string, unknown>) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: row.createdByAgentId ? "agent" : row.createdByUserId ? "user" : "system",
      actorId: row.createdByAgentId ?? row.createdByUserId ?? "code-render-worker",
      agentId: row.createdByAgentId,
      action,
      entityType: "code_render_job",
      entityId: row.id,
      details: { kind: row.kind, title: row.title, ...details },
    }).catch((err) => logger.warn({ err, jobId: row.id }, "code render: activity log failed"));
  }

  /** Video seconds asked for today (UTC) by renders that are still on or finished. */
  async function secondsTodayIn(tx: ScopedTx, companyId: string, agentId: string | null): Promise<number> {
    const conditions = [
      eq(codeRenderJobs.companyId, companyId),
      eq(codeRenderJobs.kind, "render"),
      inArray(codeRenderJobs.status, [...CODE_RENDER_ACTIVE_STATUSES, "done"]),
      gte(codeRenderJobs.createdAt, startOfUtcDay(now())),
    ];
    if (agentId) conditions.push(eq(codeRenderJobs.createdByAgentId, agentId));
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${codeRenderJobs.requestedSeconds}), 0)::int` })
      .from(codeRenderJobs)
      .where(and(...conditions));
    return Number(row?.total ?? 0);
  }

  async function activeJobsIn(tx: ScopedTx, companyId: string): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(codeRenderJobs)
      .where(and(eq(codeRenderJobs.companyId, companyId), inArray(codeRenderJobs.status, [...CODE_RENDER_ACTIVE_STATUSES])));
    return Number(row?.count ?? 0);
  }

  /** A paused or hard-stopped budget (company, or this agent's own) refuses any job. Fails closed. */
  async function assertBudgetOpen(companyId: string, agentId: string | null) {
    const overview = await budgets.overview(companyId);
    for (const policy of overview.policies) {
      const applies = policy.scopeType === "company" || (agentId !== null && policy.scopeType === "agent" && policy.scopeId === agentId);
      if (!applies || !policy.isActive) continue;
      const who = policy.scopeType === "company" ? "The company's" : "This agent's";
      if (policy.paused) throw unprocessable(`${who} budget is paused. Ask a person to resume it before making a video.`, { reason: "budget_paused" });
      if (policy.hardStopEnabled && policy.status === "hard_stop") {
        throw unprocessable(`${who} budget has reached its hard stop. Ask a person before making a video.`, { reason: "budget_hard_stop" });
      }
    }
  }

  function assertLength(input: SubmitCodeRenderInput, requestedSeconds: number) {
    if (input.kind === "render" && requestedSeconds > limits.maxVideoSeconds) {
      throw unprocessable(
        `A code-drawn video may be at most ${minutes(limits.maxVideoSeconds)} long; this one asks for ${minutes(requestedSeconds)}. Split it into parts, or ask a person to raise the limit.`,
        { reason: "too_long", maxVideoSeconds: limits.maxVideoSeconds },
      );
    }
  }

  /** Jobs at once and daily minutes. Run under the company's cap lock when it decides an insert. */
  async function assertWithinCapsIn(tx: ScopedTx, companyId: string, actor: CodeRenderActor, input: SubmitCodeRenderInput, requestedSeconds: number) {
    const active = await activeJobsIn(tx, companyId);
    if (active >= limits.maxActiveJobsPerCompany) {
      throw tooManyRequests(
        `${active} code-drawn video job${active === 1 ? " is" : "s are"} already waiting or running for this company. Try again when one has finished.`,
        { reason: "too_many_at_once", maxActiveJobs: limits.maxActiveJobsPerCompany },
      );
    }
    // Daily minutes are an agent limit: a person asking is the one who would be asked.
    if (input.kind !== "render" || !actor.agentId) return;
    const companyUsed = await secondsTodayIn(tx, companyId, null);
    if (companyUsed + requestedSeconds > limits.companyDailyVideoSeconds) {
      throw tooManyRequests(
        `This company has used ${minutes(companyUsed)} of its ${minutes(limits.companyDailyVideoSeconds)} of code-drawn video today. Stop here and ask a person whether to go on tomorrow or raise the limit.`,
        { reason: "company_daily_cap", usedSeconds: companyUsed, capSeconds: limits.companyDailyVideoSeconds },
      );
    }
    const agentUsed = await secondsTodayIn(tx, companyId, actor.agentId);
    if (agentUsed + requestedSeconds > limits.agentDailyVideoSeconds) {
      throw tooManyRequests(
        `You have made ${minutes(agentUsed)} of your ${minutes(limits.agentDailyVideoSeconds)} of code-drawn video today. Stop here and ask a person whether to go on.`,
        { reason: "agent_daily_cap", usedSeconds: agentUsed, capSeconds: limits.agentDailyVideoSeconds },
      );
    }
  }

  async function assertIssueInCompany(companyId: string, issueId: string) {
    const row = await withCompanyScope(db, companyId, (tx) =>
      tx
        .select({ id: issuesTable.id })
        .from(issuesTable)
        .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, companyId)))
        .then((rows) => rows[0] ?? null),
    );
    if (!row) throw notFound("Task not found in this company");
  }

  async function buildFiles(companyId: string, input: SubmitCodeRenderInput) {
    const files = input.files.map((file) => ({
      path: file.path,
      contentBase64: file.contentBase64 ?? Buffer.from(file.content ?? "", "utf8").toString("base64"),
    }));
    let assetBytes = 0;
    for (const asset of input.assets ?? []) {
      const { bytes, contentType } = await readCompanyFile(companyId, asset.fileId, limits.maxAssetBytes - assetBytes);
      const type = contentType.toLowerCase();
      if (!ASSET_CONTENT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
        throw unprocessable(`File ${asset.fileId} is ${contentType}; a render can carry pictures, video, sound and fonts only.`, { reason: "bad_asset_type" });
      }
      assetBytes += bytes.length;
      if (assetBytes > limits.maxAssetBytes) {
        throw unprocessable(`The files sent with this render are larger than ${limits.maxAssetBytes} bytes in total.`, { reason: "assets_too_large" });
      }
      files.push({ path: asset.path, contentBase64: bytes.toString("base64") });
    }
    return files;
  }

  async function fail(row: Row, message: string): Promise<Row> {
    const updated = await update(row, { status: "failed", error: message, progressPct: null, finishedAt: now() }, [...CODE_RENDER_ACTIVE_STATUSES]);
    if (updated) await logJob(updated, "code_render.failed", { error: message });
    return updated ?? (await loadRow(row.companyId, row.id));
  }

  async function release(workerJobId: string) {
    await worker.release(workerJobId).catch((err) => logger.warn({ err, workerJobId }, "code render: releasing the worker job failed"));
  }

  /** Copies a finished job's result into the company and marks it done. Caller holds the `saving` claim. */
  async function collect(row: Row, done: CodeRenderWorkerJob): Promise<Row> {
    const workerJobId = row.workerJobId!;
    if (row.kind === "check") {
      const updated = await update(row, {
        status: "done",
        passed: done.result?.passed ?? null,
        report: tidyReport(done.result?.report ?? null),
        progressPct: null,
        finishedAt: now(),
      });
      await release(workerJobId);
      if (updated) await logJob(updated, "code_render.finished", { passed: updated.passed });
      return updated ?? row;
    }
    const output = await worker.fetchOutput(workerJobId, maxOutputBytes);
    const expected = row.kind === "render" ? ["video/mp4"] : ["image/jpeg", "image/png"];
    if (!expected.includes(output.contentType)) throw new Error(`The renderer returned ${output.contentType || "an unknown type"} instead of ${expected.join(" or ")}.`);
    const extension = output.contentType === "video/mp4" ? "mp4" : output.contentType === "image/png" ? "png" : "jpg";
    const base = row.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "code-render";
    const filename = row.kind === "snapshot" ? `${base}-contact-sheet.${extension}` : `${base}.${extension}`;
    const file = await saveFile({ companyId: row.companyId, job: row, filename, contentType: output.contentType, body: output.body });
    const videoSeconds = done.result?.durationSeconds ?? null;
    const updated = await update(row, {
      status: "done",
      resultFileId: file.id,
      resultContentType: output.contentType,
      resultBytes: output.body.length,
      videoMs: videoSeconds === null ? null : Math.round(videoSeconds * 1000),
      progressPct: null,
      error: null,
      finishedAt: now(),
    });
    await release(workerJobId);
    if (updated) await logJob(updated, "code_render.finished", { fileId: file.id, bytes: output.body.length, videoSeconds });
    return updated ?? row;
  }

  /** Moves one active job forward from the worker's state. Never throws for a worker hiccup. */
  async function advance(row: Row): Promise<Row> {
    if (!(CODE_RENDER_ACTIVE_STATUSES as readonly string[]).includes(row.status)) return row;
    const age = now().getTime() - row.updatedAt.getTime();
    if (row.status === "saving" && age < SAVING_STALE_MS) return row;
    if (!row.workerJobId) {
      return now().getTime() - row.createdAt.getTime() > UNSUBMITTED_STALE_MS ? fail(row, "The job never reached the renderer. Send it again.") : row;
    }

    let state: CodeRenderWorkerJob | null;
    try {
      state = await worker.get(row.workerJobId);
    } catch (err) {
      logger.warn({ err, jobId: row.id }, "code render: status check failed; will retry");
      return row;
    }
    if (!state) return fail(row, "The renderer restarted, or the finished file expired, before it was collected. Send the job again.");

    if (state.status === "queued" || state.status === "running") {
      if (row.status === "saving") return row;
      const patch: Partial<typeof codeRenderJobs.$inferInsert> = { status: state.status, progressPct: state.progress?.pct ?? null };
      if (state.status === "running" && !row.startedAt) patch.startedAt = now();
      return (await update(row, patch, ["queued", "running"])) ?? row;
    }
    if (state.status === "failed" || state.status === "cancelled") {
      await release(row.workerJobId);
      if (state.status === "cancelled") {
        const updated = await update(row, { status: "cancelled", error: state.error, progressPct: null, finishedAt: now() }, [...CODE_RENDER_ACTIVE_STATUSES]);
        return updated ?? row;
      }
      return fail(row, state.error ?? "The render failed.");
    }

    // Done: claim it, so only one poller copies the file.
    const claimStatuses = row.status === "saving" ? ["saving"] : ["queued", "running"];
    const claimed = await update(row, { status: "saving", progressPct: 100 }, claimStatuses);
    if (!claimed) return loadRow(row.companyId, row.id);
    try {
      return await collect(claimed, state);
    } catch (err) {
      logger.warn({ err, jobId: row.id }, "code render: collecting the result failed");
      const message = err instanceof Error ? err.message : String(err);
      await release(row.workerJobId);
      const updated = await update(claimed, { status: "failed", error: `The video was made but could not be saved: ${message}`, progressPct: null, finishedAt: now() });
      if (updated) await logJob(updated, "code_render.failed", { error: updated.error });
      return updated ?? claimed;
    }
  }

  return {
    get configured() {
      return worker.configured;
    },

    limits(): CodeRenderLimits {
      return { ...limits };
    },

    async usage(companyId: string): Promise<CodeRenderUsage> {
      return withCompanyScope(db, companyId, async (tx) => ({
        limits: { ...limits },
        companySecondsToday: await secondsTodayIn(tx, companyId, null),
        activeJobs: await activeJobsIn(tx, companyId),
        configured: worker.configured,
      }));
    },

    async submit(companyId: string, actor: CodeRenderActor, input: SubmitCodeRenderInput): Promise<CodeRenderJob> {
      if (!worker.configured) throw httpErrorFromWorker(new CodeRenderWorkerNotConfiguredError());
      if (input.issueId) await assertIssueInCompany(companyId, input.issueId);
      const requestedSeconds = input.kind === "render" ? Math.ceil(input.durationSeconds ?? 0) : 0;
      assertLength(input, requestedSeconds);
      await assertBudgetOpen(companyId, actor.agentId);
      // Cheap early answer before any file is read; decided for real under the lock below.
      await withCompanyScope(db, companyId, (tx) => assertWithinCapsIn(tx, companyId, actor, input, requestedSeconds));
      const files = await buildFiles(companyId, input);

      const options = {
        entry: input.entry ?? "index.html",
        fps: input.fps ?? 30,
        quality: input.quality ?? "standard",
        frames: input.frames ?? 9,
        fileCount: input.files.length,
        assetCount: input.assets?.length ?? 0,
      };
      // The row holds the slot (and the minutes) before the worker is asked.
      // One lock per company, so two submits at once cannot both pass the caps.
      const row = await withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`code_render_caps:${companyId}`}))`);
        await assertWithinCapsIn(tx, companyId, actor, input, requestedSeconds);
        const [inserted] = await tx
          .insert(codeRenderJobs)
          .values({
            companyId,
            kind: input.kind,
            status: "queued",
            title: input.title,
            issueId: input.issueId ?? null,
            requestedSeconds,
            options,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
          })
          .returning();
        return inserted;
      });

      let accepted: CodeRenderWorkerJob;
      try {
        accepted = await worker.submit({
          kind: input.kind,
          label: `paperclip ${row!.id}`,
          composition: { entry: options.entry, files },
          options: {
            fps: options.fps,
            quality: options.quality,
            frames: options.frames,
            maxDurationSeconds: input.kind === "render" ? requestedSeconds : limits.maxVideoSeconds,
          },
        });
      } catch (err) {
        const httpError = httpErrorFromWorker(err);
        await update(row!, { status: "failed", error: httpError.message, finishedAt: now() });
        await logJob(row!, "code_render.refused", { error: httpError.message });
        throw httpError;
      }
      const updated = (await update(row!, { workerJobId: accepted.id, status: accepted.status === "running" ? "running" : "queued" })) ?? row!;
      await logJob(updated, "code_render.submitted", {
        requestedSeconds,
        fileCount: options.fileCount,
        assetCount: options.assetCount,
        issueId: updated.issueId,
      });
      return toJob(updated);
    },

    /** A job, moved forward first when it is still in flight. */
    async get(companyId: string, jobId: string): Promise<CodeRenderJob> {
      const row = await loadRow(companyId, jobId);
      return toJob(await advance(row));
    },

    async list(companyId: string, opts: { limit?: number } = {}): Promise<CodeRenderJob[]> {
      const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
      const rows = await withCompanyScope(db, companyId, (tx) =>
        tx.select().from(codeRenderJobs).where(eq(codeRenderJobs.companyId, companyId)).orderBy(desc(codeRenderJobs.createdAt)).limit(limit),
      );
      return rows.map(toJob);
    },

    async cancel(companyId: string, jobId: string, actor: CodeRenderActor): Promise<CodeRenderJob> {
      const row = await loadRow(companyId, jobId);
      if (!(CODE_RENDER_ACTIVE_STATUSES as readonly string[]).includes(row.status) || row.status === "saving") return toJob(row);
      if (row.workerJobId) await release(row.workerJobId);
      const updated = await update(row, { status: "cancelled", error: "Cancelled.", progressPct: null, finishedAt: now() }, ["queued", "running"]);
      if (updated) {
        await logActivity(db, {
          companyId,
          actorType: actor.agentId ? "agent" : "user",
          actorId: actor.agentId ?? actor.userId ?? "unknown",
          agentId: actor.agentId,
          runId: actor.runId ?? null,
          action: "code_render.cancelled",
          entityType: "code_render_job",
          entityId: row.id,
          details: { kind: row.kind, title: row.title },
        }).catch((err) => logger.warn({ err, jobId: row.id }, "code render: activity log failed"));
      }
      return toJob(updated ?? (await loadRow(companyId, jobId)));
    },

    /**
     * Scheduler chain `codeRenders`: moves every in-flight job forward, oldest
     * first, across companies (bypass scope; each row is handled in its own
     * company). Jobs nobody is polling still land in Files.
     */
    async tick(): Promise<{ checked: number; finished: number; failed: number }> {
      if (!worker.configured) return { checked: 0, finished: 0, failed: 0 };
      const rows = await db
        .select()
        .from(codeRenderJobs)
        .where(inArray(codeRenderJobs.status, [...CODE_RENDER_ACTIVE_STATUSES]))
        .orderBy(asc(codeRenderJobs.createdAt))
        .limit(TICK_BATCH);
      let finished = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const next = await advance(row);
          if (next.status === "done" && row.status !== "done") finished += 1;
          if (next.status === "failed" && row.status !== "failed") failed += 1;
        } catch (err) {
          logger.error({ err, jobId: row.id }, "code render: tick failed for a job");
        }
      }
      return { checked: rows.length, finished, failed };
    },
  };
}

export type CodeRenderService = ReturnType<typeof codeRenderService>;
