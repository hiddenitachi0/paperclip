import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dataConnections, documentRevisions, documents, reportScriptVersions, reportTemplates } from "@paperclipai/db";
import type { CreateReportTemplateInput, ReportTemplate, UpdateReportTemplateInput } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

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
   * once fetching is wired that would read another company's data.
   */
  async function assertOwnDataConnection(companyId: string, dataConnectionId: string | null | undefined): Promise<void> {
    if (!dataConnectionId) return;
    const rows = await db
      .select({ id: dataConnections.id })
      .from(dataConnections)
      .where(and(eq(dataConnections.id, dataConnectionId), eq(dataConnections.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Data connection not found");
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

  async function createTemplate(
    companyId: string,
    input: CreateReportTemplateInput,
    actor: { agentId?: string; userId?: string },
  ): Promise<ReportTemplate> {
    await assertApprovedVersion(companyId, input.scriptVersionId);
    await assertOwnDataConnection(companyId, input.dataConnectionId);
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
        scriptVersionId: input.scriptVersionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();
    return toSummary(row!);
  }

  async function updateTemplate(companyId: string, templateId: string, input: UpdateReportTemplateInput): Promise<ReportTemplate> {
    await getTemplate(companyId, templateId);
    if (input.scriptVersionId) await assertApprovedVersion(companyId, input.scriptVersionId);
    await assertOwnDataConnection(companyId, input.dataConnectionId);
    const [row] = await db
      .update(reportTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(reportTemplates.id, templateId), eq(reportTemplates.companyId, companyId)))
      .returning();
    if (!row) throw notFound("Report template not found");
    return toSummary(row);
  }

  return { listTemplates, getTemplate: (companyId: string, templateId: string) => getTemplate(companyId, templateId).then(toSummary), createTemplate, updateTemplate };
}

export type ReportTemplatesService = ReturnType<typeof reportTemplatesService>;

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
