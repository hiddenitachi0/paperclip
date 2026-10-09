import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, reportFixtures, reportScriptRuns, reportScriptVersions, reportScripts } from "@paperclipai/db";
import {
  REPORT_SCRIPT_STDLIB_ONLY_MESSAGE,
  isForbiddenReportScriptPackagingFile,
  type CreateReportFixtureInput,
  type CreateReportScriptInput,
  type CreateReportScriptVersionInput,
  type ReportFixture,
  type ReportFixtureCheckResult,
  type ReportFixtureDiff,
  type ReportScript,
  type ReportScriptApprovalFixtureResult,
  type ReportScriptApprovalOutcome,
  type ReportScriptRun,
  type ReportScriptRunTrigger,
  type ReportScriptVersion,
} from "@paperclipai/shared";
import { conflict, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { computeScriptFingerprint, reportScriptRunner, type ReportScriptRunner } from "./report-script-runner.js";

/**
 * DUR-4072 PR1: script identities, immutable versions, fixtures, the
 * approval card and the execution ledger. Every query filters on the
 * caller's company; an id from another company is simply "not found".
 *
 * APPROVAL FIRST. Agents (and people) may only DRAFT: create a script, add a
 * version, add fixtures, and ask for approval. No code from a version runs
 * -- not even against a fixture -- until a company owner/admin, a person,
 * approves that exact source digest. The approve action is the first time
 * the code ever runs: it runs every fixture, records the results on the
 * approval card, and switches the version on only if every fixture passed.
 *
 * Approved scripts run with the Paperclip server's own operating-system
 * user (see report-script-runner.ts): approving one means trusting it. The
 * card says so in plain words and shows the full source.
 *
 * Every execution goes through `execute()`, which (1) re-reads the version
 * from the database and recomputes its digest from the stored files,
 * refusing on any mismatch, (2) enforces a per-company concurrency limit and
 * an hourly run budget, and (3) writes a report_script_runs row.
 */

export const REPORT_SCRIPT_APPROVAL_KIND = "report_script_version";
/** Most fixtures one version may carry: the owner's approve action runs all of them. */
export const REPORT_SCRIPT_MAX_FIXTURES_PER_VERSION = 10;
export const DEFAULT_REPORT_SCRIPT_MAX_CONCURRENT_PER_COMPANY = 2;
export const DEFAULT_REPORT_SCRIPT_MAX_CONCURRENT_GLOBAL = 4;
export const DEFAULT_REPORT_SCRIPT_MAX_RUNS_PER_HOUR = 60;

export const REPORT_SCRIPT_TRUST_WARNING =
  "Approved calculation scripts run on the Paperclip server with the server's own access: they can read the " +
  "server's files and settings (including secrets) and may reach other machines on the network. Paperclip does " +
  "not sandbox them yet. Approve only code you have read and trust.";

/**
 * Process-wide run slots, shared by every service instance (the scripts and
 * the templates routes each build their own service). One Paperclip server
 * process runs these scripts, so in-memory counting is the real limit.
 */
export class ReportScriptRunLimiter {
  private readonly perCompany = new Map<string, number>();
  private global = 0;
  constructor(
    readonly maxPerCompany = DEFAULT_REPORT_SCRIPT_MAX_CONCURRENT_PER_COMPANY,
    readonly maxGlobal = DEFAULT_REPORT_SCRIPT_MAX_CONCURRENT_GLOBAL,
  ) {}

  /** Returns a release function, or null when no slot is free. */
  tryAcquire(companyId: string): (() => void) | null {
    const current = this.perCompany.get(companyId) ?? 0;
    if (current >= this.maxPerCompany || this.global >= this.maxGlobal) return null;
    this.perCompany.set(companyId, current + 1);
    this.global += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = (this.perCompany.get(companyId) ?? 1) - 1;
      if (now <= 0) this.perCompany.delete(companyId);
      else this.perCompany.set(companyId, now);
      this.global = Math.max(0, this.global - 1);
    };
  }

  active(companyId: string): number {
    return this.perCompany.get(companyId) ?? 0;
  }
}

const defaultLimiter = new ReportScriptRunLimiter();

export interface ReportScriptsServiceDeps {
  runner?: ReportScriptRunner;
  limiter?: ReportScriptRunLimiter;
  maxRunsPerHour?: number;
}

export interface ApproveVersionActor {
  userId: string;
  /** The digest the approver saw on the card. Must equal the version's digest. */
  sha256: string;
}

type Actor = { agentId?: string; userId?: string; runId?: string };

function toScriptSummary(row: typeof reportScripts.$inferSelect): ReportScript {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name,
    description: row.description,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersionSummary(row: typeof reportScriptVersions.$inferSelect): ReportScriptVersion {
  return {
    id: row.id,
    companyId: row.companyId,
    scriptId: row.scriptId,
    versionNo: row.versionNo,
    files: row.files,
    entrypoint: row.entrypoint,
    sha256: row.sha256,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    status: row.status,
    changeSummary: row.changeSummary,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    approvalId: row.approvalId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFixtureSummary(row: typeof reportFixtures.$inferSelect): ReportFixture {
  return {
    id: row.id,
    companyId: row.companyId,
    scriptVersionId: row.scriptVersionId,
    name: row.name,
    input: row.input,
    expectedOutput: row.expectedOutput,
    tolerance: Number(row.tolerance),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRunSummary(row: typeof reportScriptRuns.$inferSelect): ReportScriptRun {
  return {
    id: row.id,
    companyId: row.companyId,
    scriptVersionId: row.scriptVersionId,
    fixtureId: row.fixtureId,
    trigger: row.trigger,
    input: row.input,
    inputSha256: row.inputSha256,
    output: row.output,
    outputSha256: row.outputSha256,
    scriptSha256: row.scriptSha256,
    runtimeFingerprint: row.runtimeFingerprint,
    status: row.status,
    durationMs: row.durationMs,
    error: row.error,
    fixtureResult: (row.fixtureResult as ReportFixtureCheckResult | null) ?? null,
    requestedByAgentId: row.requestedByAgentId,
    requestedByUserId: row.requestedByUserId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * A number-by-number comparison of `actual` against `expected`. Every path
 * where a finite number sits in `expected` is checked against the same path
 * in `actual` within `tolerance` (absolute difference); a structural
 * mismatch (missing key, wrong type, array length) is also a diff.
 */
export function compareFixtureOutput(expected: unknown, actual: unknown, tolerance: number): ReportFixtureDiff[] {
  const diffs: ReportFixtureDiff[] = [];
  function walk(exp: unknown, act: unknown, path: string): void {
    if (typeof exp === "number" && Number.isFinite(exp)) {
      const actNum = typeof act === "number" ? act : NaN;
      if (!Number.isFinite(actNum) || Math.abs(actNum - exp) > tolerance) {
        diffs.push({ path, expected: exp, actual: act });
      }
      return;
    }
    if (Array.isArray(exp)) {
      if (!Array.isArray(act) || act.length !== exp.length) {
        diffs.push({ path, expected: exp, actual: act });
        return;
      }
      exp.forEach((item, i) => walk(item, act[i], `${path}[${i}]`));
      return;
    }
    if (exp && typeof exp === "object") {
      if (!act || typeof act !== "object") {
        diffs.push({ path, expected: exp, actual: act });
        return;
      }
      for (const key of Object.keys(exp as Record<string, unknown>)) {
        walk((exp as Record<string, unknown>)[key], (act as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (exp !== act) diffs.push({ path, expected: exp, actual: act });
  }
  walk(expected, actual, "");
  return diffs;
}

/** Service-level copy of the validator's stdlib-only rule, so no caller can skip it. */
function assertStandardLibraryOnly(input: { files: Record<string, string>; lockfile?: unknown }) {
  if (input.lockfile !== undefined && input.lockfile !== null) throw unprocessable(REPORT_SCRIPT_STDLIB_ONLY_MESSAGE);
  const offending = Object.keys(input.files).filter(isForbiddenReportScriptPackagingFile);
  if (offending.length > 0) throw unprocessable(REPORT_SCRIPT_STDLIB_ONLY_MESSAGE, { files: offending });
}

function describeFixtureOutcome(run: ReportScriptRun): string {
  if (run.status === "fingerprint_mismatch") return "Not run: the stored code does not match the approved code.";
  if (run.status === "timeout") return run.error ?? "Took too long and was stopped.";
  if (run.fixtureResult?.ok) return "Matched every number.";
  if (run.fixtureResult && !run.fixtureResult.ok) {
    const n = run.fixtureResult.diffs.length;
    return `${n} number${n === 1 ? "" : "s"} did not match.`;
  }
  return run.error ?? "Did not finish.";
}

export function reportScriptsService(db: Db, deps: ReportScriptsServiceDeps = {}) {
  const runner = deps.runner ?? reportScriptRunner();
  const limiter = deps.limiter ?? defaultLimiter;
  const maxRunsPerHour = deps.maxRunsPerHour ?? DEFAULT_REPORT_SCRIPT_MAX_RUNS_PER_HOUR;

  async function listScripts(companyId: string): Promise<ReportScript[]> {
    const rows = await db.select().from(reportScripts).where(eq(reportScripts.companyId, companyId)).orderBy(desc(reportScripts.createdAt));
    return rows.map(toScriptSummary);
  }

  async function createScript(companyId: string, input: CreateReportScriptInput, actor: Actor): Promise<ReportScript> {
    const existing = await db
      .select({ id: reportScripts.id })
      .from(reportScripts)
      .where(and(eq(reportScripts.companyId, companyId), eq(reportScripts.key, input.key)))
      .limit(1);
    if (existing.length > 0) throw conflict(`A report script with key "${input.key}" already exists.`);
    const [row] = await db
      .insert(reportScripts)
      .values({
        companyId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();
    return toScriptSummary(row!);
  }

  async function getScript(companyId: string, scriptId: string): Promise<typeof reportScripts.$inferSelect> {
    const rows = await db
      .select()
      .from(reportScripts)
      .where(and(eq(reportScripts.id, scriptId), eq(reportScripts.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report script not found");
    return row;
  }

  async function listVersions(companyId: string, scriptId: string): Promise<ReportScriptVersion[]> {
    await getScript(companyId, scriptId);
    const rows = await db
      .select()
      .from(reportScriptVersions)
      .where(and(eq(reportScriptVersions.scriptId, scriptId), eq(reportScriptVersions.companyId, companyId)))
      .orderBy(desc(reportScriptVersions.versionNo));
    return rows.map(toVersionSummary);
  }

  async function getVersion(companyId: string, versionId: string): Promise<typeof reportScriptVersions.$inferSelect> {
    const rows = await db
      .select()
      .from(reportScriptVersions)
      .where(and(eq(reportScriptVersions.id, versionId), eq(reportScriptVersions.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report script version not found");
    return row;
  }

  async function createVersion(
    companyId: string,
    scriptId: string,
    input: CreateReportScriptVersionInput,
    actor: Actor,
  ): Promise<ReportScriptVersion> {
    assertStandardLibraryOnly(input);
    await getScript(companyId, scriptId);
    const sha256 = computeScriptFingerprint({ files: input.files, entrypoint: input.entrypoint });
    const nextVersionRow = await db
      .select({ maxVersion: sql<number>`coalesce(max(${reportScriptVersions.versionNo}), 0)` })
      .from(reportScriptVersions)
      .where(eq(reportScriptVersions.scriptId, scriptId));
    const versionNo = Number(nextVersionRow[0]?.maxVersion ?? 0) + 1;
    const [row] = await db
      .insert(reportScriptVersions)
      .values({
        companyId,
        scriptId,
        versionNo,
        files: input.files,
        entrypoint: input.entrypoint,
        sha256,
        inputSchema: input.inputSchema,
        outputSchema: input.outputSchema,
        status: "draft",
        changeSummary: input.changeSummary ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();
    return toVersionSummary(row!);
  }

  async function createFixture(companyId: string, versionId: string, input: CreateReportFixtureInput): Promise<ReportFixture> {
    const version = await getVersion(companyId, versionId);
    if (version.status === "retired") throw unprocessable("Cannot add a saved example to a retired script version.");
    const [{ n }] = await db
      .select({ n: count() })
      .from(reportFixtures)
      .where(and(eq(reportFixtures.scriptVersionId, versionId), eq(reportFixtures.companyId, companyId)));
    if (Number(n) >= REPORT_SCRIPT_MAX_FIXTURES_PER_VERSION) {
      throw unprocessable(`A script version can have at most ${REPORT_SCRIPT_MAX_FIXTURES_PER_VERSION} saved examples.`);
    }
    const [row] = await db
      .insert(reportFixtures)
      .values({
        companyId,
        scriptVersionId: versionId,
        name: input.name,
        input: input.input ?? null,
        expectedOutput: input.expectedOutput ?? null,
        tolerance: String(input.tolerance),
      })
      .returning();
    return toFixtureSummary(row!);
  }

  async function listFixtureRows(companyId: string, versionId: string) {
    return db
      .select()
      .from(reportFixtures)
      .where(and(eq(reportFixtures.scriptVersionId, versionId), eq(reportFixtures.companyId, companyId)))
      .orderBy(reportFixtures.createdAt);
  }

  async function listFixtures(companyId: string, versionId: string): Promise<ReportFixture[]> {
    await getVersion(companyId, versionId);
    return (await listFixtureRows(companyId, versionId)).map(toFixtureSummary);
  }

  async function getFixture(companyId: string, fixtureId: string): Promise<typeof reportFixtures.$inferSelect> {
    const rows = await db.select().from(reportFixtures).where(and(eq(reportFixtures.id, fixtureId), eq(reportFixtures.companyId, companyId))).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report fixture not found");
    return row;
  }

  async function assertRunBudget(companyId: string, runsNeeded: number) {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [{ n }] = await db
      .select({ n: count() })
      .from(reportScriptRuns)
      .where(and(eq(reportScriptRuns.companyId, companyId), gte(reportScriptRuns.createdAt, since)));
    if (Number(n) + runsNeeded > maxRunsPerHour) {
      throw tooManyRequests(
        `This company has used its ${maxRunsPerHour} calculation runs for the last hour. Try again later.`,
        { code: "report_script_rate_limited" },
      );
    }
  }

  /**
   * The ONLY place a script version's code is handed to the runner.
   *
   * `trigger: 'approval_check'` is the owner's approve action running the
   * fixtures of a not-yet-approved version; it is only ever called from
   * approveVersion(). Every other trigger requires status 'approved'.
   * Concurrency and the hourly budget are checked by the caller
   * (`withRunSlot`), so a multi-fixture approval holds one slot throughout.
   */
  async function execute(
    companyId: string,
    versionId: string,
    input: unknown,
    meta: { trigger: ReportScriptRunTrigger; fixtureId: string | null; actor: Actor; approvedSha256?: string },
  ): Promise<typeof reportScriptRuns.$inferSelect> {
    // Re-read from the database right before running: never trust a copy
    // the caller held, nor anything on disk.
    const version = await getVersion(companyId, versionId);
    if (meta.trigger === "approval_check") {
      if (version.status !== "draft" && version.status !== "awaiting_approval") {
        throw unprocessable("This script version is not waiting for approval.");
      }
    } else if (version.status !== "approved") {
      throw unprocessable(
        "This calculation has not been approved yet, so it cannot run. A company owner or admin has to approve it first; the approval runs its saved examples.",
        { code: "report_script_not_approved" },
      );
    }

    const recomputed = computeScriptFingerprint({ files: version.files, entrypoint: version.entrypoint });
    const expected = meta.approvedSha256 ?? version.sha256;
    const inputJson = JSON.stringify(input ?? null);
    const baseRow = {
      companyId,
      scriptVersionId: versionId,
      fixtureId: meta.fixtureId,
      trigger: meta.trigger,
      input: input ?? null,
      inputSha256: sha256Hex(inputJson),
      scriptSha256: recomputed,
      requestedByAgentId: meta.actor.agentId ?? null,
      requestedByUserId: meta.actor.userId ?? null,
      requestedByRunId: meta.actor.runId ?? null,
    };

    if (recomputed !== version.sha256 || recomputed !== expected) {
      const [refused] = await db
        .insert(reportScriptRuns)
        .values({
          ...baseRow,
          status: "fingerprint_mismatch",
          runtimeFingerprint: null,
          durationMs: 0,
          error: "The stored code does not match the approved code (its digest changed). Nothing was run.",
          finishedAt: new Date(),
        })
        .returning();
      return refused!;
    }

    const [started] = await db
      .insert(reportScriptRuns)
      .values({ ...baseRow, status: "running", runtimeFingerprint: recomputed })
      .returning();

    const outcome = await runner.run({ files: version.files, entrypoint: version.entrypoint }, input);

    let status: (typeof reportScriptRuns.$inferSelect)["status"] = outcome.status;
    let fixtureResult: ReportFixtureCheckResult | null = null;
    if (outcome.status === "succeeded" && meta.fixtureId) {
      const fixture = await getFixture(companyId, meta.fixtureId);
      const tolerance = Number(fixture.tolerance);
      const diffs = compareFixtureOutput(fixture.expectedOutput, outcome.output, tolerance);
      fixtureResult = { ok: diffs.length === 0, tolerance, diffs };
      if (!fixtureResult.ok) status = "failed";
    }
    const [finished] = await db
      .update(reportScriptRuns)
      .set({
        status,
        output: outcome.status === "succeeded" ? outcome.output : null,
        outputSha256: outcome.status === "succeeded" ? outcome.outputSha256 : null,
        runtimeFingerprint: outcome.runtimeFingerprint,
        durationMs: outcome.durationMs,
        error: outcome.status === "succeeded" ? (fixtureResult && !fixtureResult.ok ? "The output did not match the saved example." : null) : outcome.error,
        fixtureResult: fixtureResult as unknown as Record<string, unknown> | null,
        finishedAt: new Date(),
      })
      .where(eq(reportScriptRuns.id, started!.id))
      .returning();
    return finished!;
  }

  /** Holds one run slot for the company for the whole of `fn`, after checking the hourly budget. */
  async function withRunSlot<T>(companyId: string, runsNeeded: number, fn: () => Promise<T>): Promise<T> {
    await assertRunBudget(companyId, runsNeeded);
    const release = limiter.tryAcquire(companyId);
    if (!release) {
      throw tooManyRequests(
        "Too many calculations are running right now for this company. Wait for them to finish and try again.",
        { code: "report_script_busy" },
      );
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Re-runs one fixture of an APPROVED version (for example to re-check it
   * later). Never runs a draft: before approval, the only way any code runs
   * is the owner's approve action.
   */
  async function runFixture(companyId: string, versionId: string, fixtureId: string, actor: Actor): Promise<ReportScriptRun> {
    const version = await getVersion(companyId, versionId);
    const fixture = await getFixture(companyId, fixtureId);
    if (fixture.scriptVersionId !== versionId) throw notFound("Report fixture not found");
    if (version.status !== "approved") {
      throw unprocessable(
        "This calculation has not been approved yet, so its code cannot run -- not even on a saved example. " +
          "Ask for approval: the owner's approval runs every saved example and shows the results.",
        { code: "report_script_not_approved" },
      );
    }
    const row = await withRunSlot(companyId, 1, () =>
      execute(companyId, versionId, fixture.input, { trigger: "fixture_test", fixtureId, actor }),
    );
    return toRunSummary(row);
  }

  async function listRuns(companyId: string, versionId: string): Promise<ReportScriptRun[]> {
    await getVersion(companyId, versionId);
    const rows = await db
      .select()
      .from(reportScriptRuns)
      .where(and(eq(reportScriptRuns.scriptVersionId, versionId), eq(reportScriptRuns.companyId, companyId)))
      .orderBy(desc(reportScriptRuns.createdAt));
    return rows.map(toRunSummary);
  }

  async function getCard(companyId: string, approvalId: string | null) {
    if (!approvalId) return null;
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Files the approval card for a draft version: plain-language summary,
   * the trust warning, the FULL source and the list of saved examples.
   * Agents may call this; it runs nothing.
   */
  async function requestApproval(
    companyId: string,
    versionId: string,
    actor: Actor,
    note?: string,
  ): Promise<{ version: ReportScriptVersion; approvalId: string }> {
    const version = await getVersion(companyId, versionId);
    if (version.status === "approved") throw conflict("This script version is already approved.");
    if (version.status === "retired") throw unprocessable("This script version is retired.");
    const existingCard = await getCard(companyId, version.approvalId);
    if (existingCard && existingCard.status === "pending") {
      return { version: toVersionSummary(version), approvalId: existingCard.id };
    }
    const fixtures = await listFixtureRows(companyId, versionId);
    if (fixtures.length === 0) {
      throw unprocessable(
        "Add at least one saved example (an input and the numbers it must produce) before asking for approval: the approval runs them.",
      );
    }
    const script = await getScript(companyId, version.scriptId);
    const fileCount = Object.keys(version.files).length;
    const payload: Record<string, unknown> = {
      kind: REPORT_SCRIPT_APPROVAL_KIND,
      title: `Approve calculation "${script.name}" (version ${version.versionNo})`,
      summary:
        `A new version of the report calculation "${script.name}" is waiting for you. It has not run yet -- not even on a test.\n` +
        `If you approve, Paperclip first runs it on its ${fixtures.length} saved example${fixtures.length === 1 ? "" : "s"} ` +
        `and switches it on only if every number matches. If anything does not match, nothing is switched on and the results are shown here.` +
        (version.changeSummary ? `\n\nWhat changed: ${version.changeSummary}` : "") +
        (note ? `\n\nNote: ${note}` : ""),
      recommendedAction: `Read all ${fileCount} file${fileCount === 1 ? "" : "s"} of code below before approving. ${REPORT_SCRIPT_TRUST_WARNING}`,
      nextActionOnApproval: "Paperclip runs the saved examples. Only if all of them match is this version switched on for reports.",
      risks: [REPORT_SCRIPT_TRUST_WARNING],
      trustWarning: REPORT_SCRIPT_TRUST_WARNING,
      scriptId: script.id,
      scriptKey: script.key,
      scriptName: script.name,
      versionId: version.id,
      versionNo: version.versionNo,
      sha256: version.sha256,
      entrypoint: version.entrypoint,
      files: version.files,
      changeSummary: version.changeSummary,
      fixtures: fixtures.map((f) => ({ id: f.id, name: f.name, tolerance: Number(f.tolerance) })),
      fixtureResults: null,
      fixtureCheckedAt: null,
    };
    if (existingCard && existingCard.status === "revision_requested") {
      // Sent back: reopen the SAME card with a payload rebuilt from the
      // stored version (never from anything the requester sends).
      await db
        .update(approvals)
        .set({ status: "pending", payload, decisionNote: null, decidedByUserId: null, decidedAt: null, updatedAt: new Date() })
        .where(eq(approvals.id, existingCard.id));
      return { version: toVersionSummary(version), approvalId: existingCard.id };
    }
    // No explicit transaction: routes run on the request-scoped db, which
    // does not allow one. A card left behind by a failed second step is
    // harmless -- it cannot be approved unless its version is.
    const [card] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        requestedByAgentId: actor.agentId ?? null,
        requestedByUserId: actor.userId ?? null,
        status: "pending",
        payload,
      })
      .returning();
    await db
      .update(reportScriptVersions)
      .set({ status: "awaiting_approval", approvalId: card!.id })
      .where(and(eq(reportScriptVersions.id, versionId), inArray(reportScriptVersions.status, ["draft", "awaiting_approval"])));
    const updated = await getVersion(companyId, versionId);
    return { version: toVersionSummary(updated), approvalId: card!.id };
  }

  /**
   * The owner/admin's approve action -- the first time this version's code
   * ever runs. Callers (routes) must already have checked the actor is a
   * person who is a company owner/admin or instance admin.
   *
   * 1. The card must exist, be open, and show the same digest the approver
   *    names; the digest recomputed from the stored files must match too.
   * 2. Every saved example runs (holding one run slot); results are written
   *    onto the card, so the card shows them whatever the outcome.
   * 3. Only if every example matched is the version set to 'approved'.
   *
   * This does not change the card's own status; the caller resolves the
   * card afterwards (approvals.ts refuses to mark a report-script card
   * approved unless its version is approved with the same digest).
   */
  async function approveVersion(companyId: string, versionId: string, actor: ApproveVersionActor): Promise<ReportScriptApprovalOutcome> {
    const version = await getVersion(companyId, versionId);
    if (version.status === "approved") {
      if (version.sha256 !== actor.sha256) throw conflict("A different version of this code is the approved one.");
      return { approved: true, version: toVersionSummary(version), fixtureResults: [], message: null };
    }
    if (version.status === "retired") throw unprocessable("This script version is retired.");
    const card = await getCard(companyId, version.approvalId);
    if (!card || (card.status !== "pending" && card.status !== "revision_requested")) {
      throw unprocessable("There is no open approval card for this version. Ask for approval first, so the card shows the full code.");
    }
    const cardSha = (card.payload as Record<string, unknown>)?.sha256;
    if (actor.sha256 !== version.sha256 || cardSha !== version.sha256) {
      throw conflict("The code changed since the approval card was filed. Nothing was run and nothing was approved.", {
        code: "report_script_digest_mismatch",
      });
    }
    const recomputed = computeScriptFingerprint({ files: version.files, entrypoint: version.entrypoint });
    if (recomputed !== version.sha256) {
      throw conflict("The stored code does not match its recorded digest. Nothing was run and nothing was approved.", {
        code: "report_script_digest_mismatch",
      });
    }
    const fixtures = await listFixtureRows(companyId, versionId);
    if (fixtures.length === 0) throw unprocessable("This version has no saved examples to check, so it cannot be approved.");

    const fixtureResults: ReportScriptApprovalFixtureResult[] = await withRunSlot(companyId, fixtures.length, async () => {
      const results: ReportScriptApprovalFixtureResult[] = [];
      for (const fixture of fixtures) {
        const row = await execute(companyId, versionId, fixture.input, {
          trigger: "approval_check",
          fixtureId: fixture.id,
          actor: { userId: actor.userId },
          approvedSha256: actor.sha256,
        });
        const run = toRunSummary(row);
        results.push({
          fixtureId: fixture.id,
          fixtureName: fixture.name,
          runId: run.id,
          status: run.status,
          ok: run.status === "succeeded" && run.fixtureResult?.ok === true,
          summary: describeFixtureOutcome(run),
          error: run.error,
          diffs: (run.fixtureResult?.diffs ?? []).slice(0, 20),
        });
      }
      return results;
    });

    const passed = fixtureResults.filter((r) => r.ok).length;
    const allPassed = passed === fixtureResults.length;
    await db
      .update(approvals)
      .set({
        payload: { ...(card.payload as Record<string, unknown>), fixtureResults, fixtureCheckedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, card.id));

    if (!allPassed) {
      return {
        approved: false,
        version: toVersionSummary(version),
        fixtureResults,
        message: `${fixtureResults.length - passed} of ${fixtureResults.length} saved examples did not match, so this calculation was NOT switched on. The results are on the approval card.`,
      };
    }

    const [row] = await db
      .update(reportScriptVersions)
      .set({ status: "approved", approvedByUserId: actor.userId, approvedAt: new Date() })
      .where(
        and(
          eq(reportScriptVersions.id, versionId),
          eq(reportScriptVersions.sha256, actor.sha256),
          inArray(reportScriptVersions.status, ["draft", "awaiting_approval"]),
        ),
      )
      .returning();
    if (!row) {
      const current = await getVersion(companyId, versionId);
      if (current.status === "approved" && current.sha256 === actor.sha256) {
        return { approved: true, version: toVersionSummary(current), fixtureResults, message: null };
      }
      throw conflict("This version changed while its examples were running. Nothing was approved.");
    }
    return { approved: true, version: toVersionSummary(row), fixtureResults, message: null };
  }

  /** The version whose OWN approval card `approvalId` is (found via the version's link, not the card payload). */
  async function versionForCard(companyId: string, approvalId: string) {
    const rows = await db
      .select()
      .from(reportScriptVersions)
      .where(and(eq(reportScriptVersions.approvalId, approvalId), eq(reportScriptVersions.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Approve from an approval card. The card is only the button: the version
   * is the one whose own approval_id is this card, and the digest approved
   * is the stored version's -- nothing from the card payload is trusted.
   */
  async function approveFromCard(companyId: string, approvalId: string, userId: string): Promise<ReportScriptApprovalOutcome> {
    const version = await versionForCard(companyId, approvalId);
    if (!version) {
      throw unprocessable(
        "This card is not the approval card of any calculation version, so it cannot approve anything. Do not trust the code it shows.",
        { code: "report_script_card_not_linked" },
      );
    }
    return approveVersion(companyId, version.id, { userId, sha256: version.sha256 });
  }

  /**
   * The code an approval card stands for, read from the stored version (the
   * card UI shows this, never the payload's copy). `matchesCard` is false if
   * the payload's digest differs from the stored one.
   */
  async function getCardSource(companyId: string, approvalId: string) {
    const card = await getCard(companyId, approvalId);
    const version = card ? await versionForCard(companyId, approvalId) : null;
    if (!card || !version) {
      throw notFound("This card is not linked to any calculation version. Do not approve it.");
    }
    const script = await getScript(companyId, version.scriptId);
    const recomputed = computeScriptFingerprint({ files: version.files, entrypoint: version.entrypoint });
    const cardSha = (card.payload as Record<string, unknown> | null)?.sha256;
    return {
      approvalId,
      versionId: version.id,
      versionNo: version.versionNo,
      scriptName: script.name,
      status: version.status,
      entrypoint: version.entrypoint,
      files: version.files,
      sha256: version.sha256,
      storedCodeMatchesDigest: recomputed === version.sha256,
      matchesCard: cardSha === version.sha256,
    };
  }

  return {
    approveFromCard,
    getCardSource,
    listScripts,
    createScript,
    getScript: (companyId: string, scriptId: string) => getScript(companyId, scriptId).then(toScriptSummary),
    listVersions,
    getVersion: (companyId: string, versionId: string) => getVersion(companyId, versionId).then(toVersionSummary),
    createVersion,
    createFixture,
    listFixtures,
    runFixture,
    listRuns,
    requestApproval,
    approveVersion,
    /** Internal: for report runs (PR2). Approved versions only; holds a run slot. */
    executeApproved: (companyId: string, versionId: string, input: unknown, trigger: "report_run", actor: Actor) =>
      withRunSlot(companyId, 1, () => execute(companyId, versionId, input, { trigger, fixtureId: null, actor })).then(toRunSummary),
  };
}

export type ReportScriptsService = ReturnType<typeof reportScriptsService>;
