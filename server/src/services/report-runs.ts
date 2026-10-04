import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { reportRuns, reportTemplates } from "@paperclipai/db";
import type { ReportRun } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { checkReportCommentaryNumbers } from "./report-number-check.js";
import type { ReportScriptsService } from "./report-scripts.js";
import { createOrReviseReportDocument } from "./report-templates.js";

export interface ReportRunsServiceDeps {
  reportScripts: ReportScriptsService;
  /**
   * The template's data source. Deliberately pluggable rather than wired to
   * a concrete connector in this PR: DUR-4058's open question about where
   * Nordstrand's numbers actually come from is not resolved yet, and the
   * ticket scopes PR2 to "the parts that do not depend on" that answer. The
   * default refuses cleanly so a template without a wired fetch cannot
   * silently proceed past this stage; a follow-up PR connects it to
   * `dataConnections` (packages/db/src/schema/data_connections.ts) once the
   * question is answered.
   */
  fetchData?: (companyId: string, template: { dataConnectionId: string | null; key: string }) => Promise<unknown>;
}

/**
 * DUR-4072 PR2: a report run is an ordinary task, not a new execution
 * engine -- fetch data, run the template's pinned script, hand the
 * resulting numbers (and only those numbers) to an agent for commentary,
 * check every number the agent wrote against them, then save a report
 * document with revisions.
 *
 * The agent never calculates: `draftCommentary` is the only way commentary
 * text reaches a run, and it always runs `checkReportCommentaryNumbers`
 * before accepting it. A commentary draft with any number not in
 * `numbers` moves the run to 'needs_revision' and is never written to the
 * document -- the previous ready document (if any) stays untouched.
 */
export function reportRunsService(db: Db, deps: ReportRunsServiceDeps) {
  const fetchData =
    deps.fetchData ??
    (async (_companyId: string, template: { dataConnectionId: string | null }) => {
      if (!template.dataConnectionId) throw new Error("This report template has no data source connected yet.");
      throw new Error("Fetching live data for a report template is not wired up yet; inject `fetchData` or see 'Questions for Filip'.");
    });

  function toSummary(row: typeof reportRuns.$inferSelect): ReportRun {
    return {
      id: row.id,
      companyId: row.companyId,
      templateId: row.templateId,
      status: row.status,
      fetchedData: row.fetchedData,
      scriptRunId: row.scriptRunId,
      numbers: row.numbers,
      commentaryText: row.commentaryText,
      ungroundedNumbers: row.ungroundedNumbers,
      documentId: row.documentId,
      error: row.error,
      requestedByAgentId: row.requestedByAgentId,
      requestedByUserId: row.requestedByUserId,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  async function getRun(companyId: string, runId: string): Promise<typeof reportRuns.$inferSelect> {
    const rows = await db.select().from(reportRuns).where(and(eq(reportRuns.id, runId), eq(reportRuns.companyId, companyId))).limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report run not found");
    return row;
  }

  async function listRuns(companyId: string, templateId?: string): Promise<ReportRun[]> {
    const rows = await db
      .select()
      .from(reportRuns)
      .where(templateId ? and(eq(reportRuns.companyId, companyId), eq(reportRuns.templateId, templateId)) : eq(reportRuns.companyId, companyId))
      .orderBy(desc(reportRuns.createdAt));
    return rows.map(toSummary);
  }

  /**
   * Starts a run: fetch data -> run the pinned script -> store `numbers`.
   * The template must be active and point at an approved version (the
   * template service already enforces the second at write time; this
   * re-checks, since a version can be retired after a template was made).
   */
  async function startRun(companyId: string, templateId: string, actor: { agentId?: string; userId?: string; runId?: string }): Promise<ReportRun> {
    const [template] = await db
      .select()
      .from(reportTemplates)
      .where(and(eq(reportTemplates.id, templateId), eq(reportTemplates.companyId, companyId)))
      .limit(1);
    if (!template) throw notFound("Report template not found");
    if (!template.isActive) throw unprocessable("This report template is switched off.");

    const [created] = await db
      .insert(reportRuns)
      .values({
        companyId,
        templateId,
        status: "fetching_data",
        requestedByAgentId: actor.agentId ?? null,
        requestedByUserId: actor.userId ?? null,
        requestedByRunId: actor.runId ?? null,
      })
      .returning();
    const run = created!;

    let fetchedData: unknown;
    try {
      fetchedData = await fetchData(companyId, template);
    } catch (err) {
      const [failed] = await db
        .update(reportRuns)
        .set({ status: "failed", error: `Could not fetch the report's data: ${err instanceof Error ? err.message : String(err)}`, finishedAt: new Date() })
        .where(eq(reportRuns.id, run.id))
        .returning();
      return toSummary(failed!);
    }

    await db.update(reportRuns).set({ fetchedData, status: "calculating" }).where(eq(reportRuns.id, run.id));

    const scriptRun = await deps.reportScripts.runForReport(companyId, template.scriptVersionId, fetchedData, actor);
    if (scriptRun.status !== "succeeded") {
      const [failed] = await db
        .update(reportRuns)
        .set({ status: "failed", scriptRunId: scriptRun.id, error: scriptRun.error ?? `The calculation script did not succeed (${scriptRun.status}).`, finishedAt: new Date() })
        .where(eq(reportRuns.id, run.id))
        .returning();
      return toSummary(failed!);
    }

    const [calculated] = await db
      .update(reportRuns)
      .set({ scriptRunId: scriptRun.id, numbers: scriptRun.output, status: "drafting_commentary" })
      .where(eq(reportRuns.id, run.id))
      .returning();
    return toSummary(calculated!);
  }

  /**
   * The one path for commentary to reach a run. Checks every number in it
   * against `numbers` first: a reply with an ungrounded number is never
   * saved to the document, the run just records which numbers failed and
   * moves to 'needs_revision' so the agent can try again.
   */
  async function draftCommentary(
    companyId: string,
    runId: string,
    commentaryText: string,
    actor: { agentId?: string; userId?: string; runId?: string },
  ): Promise<ReportRun> {
    const run = await getRun(companyId, runId);
    // 'ready' is allowed too: the ticket's "report document with revisions"
    // means a finished report can still be revised -- it just always goes
    // through the same number check again before it overwrites anything.
    if (run.status !== "drafting_commentary" && run.status !== "needs_revision" && run.status !== "ready") {
      throw unprocessable(`This report run is '${run.status}' and is not waiting for commentary.`);
    }
    const check = checkReportCommentaryNumbers(commentaryText, run.numbers);
    if (!check.ok) {
      const [updated] = await db
        .update(reportRuns)
        .set({ status: "needs_revision", commentaryText, ungroundedNumbers: check.ungrounded })
        .where(eq(reportRuns.id, runId))
        .returning();
      return toSummary(updated!);
    }

    const [template] = await db.select().from(reportTemplates).where(eq(reportTemplates.id, run.templateId)).limit(1);
    const documentId = await createOrReviseReportDocument(
      db,
      companyId,
      run.documentId,
      template?.name ?? "Report",
      commentaryText,
      actor,
      run.documentId ? "Report run updated the commentary." : "First report from this run.",
    );

    const [updated] = await db
      .update(reportRuns)
      .set({ status: "ready", commentaryText, ungroundedNumbers: [], documentId, finishedAt: new Date() })
      .where(eq(reportRuns.id, runId))
      .returning();
    return toSummary(updated!);
  }

  return {
    listRuns,
    getRun: (companyId: string, runId: string) => getRun(companyId, runId).then(toSummary),
    startRun,
    draftCommentary,
  };
}

export type ReportRunsService = ReturnType<typeof reportRunsService>;
