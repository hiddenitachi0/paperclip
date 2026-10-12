import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dataConnections, documentRevisions, documents, reportScriptVersions, reportTemplates } from "@paperclipai/db";
import {
  DATA_CONNECTION_KIND_LABELS,
  REPORT_DATASET_KINDS,
  REPORT_DATASET_LABELS,
  reportDataQuerySchema,
  type CreateReportTemplateInput,
  type DataConnectionKind,
  type ReportDataQuery,
  type ReportTemplate,
  type UpdateReportTemplateInput,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

/**
 * DUR-4072 PR2: report templates. Every query filters on the caller's
 * company, the same rule report-scripts.ts follows.
 *
 * A template may be created or edited by an agent or a board member either
 * way, but it may only ever point at an **approved** script version
 * (checked here, not just left to the FK): "never goes live without
 * Filip's approval" means the template can be drafted ahead of approval,
 * but it refuses to attach to anything less than approved. Swapping which
 * version a template points to follows the same rule, so an operator
 * cannot be shown a report whose script was never approved, or whose
 * approved version was later retired without the template following.
 */
export function reportTemplatesService(db: Db) {
  function toSummary(row: typeof reportTemplates.$inferSelect): ReportTemplate {
    return {
      id: row.id,
      companyId: row.companyId,
      key: row.key,
      name: row.name,
      instructions: row.instructions,
      layout: row.layout,
      dataConnectionId: row.dataConnectionId,
      dataQuery: parseDataQuery(row.dataQuery),
      scriptVersionId: row.scriptVersionId,
      isActive: row.isActive,
      createdByAgentId: row.createdByAgentId,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function assertApprovedVersion(companyId: string, scriptVersionId: string): Promise<void> {
    const rows = await db
      .select({ status: reportScriptVersions.status })
      .from(reportScriptVersions)
      .where(and(eq(reportScriptVersions.id, scriptVersionId), eq(reportScriptVersions.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report script version not found");
    if (row.status !== "approved") {
      throw unprocessable("A report template can only point at an approved script version.");
    }
  }

  /**
   * A template may only name a data connection of ITS OWN company. The
   * foreign key alone would accept another company's connection id, and
   * that would read another company's data. (The fetch re-checks at run
   * time, report-data.ts.) Every dataset in `dataQuery` must also be one
   * that connection's kind can give.
   */
  async function assertOwnDataConnection(
    companyId: string,
    dataConnectionId: string | null | undefined,
    dataQuery?: ReportDataQuery | null,
  ): Promise<void> {
    if (!dataConnectionId) return;
    const rows = await db
      .select({ id: dataConnections.id, kind: dataConnections.kind })
      .from(dataConnections)
      .where(and(eq(dataConnections.id, dataConnectionId), eq(dataConnections.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Data connection not found");
    const kind = rows[0].kind as DataConnectionKind;
    for (const item of dataQuery?.items ?? []) {
      if (!REPORT_DATASET_KINDS[item.dataset].includes(kind)) {
        throw unprocessable(`${DATA_CONNECTION_KIND_LABELS[kind] ?? kind} cannot give "${REPORT_DATASET_LABELS[item.dataset].label}". Choose another dataset or connection.`, {
          code: "dataset_not_offered",
        });
      }
    }
  }

  async function listTemplates(companyId: string): Promise<ReportTemplate[]> {
    const rows = await db.select().from(reportTemplates).where(eq(reportTemplates.companyId, companyId)).orderBy(desc(reportTemplates.createdAt));
    return rows.map(toSummary);
  }

  async function getTemplate(companyId: string, templateId: string): Promise<typeof reportTemplates.$inferSelect> {
    const rows = await db
      .select()
      .from(reportTemplates)
      .where(and(eq(reportTemplates.id, templateId), eq(reportTemplates.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Report template not found");
    return row;
  }

  /**
   * `canEnable`: the caller is a person who is the company's owner/admin (or
   * an instance admin). Only they may switch a template on. Templates drafted
   * by anyone else start switched off.
   */
  async function createTemplate(
    companyId: string,
    input: CreateReportTemplateInput,
    actor: { agentId?: string; userId?: string; canEnable?: boolean },
  ): Promise<ReportTemplate> {
    await assertApprovedVersion(companyId, input.scriptVersionId);
    await assertOwnDataConnection(companyId, input.dataConnectionId, input.dataQuery);
    const existing = await db
      .select({ id: reportTemplates.id })
      .from(reportTemplates)
      .where(and(eq(reportTemplates.companyId, companyId), eq(reportTemplates.key, input.key)))
      .limit(1);
    if (existing.length > 0) throw conflict(`A report template with key "${input.key}" already exists.`);
    const [row] = await db
      .insert(reportTemplates)
      .values({
        companyId,
        key: input.key,
        name: input.name,
        instructions: input.instructions,
        layout: input.layout,
        dataConnectionId: input.dataConnectionId ?? null,
        dataQuery: (input.dataQuery ?? null) as Record<string, unknown> | null,
        scriptVersionId: input.scriptVersionId,
        isActive: actor.canEnable === true,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();
    return toSummary(row!);
  }

  async function updateTemplate(
    companyId: string,
    templateId: string,
    input: UpdateReportTemplateInput,
    actor: { canEnable?: boolean } = {},
  ): Promise<ReportTemplate> {
    const current = await getTemplate(companyId, templateId);
    const canEnable = actor.canEnable === true;
    if (input.isActive === true && !canEnable) {
      throw forbidden("Only the company's owner or an admin can switch a report template on.");
    }
    const changes: UpdateReportTemplateInput = { ...input };
    // Re-pointing an active template at different code or data is a new
    // decision: when someone who may not enable templates does it, the
    // template is switched off until an owner/admin switches it on again.
    const repointed =
      (input.scriptVersionId !== undefined && input.scriptVersionId !== current.scriptVersionId) ||
      (input.dataConnectionId !== undefined && input.dataConnectionId !== current.dataConnectionId) ||
      (input.dataQuery !== undefined && JSON.stringify(input.dataQuery) !== JSON.stringify(parseDataQuery(current.dataQuery)));
    if (repointed && !canEnable) changes.isActive = false;
    if (input.scriptVersionId) await assertApprovedVersion(companyId, input.scriptVersionId);
    // Check the connection and query as they will be after this change.
    const nextConnectionId = input.dataConnectionId !== undefined ? input.dataConnectionId : current.dataConnectionId;
    const nextQuery = input.dataQuery !== undefined ? input.dataQuery : parseDataQuery(current.dataQuery);
    await assertOwnDataConnection(companyId, nextConnectionId, nextQuery);
    const { dataQuery: nextDataQuery, ...rest } = changes;
    const [row] = await db
      .update(reportTemplates)
      .set({
        ...rest,
        ...(nextDataQuery !== undefined ? { dataQuery: (nextDataQuery ?? null) as Record<string, unknown> | null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(reportTemplates.id, templateId), eq(reportTemplates.companyId, companyId)))
      .returning();
    if (!row) throw notFound("Report template not found");
    return toSummary(row);
  }

  return { listTemplates, getTemplate: (companyId: string, templateId: string) => getTemplate(companyId, templateId).then(toSummary), createTemplate, updateTemplate };
}

export type ReportTemplatesService = ReturnType<typeof reportTemplatesService>;

/** The stored query, or null when it is missing or no longer valid (it is re-validated before every fetch too). */
export function parseDataQuery(value: unknown): ReportDataQuery | null {
  if (value === null || value === undefined) return null;
  const parsed = reportDataQuerySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A thin, generic document helper -- a report document is not tied to an issue, unlike issueDocuments. */
export async function createOrReviseReportDocument(
  db: Db,
  companyId: string,
  documentId: string | null,
  title: string,
  body: string,
  actor: { agentId?: string; userId?: string; runId?: string },
  changeSummary: string,
): Promise<string> {
  if (documentId) {
    const [doc] = await db.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.companyId, companyId))).limit(1);
    if (!doc) throw notFound("Report document not found");
    const nextRevisionNumber = doc.latestRevisionNumber + 1;
    const [revision] = await db
      .insert(documentRevisions)
      .values({
        companyId,
        documentId,
        revisionNumber: nextRevisionNumber,
        title,
        format: "markdown",
        body,
        changeSummary,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      })
      .returning();
    await db
      .update(documents)
      .set({ title, latestBody: body, latestRevisionId: revision!.id, latestRevisionNumber: nextRevisionNumber, updatedByAgentId: actor.agentId ?? null, updatedByUserId: actor.userId ?? null, updatedAt: new Date() })
      .where(eq(documents.id, documentId));
    return documentId;
  }
  const [doc] = await db
    .insert(documents)
    .values({
      companyId,
      title,
      format: "markdown",
      latestBody: body,
      latestRevisionNumber: 1,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
      updatedByAgentId: actor.agentId ?? null,
      updatedByUserId: actor.userId ?? null,
    })
    .returning();
  const [revision] = await db
    .insert(documentRevisions)
    .values({
      companyId,
      documentId: doc!.id,
      revisionNumber: 1,
      title,
      format: "markdown",
      body,
      changeSummary,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
      createdByRunId: actor.runId ?? null,
    })
    .returning();
  await db.update(documents).set({ latestRevisionId: revision!.id }).where(eq(documents.id, doc!.id));
  return doc!.id;
}
