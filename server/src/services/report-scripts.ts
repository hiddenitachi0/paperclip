import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { reportFixtures, reportScriptRuns, reportScriptVersions, reportScripts } from "@paperclipai/db";
import type {
  CreateReportFixtureInput,
  CreateReportScriptInput,
  CreateReportScriptVersionInput,
  ReportFixture,
  ReportFixtureCheckResult,
  ReportFixtureDiff,
  ReportScript,
  ReportScriptRun,
  ReportScriptVersion,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { computeScriptFingerprint, reportScriptRunner, type ReportScriptRunner } from "./report-script-runner.js";

/**
 * DUR-4072 PR1: script identities, immutable versions, fixtures and the
 * execution ledger. Every query filters on the caller's company; an id from
 * another company is simply "not found", the same rule every other
 * company-scoped service in this file's neighbourhood follows.
 *
 * Agents may create scripts, draft versions, fixtures and run fixture tests
 * (a draft never touches real data -- report_run triggers are for PR2).
 * Only `approveVersion` may move a version to 'approved', and it is never
 * called from an agent-reachable route (see report-scripts.ts routes):
 * that is the ticket's "a new or changed script never goes live without
 * Filip's approval card showing the test results".
 */
export interface ReportScriptsServiceDeps {
  runner?: ReportScriptRunner;
}

export interface ApproveVersionActor {
  userId: string;
}

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
    lockfile: row.lockfile,
    sha256: row.sha256,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    status: row.status,
    changeSummary: row.changeSummary,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
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
 * mismatch (missing key, wrong type, array length) is also a diff. This is
 * deliberately number-shaped rather than a deep-equal: the ticket's
 * "reproduce to the krone" is a claim about the FIGURES, not about string
 * formatting or key order.
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

export function reportScriptsService(db: Db, deps: ReportScriptsServiceDeps = {}) {
  const runner = deps.runner ?? reportScriptRunner();

  async function listScripts(companyId: string): Promise<ReportScript[]> {
    const rows = await db.select().from(reportScripts).where(eq(reportScripts.companyId, companyId)).orderBy(desc(reportScripts.createdAt));
    return rows.map(toScriptSummary);
  }

  async function createScript(companyId: string, input: CreateReportScriptInput, actor: { agentId?: string; userId?: string }): Promise<ReportScript> {
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
    actor: { agentId?: string; userId?: string },
  ): Promise<ReportScriptVersion> {
    await getScript(companyId, scriptId);
    const sha256 = computeScriptFingerprint({ files: input.files, lockfile: input.lockfile ?? null, entrypoint: input.entrypoint });
    const nextVersionRow = await db
      .select({ maxVersion: sql<number>`coalesce(max(${reportScriptVersions.versionNo}), 0)` })
      .from(reportScriptVersions)
      .where(eq(reportScriptVersions.scriptId, scriptId));
    const versionNo = (nextVersionRow[0]?.maxVersion ?? 0) + 1;
    const [row] = await db
      .insert(reportScriptVersions)
      .values({
        companyId,
        scriptId,
        versionNo,
        files: input.files,
        entrypoint: input.entrypoint,
        lockfile: input.lockfile ?? null,
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
    if (version.status === "retired") throw unprocessable("Cannot add a fixture to a retired script version.");
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

  async function listFixtures(companyId: string, versionId: string): Promise<ReportFixture[]> {
    await getVersion(companyId, versionId);
    const rows = await db.select().from(reportFixtures).where(and(eq(reportFixtures.scriptVersionId, versionId), eq(reportFixtures.companyId, companyId)));
    return rows.map(toFixtureSummary);
  }

  async function getFixture(companyId: string, fixtureId: string): Promise<typeof reportFixtures.$inferSelect> {
    const rows = await db.select().from(reportFixtures).where(and(eq(reportFixtures.id, fixtureId), eq(reportFixtures.companyId, companyId))).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report fixture not found");
    return row;
  }

  /**
   * Runs a version's script against a fixture's input and compares the
   * output to the fixture's expected output within its tolerance. Always
   * records a report_script_runs row -- a failed comparison is not an
   * exception, it is the run's recorded result, exactly what the ticket's
   * approval card needs to show.
   */
  async function runFixture(
    companyId: string,
    versionId: string,
    fixtureId: string,
    actor: { agentId?: string; userId?: string; runId?: string },
  ): Promise<ReportScriptRun> {
    const version = await getVersion(companyId, versionId);
    const fixture = await getFixture(companyId, fixtureId);
    if (fixture.scriptVersionId !== versionId) throw notFound("Report fixture not found");

    const inputJson = JSON.stringify(fixture.input ?? null);
    const outcome = await runner.run(
      { sha256: version.sha256, files: version.files, entrypoint: version.entrypoint, lockfile: version.lockfile },
      fixture.input,
    );

    let output: unknown = null;
    let outputSha256: string | null = null;
    let fixtureResult: ReportFixtureCheckResult | null = null;
    let status: (typeof reportScriptRuns.$inferSelect)["status"] = outcome.status;
    let error: string | null = null;

    if (outcome.status === "succeeded") {
      output = outcome.output;
      outputSha256 = outcome.outputSha256;
      const tolerance = Number(fixture.tolerance);
      const diffs = compareFixtureOutput(fixture.expectedOutput, outcome.output, tolerance);
      fixtureResult = { ok: diffs.length === 0, tolerance, diffs };
      if (!fixtureResult.ok) status = "failed";
    } else {
      error = outcome.error;
    }

    const [row] = await db
      .insert(reportScriptRuns)
      .values({
        companyId,
        scriptVersionId: versionId,
        fixtureId,
        trigger: "fixture_test",
        input: fixture.input,
        inputSha256: sha256Hex(inputJson),
        output,
        outputSha256,
        scriptSha256: version.sha256,
        runtimeFingerprint: outcome.runtimeFingerprint,
        status,
        durationMs: outcome.durationMs,
        error,
        fixtureResult: fixtureResult as unknown as Record<string, unknown> | null,
        requestedByAgentId: actor.agentId ?? null,
        requestedByUserId: actor.userId ?? null,
        requestedByRunId: actor.runId ?? null,
        finishedAt: new Date(),
      })
      .returning();

    // A fixture test that fully passes is evidence this version is ready
    // for the approval card; a draft stays 'draft' until every fixture it
    // has passes, so "tested" always means "passed everything it was asked
    // to reproduce", not "ran once".
    if (fixtureResult?.ok && version.status === "draft") {
      const allFixtures = await db.select().from(reportFixtures).where(eq(reportFixtures.scriptVersionId, versionId));
      const allPass = await allFixturesPass(companyId, versionId, allFixtures);
      if (allPass) {
        await db.update(reportScriptVersions).set({ status: "tested" }).where(eq(reportScriptVersions.id, versionId));
      }
    }

    return toRunSummary(row!);
  }

  async function allFixturesPass(companyId: string, versionId: string, fixtures: Array<typeof reportFixtures.$inferSelect>): Promise<boolean> {
    if (fixtures.length === 0) return false;
    for (const fixture of fixtures) {
      const latestRun = await db
        .select()
        .from(reportScriptRuns)
        .where(and(eq(reportScriptRuns.scriptVersionId, versionId), eq(reportScriptRuns.fixtureId, fixture.id), eq(reportScriptRuns.companyId, companyId)))
        .orderBy(desc(reportScriptRuns.createdAt))
        .limit(1);
      const run = latestRun[0];
      if (!run || !(run.fixtureResult as ReportFixtureCheckResult | null)?.ok) return false;
    }
    return true;
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

  /**
   * Board-owner-only (enforced by the route, not just here -- but checked
   * again here as the service-layer invariant the schema's
   * approval_pair_check backs): a version must be 'tested' (every fixture it
   * has currently passes) before it can be approved. This is the ticket's
   * "never goes live without Filip's approval card showing the test
   * results" -- the card is built from listRuns() for this version, and this
   * function is the only path in the codebase that can set status:'approved'.
   */
  async function approveVersion(companyId: string, versionId: string, actor: ApproveVersionActor): Promise<ReportScriptVersion> {
    const version = await getVersion(companyId, versionId);
    if (version.status === "approved") return toVersionSummary(version);
    if (version.status !== "tested") {
      throw unprocessable("A script version can only be approved after it has passed every one of its fixtures ('tested' status).");
    }
    const [row] = await db
      .update(reportScriptVersions)
      .set({ status: "approved", approvedByUserId: actor.userId, approvedAt: new Date() })
      .where(eq(reportScriptVersions.id, versionId))
      .returning();
    return toVersionSummary(row!);
  }

  return {
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
    approveVersion,
  };
}

export type ReportScriptsService = ReturnType<typeof reportScriptsService>;
