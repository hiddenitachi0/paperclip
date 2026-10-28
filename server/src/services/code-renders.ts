import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, codeRenderJobs, issueAttachments, issues as issuesTable, withCompanyScope } from "@paperclipai/db";
import {
  CODE_RENDER_ACTIVE_STATUSES,
  CODE_RENDER_CHECK_RESERVE_SECONDS,
  CODE_RENDER_DEFAULT_LIMITS,
  CODE_RENDER_DURATION_SLACK_SECONDS,
  CODE_RENDER_HARD_MAX_VIDEO_SECONDS,
  CODE_RENDER_MAX_JOB_SECONDS,
  estimateCompositionSeconds,
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
 * provider money but takes the box's CPU, so they count seconds, not cents.
 * Every job is charged (requested_seconds; D7, see packages/shared
 * code-renders.ts): a render reserves the longer of the length it asks for
 * and the length its composition names, and a finished one keeps the longer
 * of that and its real length; a check, a contact sheet and any failed or
 * cancelled job keep the time the renderer really spent on it (the worker's
 * own clock); a job still in flight counts its reservation, or the time it
 * has run so far if that is more. An agent's job of any kind is refused with
 * a plain "ask a person" sentence when it would pass its own or the
 * company's daily minutes; a person's job only meets the per-render length
 * and the at-once limit. A paused or hard-stopped budget (company, or the
 * asking agent's own) refuses any job, the same rule every other spend path
 * follows.
 *
 * Finished files (a video can be 2 GB, D18) are streamed from the worker to
 * a temp file and from there into storage; never held in memory.
 *
 * Progress is collected two ways: lazily when someone reads a job, and by
 * the `codeRenders` scheduler chain for jobs nobody is watching. A finished
 * job is claimed (status `saving`) by a conditional update before its file is
 * copied, so two pollers can never save it twice.
 */

type Row = typeof codeRenderJobs.$inferSelect;

/** The worker handed back a video longer than the job was allowed (it should have refused it). */
class CodeRenderLengthError extends Error {
  constructor(
    readonly videoSeconds: number,
    allowedSeconds: number,
  ) {
    super(`The video is ${videoSeconds.toFixed(1)} seconds long, more than the ${allowedSeconds} seconds this job was allowed. It was not saved.`);
    this.name = "CodeRenderLengthError";
  }
}
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

export interface CodeRenderSaveInput {
  companyId: string;
  job: Row;
  filename: string;
  contentType: string;
  /** The finished file on the server's disk; removed by the service after the save. */
  filePath: string;
  byteSize: number;
}

export interface CodeRenderServiceDeps {
  worker?: CodeRenderWorkerClient;
  limits?: Partial<CodeRenderLimits>;
  /** Largest finished file the server accepts from the worker (default 2 GB, D18). */
  maxOutputBytes?: number;
  /** Where finished files wait between the worker and storage. Default: the OS temp folder. */
  workDir?: string;
  /** Reads one of the company's files. Default: the Files tables + company storage. */
  readCompanyFile?: (companyId: string, fileId: string, maxBytes: number) => Promise<{ bytes: Buffer; contentType: string }>;
  /** Saves the result by streaming the file into storage. Default: company storage + a Files row (or a task attachment). */
  saveFile?: (input: CodeRenderSaveInput) => Promise<CodeRenderSavedFile>;
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

/** Whole seconds from one time to another, rounded up; null when either is missing or unreadable. */
function secondsBetween(from: Date | string | null | undefined, to: Date | string | null | undefined): number | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - start) / 1000));
}

function numberOption(options: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The composition's entry file as text (content or base64), for the length estimate. */
function entryHtml(input: SubmitCodeRenderInput, entry: string): string | null {
  const file = input.files.find((f) => f.path === entry) ?? input.files.find((f) => f.path.toLowerCase() === entry.toLowerCase());
  if (!file) return null;
  return file.content ?? Buffer.from(file.contentBase64 ?? "", "base64").toString("utf8");
}

function isActive(status: string): boolean {
  return (CODE_RENDER_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Run time read from Paperclip's own clock: never more than one job can hold the renderer. */
function guessedRunSeconds(startedAt: Date | string | null | undefined, at: Date): number | null {
  const seconds = secondsBetween(startedAt, at);
  return seconds === null ? null : Math.min(seconds, CODE_RENDER_MAX_JOB_SECONDS);
}

/**
 * What a row counts against the daily caps right now. Finished: its charge.
 * Any job in flight: its reservation, or its run time so far if that is more
 * (every finished job is charged at least its run time). secondsTodayIn sums
 * the same rule in SQL.
 */
function chargedSecondsOf(row: Row, at: Date): number {
  if (!isActive(row.status)) return row.requestedSeconds;
  return Math.max(row.requestedSeconds, guessedRunSeconds(row.startedAt, at) ?? 0);
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

function toJob(row: Row, at: Date): CodeRenderJob {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as CodeRenderKind,
    status: row.status as CodeRenderStatus,
    title: row.title,
    issueId: row.issueId,
    durationSeconds: row.kind === "render" ? (numberOption(row.options, "durationSeconds") ?? row.requestedSeconds) : null,
    videoSeconds: row.videoMs === null ? null : row.videoMs / 1000,
    chargedSeconds: chargedSecondsOf(row, at),
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
  const workDir = deps.workDir ?? tmpdir();
  const now = deps.now ?? (() => new Date());
  const view = (row: Row) => toJob(row, now());
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

  /** One object, one asset row: a task attachment when the job names a task, else a company file. Streamed, never buffered. */
  async function defaultSaveFile(input: CodeRenderSaveInput) {
    const stored = await getStorageService().putFileFromPath({
      companyId: input.companyId,
      namespace: "code-renders",
      originalFilename: input.filename,
      contentType: input.contentType,
      filePath: input.filePath,
      maxBytes: maxOutputBytes,
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

  /**
   * Seconds counted against the daily caps today (UTC): every job of every
   * kind and status, failed and cancelled ones included, each at
   * chargedSecondsOf (a check or contact sheet in flight at its reservation
   * or its run time so far, whichever is more).
   */
  async function secondsTodayIn(tx: ScopedTx, companyId: string, agentId: string | null): Promise<number> {
    const at = now();
    const conditions = [eq(codeRenderJobs.companyId, companyId), gte(codeRenderJobs.createdAt, startOfUtcDay(at))];
    if (agentId) conditions.push(eq(codeRenderJobs.createdByAgentId, agentId));
    const runSoFar = sql`least(greatest(coalesce(ceil(extract(epoch from (${at.toISOString()}::timestamptz - ${codeRenderJobs.startedAt})))::int, 0), 0), ${CODE_RENDER_MAX_JOB_SECONDS})`;
    const inFlight = inArray(codeRenderJobs.status, [...CODE_RENDER_ACTIVE_STATUSES]);
    const charged = sql`case when ${inFlight} then greatest(${codeRenderJobs.requestedSeconds}, ${runSoFar}) else ${codeRenderJobs.requestedSeconds} end`;
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${charged}), 0)::int` })
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

  /**
   * The per-render length, against both the length asked for and the length
   * the composition names, and the two against each other: a render whose
   * composition runs longer than its durationSeconds is refused before it
   * reaches the renderer (it would only fail there after rendering).
   */
  function assertLength(input: SubmitCodeRenderInput, compositionSeconds: number | null) {
    const tooLong = (what: string) =>
      unprocessable(
        `A code-drawn video may be at most ${minutes(limits.maxVideoSeconds)} long; ${what}. Split it into parts, or ask a person to raise the limit.`,
        { reason: "too_long", maxVideoSeconds: limits.maxVideoSeconds },
      );
    if (input.kind === "render" && Math.ceil(input.durationSeconds ?? 0) > limits.maxVideoSeconds) {
      throw tooLong(`this one asks for ${minutes(Math.ceil(input.durationSeconds ?? 0))}`);
    }
    if (compositionSeconds !== null && compositionSeconds > limits.maxVideoSeconds + CODE_RENDER_DURATION_SLACK_SECONDS) {
      throw tooLong(`this composition runs ${minutes(Math.ceil(compositionSeconds))} (its data-start/data-duration)`);
    }
    if (input.kind === "render" && compositionSeconds !== null && compositionSeconds > (input.durationSeconds ?? 0) + CODE_RENDER_DURATION_SLACK_SECONDS) {
      throw unprocessable(
        `The composition runs ${compositionSeconds} seconds (its data-start/data-duration), but durationSeconds says ${input.durationSeconds}. ` +
          "Set durationSeconds to the composition's real length and send it again.",
        { reason: "duration_mismatch", compositionSeconds, durationSeconds: input.durationSeconds ?? null },
      );
    }
  }

  /** Jobs at once and daily minutes. Run under the company's cap lock when it decides an insert. */
  async function assertWithinCapsIn(tx: ScopedTx, companyId: string, actor: CodeRenderActor, reservedSeconds: number) {
    const active = await activeJobsIn(tx, companyId);
    if (active >= limits.maxActiveJobsPerCompany) {
      throw tooManyRequests(
        `${active} code-drawn video job${active === 1 ? " is" : "s are"} already waiting or running for this company. Try again when one has finished.`,
        { reason: "too_many_at_once", maxActiveJobs: limits.maxActiveJobsPerCompany },
      );
    }
    // Daily minutes are an agent limit: a person asking is the one who would
    // be asked. Every kind counts: a check or contact sheet holds the
    // renderer too.
    if (!actor.agentId) return;
    const companyUsed = await secondsTodayIn(tx, companyId, null);
    if (companyUsed + reservedSeconds > limits.companyDailyVideoSeconds) {
      throw tooManyRequests(
        `This company has used ${minutes(companyUsed)} of its ${minutes(limits.companyDailyVideoSeconds)} of code-drawn video time today. Stop here and ask a person whether to go on tomorrow or raise the limit.`,
        { reason: "company_daily_cap", usedSeconds: companyUsed, capSeconds: limits.companyDailyVideoSeconds, neededSeconds: reservedSeconds },
      );
    }
    const agentUsed = await secondsTodayIn(tx, companyId, actor.agentId);
    if (agentUsed + reservedSeconds > limits.agentDailyVideoSeconds) {
      throw tooManyRequests(
        `You have used ${minutes(agentUsed)} of your ${minutes(limits.agentDailyVideoSeconds)} of code-drawn video time today. Stop here and ask a person whether to go on.`,
        { reason: "agent_daily_cap", usedSeconds: agentUsed, capSeconds: limits.agentDailyVideoSeconds, neededSeconds: reservedSeconds },
      );
    }
  }

  /**
   * The time the renderer spent on a job: the worker's own clock when it
   * answered; else (the worker forgot the job, or could not be reached) from
   * when Paperclip saw it start, at most CODE_RENDER_MAX_JOB_SECONDS. A job
   * the worker never started costs nothing.
   */
  function busySeconds(row: Row, state: CodeRenderWorkerJob | null): number {
    if (state) return state.startedAt ? (secondsBetween(state.startedAt, state.finishedAt ?? now()) ?? 0) : 0;
    return guessedRunSeconds(row.startedAt, now()) ?? 0;
  }

  /**
   * A finished render keeps the longest of its reservation, its real length
   * and the renderer's time on it (a slow 1-second render must not cost 1 s
   * of a cap that counts renderer minutes); any other finished job keeps its
   * run time.
   */
  function finishedCharge(row: Row, state: CodeRenderWorkerJob): number {
    if (row.kind !== "render") return busySeconds(row, state);
    return Math.max(row.requestedSeconds, Math.ceil(state.result?.durationSeconds ?? 0), busySeconds(row, state));
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

  /** Marks a job failed and charges it `chargedSeconds` (the renderer's real time on it). */
  async function fail(row: Row, message: string, chargedSeconds: number): Promise<Row> {
    const updated = await update(
      row,
      { status: "failed", error: message, progressPct: null, finishedAt: now(), requestedSeconds: chargedSeconds },
      [...CODE_RENDER_ACTIVE_STATUSES],
    );
    if (updated) await logJob(updated, "code_render.failed", { error: message, chargedSeconds });
    return updated ?? (await loadRow(row.companyId, row.id));
  }

  /** Frees the job on the worker; answers the worker's last view of it (null when unknown or unreachable). */
  async function release(workerJobId: string): Promise<CodeRenderWorkerJob | null> {
    return worker.release(workerJobId).catch((err) => {
      logger.warn({ err, workerJobId }, "code render: releasing the worker job failed");
      return null;
    });
  }

  /**
   * Copies a finished job's result into the company and marks it done,
   * charged by finishedCharge. Caller holds the `saving` claim. The file goes
   * worker -> temp file -> storage as streams; the temp folder is always
   * removed.
   */
  async function collect(row: Row, done: CodeRenderWorkerJob): Promise<Row> {
    const workerJobId = row.workerJobId!;
    const chargedSeconds = finishedCharge(row, done);
    if (row.kind === "check") {
      const updated = await update(row, {
        status: "done",
        passed: done.result?.passed ?? null,
        report: tidyReport(done.result?.report ?? null),
        progressPct: null,
        finishedAt: now(),
        requestedSeconds: chargedSeconds,
      });
      await release(workerJobId);
      if (updated) await logJob(updated, "code_render.finished", { passed: updated.passed, chargedSeconds });
      return updated ?? row;
    }
    const videoSeconds = done.result?.durationSeconds ?? null;
    // The worker refuses a video longer than it was allowed; never take one on trust.
    if (row.kind === "render" && videoSeconds !== null && videoSeconds > row.requestedSeconds + CODE_RENDER_DURATION_SLACK_SECONDS) {
      throw new CodeRenderLengthError(videoSeconds, row.requestedSeconds);
    }
    const dir = await mkdtemp(join(workDir, "paperclip-code-render-"));
    try {
      const filePath = join(dir, "output");
      const output = await worker.downloadOutput(workerJobId, maxOutputBytes, filePath);
      const expected = row.kind === "render" ? ["video/mp4"] : ["image/jpeg", "image/png"];
      if (!expected.includes(output.contentType)) throw new Error(`The renderer returned ${output.contentType || "an unknown type"} instead of ${expected.join(" or ")}.`);
      const extension = output.contentType === "video/mp4" ? "mp4" : output.contentType === "image/png" ? "png" : "jpg";
      const base = row.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "code-render";
      const filename = row.kind === "snapshot" ? `${base}-contact-sheet.${extension}` : `${base}.${extension}`;
      const file = await saveFile({ companyId: row.companyId, job: row, filename, contentType: output.contentType, filePath, byteSize: output.bytes });
      const updated = await update(row, {
        status: "done",
        resultFileId: file.id,
        resultContentType: output.contentType,
        resultBytes: output.bytes,
        videoMs: videoSeconds === null ? null : Math.round(videoSeconds * 1000),
        progressPct: null,
        error: null,
        finishedAt: now(),
        requestedSeconds: chargedSeconds,
      });
      await release(workerJobId);
      if (updated) await logJob(updated, "code_render.finished", { fileId: file.id, bytes: output.bytes, videoSeconds, chargedSeconds });
      return updated ?? row;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err) => logger.warn({ err, jobId: row.id }, "code render: removing the temp file failed"));
    }
  }

  /** Moves one active job forward from the worker's state. Never throws for a worker hiccup. */
  async function advance(row: Row): Promise<Row> {
    if (!(CODE_RENDER_ACTIVE_STATUSES as readonly string[]).includes(row.status)) return row;
    const age = now().getTime() - row.updatedAt.getTime();
    if (row.status === "saving" && age < SAVING_STALE_MS) return row;
    if (!row.workerJobId) {
      return now().getTime() - row.createdAt.getTime() > UNSUBMITTED_STALE_MS ? fail(row, "The job never reached the renderer. Send it again.", 0) : row;
    }

    let state: CodeRenderWorkerJob | null;
    try {
      state = await worker.get(row.workerJobId);
    } catch (err) {
      logger.warn({ err, jobId: row.id }, "code render: status check failed; will retry");
      return row;
    }
    if (!state) {
      return fail(row, "The renderer restarted, or the finished file expired, before it was collected. Send the job again.", busySeconds(row, null));
    }

    if (state.status === "queued" || state.status === "running") {
      if (row.status === "saving") return row;
      const patch: Partial<typeof codeRenderJobs.$inferInsert> = { status: state.status, progressPct: state.progress?.pct ?? null };
      // The worker's own start time: what a job in flight is charged from.
      if (state.status === "running" && !row.startedAt) patch.startedAt = state.startedAt ? new Date(state.startedAt) : now();
      return (await update(row, patch, ["queued", "running"])) ?? row;
    }
    if (state.status === "failed" || state.status === "cancelled") {
      await release(row.workerJobId);
      const chargedSeconds = busySeconds(row, state);
      if (state.status === "cancelled") {
        const updated = await update(
          row,
          { status: "cancelled", error: state.error, progressPct: null, finishedAt: now(), requestedSeconds: chargedSeconds },
          [...CODE_RENDER_ACTIVE_STATUSES],
        );
        return updated ?? row;
      }
      return fail(row, state.error ?? "The render failed.", chargedSeconds);
    }

    // Done: claim it, so only one poller copies the file.
    const claimStatuses = row.status === "saving" ? ["saving"] : ["queued", "running"];
    const claimPatch: Partial<typeof codeRenderJobs.$inferInsert> = { status: "saving", progressPct: 100 };
    if (!row.startedAt && state.startedAt) claimPatch.startedAt = new Date(state.startedAt);
    const claimed = await update(row, claimPatch, claimStatuses);
    if (!claimed) return loadRow(row.companyId, row.id);
    try {
      return await collect(claimed, state);
    } catch (err) {
      logger.warn({ err, jobId: row.id }, "code render: collecting the result failed");
      const message = err instanceof Error ? err.message : String(err);
      await release(row.workerJobId);
      // The renderer did the work either way: a finished job keeps its charge.
      const chargedSeconds = err instanceof CodeRenderLengthError
        ? Math.max(row.requestedSeconds, Math.ceil(err.videoSeconds), busySeconds(claimed, state))
        : finishedCharge(claimed, state);
      const error = err instanceof CodeRenderLengthError ? err.message : `The video was made but could not be saved: ${message}`;
      const updated = await update(claimed, { status: "failed", error, progressPct: null, finishedAt: now(), requestedSeconds: chargedSeconds });
      if (updated) await logJob(updated, "code_render.failed", { error: updated.error, chargedSeconds });
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
      const entry = input.entry ?? "index.html";
      const html = entryHtml(input, entry);
      const compositionSeconds = html === null ? null : estimateCompositionSeconds(html);
      assertLength(input, compositionSeconds);
      // What the job holds against the daily caps until it is done (the
      // worker is told the same length for a render, and holds it to it).
      const reservedSeconds =
        input.kind === "render" ? Math.ceil(Math.max(input.durationSeconds ?? 0, compositionSeconds ?? 0)) : CODE_RENDER_CHECK_RESERVE_SECONDS;
      await assertBudgetOpen(companyId, actor.agentId);
      // Cheap early answer before any file is read; decided for real under the lock below.
      await withCompanyScope(db, companyId, (tx) => assertWithinCapsIn(tx, companyId, actor, reservedSeconds));
      const files = await buildFiles(companyId, input);

      const options = {
        entry,
        fps: input.fps ?? 30,
        quality: input.quality ?? "standard",
        frames: input.frames ?? 9,
        fileCount: input.files.length,
        assetCount: input.assets?.length ?? 0,
        durationSeconds: input.kind === "render" ? Math.ceil(input.durationSeconds ?? 0) : null,
        compositionSeconds,
      };
      // The row holds the slot (and the minutes) before the worker is asked.
      // One lock per company, so two submits at once cannot both pass the caps.
      const row = await withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`code_render_caps:${companyId}`}))`);
        await assertWithinCapsIn(tx, companyId, actor, reservedSeconds);
        const [inserted] = await tx
          .insert(codeRenderJobs)
          .values({
            companyId,
            kind: input.kind,
            status: "queued",
            title: input.title,
            issueId: input.issueId ?? null,
            requestedSeconds: reservedSeconds,
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
            maxDurationSeconds: input.kind === "render" ? reservedSeconds : limits.maxVideoSeconds,
          },
        });
      } catch (err) {
        const httpError = httpErrorFromWorker(err);
        // Refused before it ran: nothing to charge.
        await update(row!, { status: "failed", error: httpError.message, finishedAt: now(), requestedSeconds: 0 });
        await logJob(row!, "code_render.refused", { error: httpError.message });
        throw httpError;
      }
      const updated = (await update(row!, { workerJobId: accepted.id, status: accepted.status === "running" ? "running" : "queued" })) ?? row!;
      await logJob(updated, "code_render.submitted", {
        requestedSeconds: options.durationSeconds,
        reservedSeconds,
        compositionSeconds,
        fileCount: options.fileCount,
        assetCount: options.assetCount,
        issueId: updated.issueId,
      });
      return view(updated);
    },

    /** A job, moved forward first when it is still in flight. */
    async get(companyId: string, jobId: string): Promise<CodeRenderJob> {
      const row = await loadRow(companyId, jobId);
      return view(await advance(row));
    },

    async list(companyId: string, opts: { limit?: number } = {}): Promise<CodeRenderJob[]> {
      const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
      const rows = await withCompanyScope(db, companyId, (tx) =>
        tx.select().from(codeRenderJobs).where(eq(codeRenderJobs.companyId, companyId)).orderBy(desc(codeRenderJobs.createdAt)).limit(limit),
      );
      return rows.map(view);
    },

    async cancel(companyId: string, jobId: string, actor: CodeRenderActor): Promise<CodeRenderJob> {
      const row = await loadRow(companyId, jobId);
      if (!isActive(row.status) || row.status === "saving") return view(row);
      // Charged by the time the renderer had already spent on it.
      const state = row.workerJobId ? await release(row.workerJobId) : null;
      const chargedSeconds = row.workerJobId ? busySeconds(row, state) : 0;
      const updated = await update(
        row,
        { status: "cancelled", error: "Cancelled.", progressPct: null, finishedAt: now(), requestedSeconds: chargedSeconds },
        ["queued", "running"],
      );
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
          details: { kind: row.kind, title: row.title, chargedSeconds },
        }).catch((err) => logger.warn({ err, jobId: row.id }, "code render: activity log failed"));
      }
      return view(updated ?? (await loadRow(companyId, jobId)));
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
