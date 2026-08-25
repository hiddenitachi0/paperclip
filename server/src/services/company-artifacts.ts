import { buffer } from "node:stream/consumers";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companies,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  attachmentArtifactWorkProductMetadataSchema,
  classifyFileKind,
  COMPANY_ARTIFACTS_MAX_LIMIT,
  companyArtifactsQuerySchema,
  DOCUMENT_MEDIA_CONTENT_TYPES,
  SYSTEM_ISSUE_DOCUMENT_KEYS,
  type CompanyArtifact,
  type CompanyArtifactAgentSummary,
  type CompanyArtifactGroup,
  type CompanyArtifactGroupBy,
  type CompanyArtifactMediaKind,
  type CompanyArtifactsQuery,
  type CompanyArtifactsResponse,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import type { StorageService } from "../storage/types.js";

const TEXT_PREVIEW_BYTES = 4096;
const PREVIEW_TEXT_MAX_LENGTH = 280;
const GROUP_PREVIEW_ARTIFACT_LIMIT = 3;
const GROUPED_ARTIFACT_FETCH_LIMIT = COMPANY_ARTIFACTS_MAX_LIMIT * 10;

type ArtifactCursor = {
  updatedAt: string;
  id: string;
};

type ArtifactGroupBy = Exclude<CompanyArtifactGroupBy, "none">;

type IssueGroupingRow = {
  id: string;
  parentId: string | null;
  identifier: string | null;
  title: string;
  updatedAt: Date;
};

function encodeCursor(cursor: ArtifactCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): ArtifactCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ArtifactCursor>;
    if (typeof parsed.id !== "string" || typeof parsed.updatedAt !== "string") {
      throw new Error("Invalid cursor");
    }
    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid cursor date");
    }
    return { id: parsed.id, updatedAt: date.toISOString() };
  } catch {
    throw badRequest("Invalid artifacts cursor");
  }
}

function cursorCondition(updatedAt: SQL<Date>, artifactId: SQL<string>, cursor: ArtifactCursor | null) {
  if (!cursor) return undefined;
  return sql`(${updatedAt} < ${cursor.updatedAt}::timestamptz OR (${updatedAt} = ${cursor.updatedAt}::timestamptz AND ${artifactId} < ${cursor.id}))`;
}

function isAfterCursor(item: { updatedAt: string; id: string }, cursor: ArtifactCursor | null) {
  if (!cursor) return true;
  const dateDiff = Date.parse(item.updatedAt) - Date.parse(cursor.updatedAt);
  return dateDiff < 0 || (dateDiff === 0 && item.id < cursor.id);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizePreviewText(input: string | null | undefined) {
  if (!input) return null;
  const stripped = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > PREVIEW_TEXT_MAX_LENGTH
    ? `${stripped.slice(0, PREVIEW_TEXT_MAX_LENGTH - 3).trimEnd()}...`
    : stripped;
}

function classifyMediaKind(contentType: string | null | undefined, fallback: CompanyArtifactMediaKind = "file") {
  const normalized = (contentType ?? "").toLowerCase();
  if (!normalized) return fallback;
  return classifyFileKind({ contentType: normalized }).mediaKind;
}

function documentContentTypeList() {
  return sql.join(DOCUMENT_MEDIA_CONTENT_TYPES.map((value) => sql`${value}`), sql`, `);
}

function contentTypeKindCondition(contentTypeExpression: SQL<string>, kind: CompanyArtifactsQuery["kind"]) {
  if (!kind || kind === "all") return undefined;
  if (kind === "image") return sql`${contentTypeExpression} ILIKE 'image/%'`;
  if (kind === "video") return sql`${contentTypeExpression} ILIKE 'video/%'`;
  if (kind === "text") {
    return sql`(
      (${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')
      AND NOT lower(${contentTypeExpression}) IN (${documentContentTypeList()})
    )`;
  }
  if (kind === "document") {
    return sql`lower(${contentTypeExpression}) IN (${documentContentTypeList()})`;
  }
  if (kind === "file") {
    return sql`NOT (
      ${contentTypeExpression} ILIKE 'image/%' OR ${contentTypeExpression} ILIKE 'video/%' OR ${contentTypeExpression} ILIKE 'text/%'
      OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown')
      OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml'
      OR lower(${contentTypeExpression}) IN (${documentContentTypeList()})
    )`;
  }
  return undefined;
}

function buildIssueHref(companyPrefix: string, identifier: string, anchor: string) {
  return `/${encodeURIComponent(companyPrefix)}/issues/${encodeURIComponent(identifier)}#${anchor}`;
}

function appendCommonArtifactsGroupHrefParams(params: URLSearchParams, query: CompanyArtifactsQuery) {
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.q) params.set("q", query.q);
  if (query.qScope !== "all") params.set("qScope", query.qScope);
  if (query.agentId) params.set("agentId", query.agentId);
  if (query.noAgent) params.set("noAgent", "true");
}

function buildArtifactsGroupHref(
  companyPrefix: string,
  query: CompanyArtifactsQuery,
  groupBy: ArtifactGroupBy,
  groupIssueId: string,
) {
  const params = new URLSearchParams();
  params.set("groupBy", groupBy);
  params.set("groupIssueId", groupIssueId);
  appendCommonArtifactsGroupHrefParams(params, query);
  return `/${encodeURIComponent(companyPrefix)}/artifacts?${params.toString()}`;
}

function buildAgentArtifactsGroupHref(
  companyPrefix: string,
  query: CompanyArtifactsQuery,
  groupAgentId: string | null,
) {
  const params = new URLSearchParams();
  params.set("groupBy", "agent");
  if (groupAgentId) {
    params.set("groupAgentId", groupAgentId);
  } else {
    params.set("noAgent", "true");
  }
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.q) params.set("q", query.q);
  if (query.qScope !== "all") params.set("qScope", query.qScope);
  return `/${encodeURIComponent(companyPrefix)}/artifacts?${params.toString()}`;
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

async function readTextAttachmentPreview(
  storage: StorageService | undefined,
  input: { companyId: string; objectKey: string; byteSize: number },
) {
  if (!storage || input.byteSize <= 0) return null;
  try {
    const object = await storage.getObject(input.companyId, input.objectKey, {
      range: { start: 0, end: Math.min(input.byteSize, TEXT_PREVIEW_BYTES) - 1 },
    });
    const body = await buffer(object.stream);
    return normalizePreviewText(body.toString("utf8"));
  } catch {
    return null;
  }
}

function sortArtifacts(artifacts: CompanyArtifact[]) {
  return artifacts.sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

function pageByCursor<T extends { id: string; updatedAt: string }>(
  items: T[],
  limit: number,
  cursor: ArtifactCursor | null,
) {
  const filtered = items.filter((item) => isAfterCursor(item, cursor));
  const page = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit
    ? encodeCursor({ id: page[page.length - 1]?.id ?? "", updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString() })
    : null;
  return { page, nextCursor };
}

async function loadIssueGroupingRows(db: Db, companyId: string, seedIssueIds: Iterable<string>) {
  const rowsById = new Map<string, IssueGroupingRow>();
  let pending = [...new Set(seedIssueIds)];

  while (pending.length > 0) {
    const rows = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        identifier: issues.identifier,
        title: issues.title,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, pending)));

    const nextPending = new Set<string>();
    for (const row of rows) {
      rowsById.set(row.id, row);
      if (row.parentId && !rowsById.has(row.parentId)) {
        nextPending.add(row.parentId);
      }
    }
    pending = [...nextPending];
  }

  return rowsById;
}

function getIssueSummary(issue: IssueGroupingRow) {
  return {
    id: issue.id,
    identifier: issue.identifier ?? issue.id,
    title: issue.title,
  };
}

function resolveRootIssueId(issueId: string, issueRows: Map<string, IssueGroupingRow>) {
  let current = issueRows.get(issueId);
  if (!current) return issueId;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = issueRows.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function resolveGroupIssueId(groupBy: ArtifactGroupBy, issueId: string, issueRows: Map<string, IssueGroupingRow>) {
  return groupBy === "task" ? issueId : resolveRootIssueId(issueId, issueRows);
}

function emptyGroup(input: {
  companyPrefix: string;
  query: CompanyArtifactsQuery;
  groupBy: ArtifactGroupBy;
  issue: IssueGroupingRow;
}): CompanyArtifactGroup {
  const summary = getIssueSummary(input.issue);
  return {
    id: `${input.groupBy}:${input.issue.id}`,
    groupBy: input.groupBy,
    issue: summary,
    title: summary.title,
    count: 0,
    mediaKinds: [],
    previewArtifacts: [],
    updatedAt: input.issue.updatedAt.toISOString(),
    href: buildArtifactsGroupHref(input.companyPrefix, input.query, input.groupBy, input.issue.id),
  };
}

function buildArtifactGroups(input: {
  artifacts: CompanyArtifact[];
  companyPrefix: string;
  query: CompanyArtifactsQuery;
  groupBy: ArtifactGroupBy;
  issueRows: Map<string, IssueGroupingRow>;
}) {
  const groups = new Map<string, CompanyArtifactGroup>();

  for (const artifact of input.artifacts) {
    const groupIssueId = resolveGroupIssueId(input.groupBy, artifact.issue.id, input.issueRows);
    const groupIssue = input.issueRows.get(groupIssueId) ?? {
      id: artifact.issue.id,
      parentId: null,
      identifier: artifact.issue.identifier,
      title: artifact.issue.title,
      updatedAt: new Date(artifact.updatedAt),
    };
    const groupId = `${input.groupBy}:${groupIssueId}`;
    const existing = groups.get(groupId);
    const group = existing ?? emptyGroup({
      companyPrefix: input.companyPrefix,
      query: input.query,
      groupBy: input.groupBy,
      issue: groupIssue,
    });
    if (!existing) groups.set(groupId, group);

    group.count += 1;
    if (!group.mediaKinds.includes(artifact.mediaKind)) {
      group.mediaKinds.push(artifact.mediaKind);
    }
    if (group.previewArtifacts.length < GROUP_PREVIEW_ARTIFACT_LIMIT) {
      group.previewArtifacts.push(artifact);
    }
    if (Date.parse(artifact.updatedAt) > Date.parse(group.updatedAt)) {
      group.updatedAt = artifact.updatedAt;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

const NO_AGENT_GROUP_TITLE = "No agent";

function agentGroupId(agentId: string | null) {
  return agentId ? `agent:${agentId}` : "agent:none";
}

function emptyAgentGroup(input: {
  companyPrefix: string;
  query: CompanyArtifactsQuery;
  agent: CompanyArtifactAgentSummary | null;
}): CompanyArtifactGroup {
  return {
    id: agentGroupId(input.agent?.id ?? null),
    groupBy: "agent",
    issue: null,
    agent: input.agent,
    title: input.agent?.name ?? NO_AGENT_GROUP_TITLE,
    count: 0,
    mediaKinds: [],
    previewArtifacts: [],
    updatedAt: new Date(0).toISOString(),
    href: buildAgentArtifactsGroupHref(input.companyPrefix, input.query, input.agent?.id ?? null),
  };
}

/**
 * Groups artifacts by the agent who made them (DUR-64 "who made it" browsing).
 * Unlike task/parent_task grouping, this never falls back to a synthetic
 * empty-issue row: a group only exists here when at least one artifact maps
 * to it, so the maker-less `agent:none` bucket only appears when non-empty
 * (which today only happens for work-product rows — documents/attachments
 * always require a resolvable maker).
 */
function buildAgentArtifactGroups(input: {
  artifacts: CompanyArtifact[];
  companyPrefix: string;
  query: CompanyArtifactsQuery;
}) {
  const groups = new Map<string, CompanyArtifactGroup>();

  for (const artifact of input.artifacts) {
    const agent = artifact.createdByAgent;
    const groupId = agentGroupId(agent?.id ?? null);
    const existing = groups.get(groupId);
    const group = existing ?? emptyAgentGroup({
      companyPrefix: input.companyPrefix,
      query: input.query,
      agent,
    });
    if (!existing) groups.set(groupId, group);

    group.count += 1;
    if (!group.mediaKinds.includes(artifact.mediaKind)) {
      group.mediaKinds.push(artifact.mediaKind);
    }
    if (group.previewArtifacts.length < GROUP_PREVIEW_ARTIFACT_LIMIT) {
      group.previewArtifacts.push(artifact);
    }
    if (Date.parse(artifact.updatedAt) > Date.parse(group.updatedAt)) {
      group.updatedAt = artifact.updatedAt;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

export function companyArtifactsService(db: Db, storage?: StorageService) {
  return {
    list: async (companyId: string, rawQuery: Partial<CompanyArtifactsQuery> = {}): Promise<CompanyArtifactsResponse> => {
      const query = companyArtifactsQuerySchema.parse(rawQuery);
      const cursor = decodeCursor(query.cursor);
      const groupBy = query.groupBy === "none" ? null : query.groupBy;
      const company = await db
        .select({ id: companies.id, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      if (query.agentId) {
        const filterAgent = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, query.agentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!filterAgent) throw notFound("Agent not found");
      }

      const fetchLimit = Math.min(query.limit + 1, COMPANY_ARTIFACTS_MAX_LIMIT + 1);
      const sourceFetchLimit = groupBy ? GROUPED_ARTIFACT_FETCH_LIMIT : fetchLimit;
      const q = query.q ? `%${escapeLikePattern(query.q)}%` : null;
      const artifacts: CompanyArtifact[] = [];
      const workProductAttachmentIds = new Set<string>();

      if (query.kind === "all" || query.kind === "text") {
        const createdAgent = alias(agents, "document_created_agent");
        const updatedAgent = alias(agents, "document_updated_agent");
        const documentArtifactId = sql<string>`concat('document:', ${documents.id})`;
        const documentConditions: SQL[] = [
          eq(issueDocuments.companyId, companyId),
          eq(documents.companyId, companyId),
          or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
          notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
        ];
        const documentCursor = groupBy ? undefined : cursorCondition(sql<Date>`${documents.updatedAt}`, documentArtifactId, cursor);
        if (documentCursor) documentConditions.push(documentCursor);
        if (groupBy === "task" && query.groupIssueId) documentConditions.push(eq(issues.id, query.groupIssueId));
        if (query.projectId) documentConditions.push(eq(issues.projectId, query.projectId));
        if (query.agentId) {
          documentConditions.push(
            sql`(${documents.createdByAgentId} = ${query.agentId} OR ${documents.updatedByAgentId} = ${query.agentId})`,
          );
        } else if (query.noAgent) {
          documentConditions.push(
            sql`(${documents.createdByAgentId} IS NULL AND ${documents.updatedByAgentId} IS NULL)`,
          );
        }
        if (q) {
          documentConditions.push(
            query.qScope === "filename"
              ? sql`coalesce(${documents.title}, '') ILIKE ${q} ESCAPE '\\'`
              : sql`(
                coalesce(${documents.title}, '') ILIKE ${q} ESCAPE '\\'
                OR ${documents.latestBody} ILIKE ${q} ESCAPE '\\'
                OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
                OR ${issues.title} ILIKE ${q} ESCAPE '\\'
              )`,
          );
        }

        const documentRowsQuery = db
          .select({
            artifactId: documentArtifactId,
            documentId: documents.id,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            key: issueDocuments.key,
            title: documents.title,
            latestBody: documents.latestBody,
            createdByAgentId: sql<string | null>`coalesce(${createdAgent.id}, ${updatedAgent.id})`,
            createdByAgentName: sql<string | null>`coalesce(${createdAgent.name}, ${updatedAgent.name})`,
            updatedAt: documents.updatedAt,
          })
          .from(issueDocuments)
          .innerJoin(
            documents,
            and(
              eq(issueDocuments.documentId, documents.id),
              eq(documents.companyId, issueDocuments.companyId),
            ),
          )
          .innerJoin(
            issues,
            and(
              eq(issueDocuments.issueId, issues.id),
              eq(issues.companyId, issueDocuments.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(issues.projectId, projects.id),
              eq(projects.companyId, issues.companyId),
            ),
          )
          .leftJoin(
            createdAgent,
            and(
              eq(documents.createdByAgentId, createdAgent.id),
              eq(createdAgent.companyId, documents.companyId),
            ),
          )
          .leftJoin(
            updatedAgent,
            and(
              eq(documents.updatedByAgentId, updatedAgent.id),
              eq(updatedAgent.companyId, documents.companyId),
            ),
          )
          .where(and(...documentConditions))
          .orderBy(desc(documents.updatedAt), desc(documentArtifactId));
        const documentRows = await documentRowsQuery.limit(sourceFetchLimit);

        for (const row of documentRows) {
          const identifier = row.issueIdentifier ?? row.issueId;
          artifacts.push({
            id: row.artifactId,
            source: "document",
            mediaKind: "text",
            title: row.title ?? row.key,
            previewText: normalizePreviewText(row.latestBody),
            contentType: "text/markdown",
            contentPath: null,
            openPath: null,
            downloadPath: null,
            byteSize: null,
            originalFilename: null,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `document-${row.key}`),
          });
        }
      }

      {
        // No source gate here (unlike the documents block above): work
        // products and attachments must be queried/returned for every kind,
        // including "document" now that real PDF/Word/etc content types
        // classify as mediaKind "document" (see classifyMediaKind /
        // contentTypeKindCondition) — a Word doc attachment should show up
        // when filtering by kind=document.
        const workProductAgent = alias(agents, "work_product_agent");
        const workProductArtifactId = sql<string>`concat('work_product:', ${issueWorkProducts.id})`;
        const workProductContentType = sql<string>`coalesce(${issueWorkProducts.metadata}->>'contentType', '')`;
        const workProductBaseConditions: SQL[] = [
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "artifact"),
          eq(issueWorkProducts.provider, "paperclip"),
        ];
        const workProductConditions: SQL[] = [...workProductBaseConditions];
        const workProductCursor = groupBy
          ? undefined
          : cursorCondition(sql<Date>`${issueWorkProducts.updatedAt}`, workProductArtifactId, cursor);
        const workProductKind = contentTypeKindCondition(workProductContentType, query.kind);
        if (workProductCursor) workProductConditions.push(workProductCursor);
        if (groupBy === "task" && query.groupIssueId) {
          const selectedIssueCondition = eq(issues.id, query.groupIssueId);
          workProductBaseConditions.push(selectedIssueCondition);
          workProductConditions.push(selectedIssueCondition);
        }
        if (workProductKind) {
          workProductBaseConditions.push(workProductKind);
          workProductConditions.push(workProductKind);
        }
        if (query.projectId) {
          const projectCondition = eq(issues.projectId, query.projectId);
          workProductBaseConditions.push(projectCondition);
          workProductConditions.push(projectCondition);
        }
        // agentId/noAgent only apply to workProductConditions, not
        // workProductBaseConditions: the base-conditions query (used below to
        // compute the attachment dedup set) never joins heartbeatRuns/
        // workProductAgent, so referencing that alias there would produce
        // invalid SQL. Leaving the dedup set agent-filter-agnostic also means
        // a work product hidden by an agent filter still keeps its wrapped
        // attachment out of the flat attachments list (no double-listing).
        if (query.agentId) {
          workProductConditions.push(eq(workProductAgent.id, query.agentId));
        } else if (query.noAgent) {
          workProductConditions.push(isNull(workProductAgent.id));
        }
        if (q) {
          const searchCondition = sql`(
            ${issueWorkProducts.title} ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issueWorkProducts.summary}, '') ILIKE ${q} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
            OR ${issues.title} ILIKE ${q} ESCAPE '\\'
          )`;
          workProductBaseConditions.push(searchCondition);
          workProductConditions.push(searchCondition);
        }

        const workProductRowsQuery = db
          .select({
            artifactId: workProductArtifactId,
            workProductId: issueWorkProducts.id,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            title: issueWorkProducts.title,
            summary: issueWorkProducts.summary,
            metadata: issueWorkProducts.metadata,
            createdByAgentId: workProductAgent.id,
            createdByAgentName: workProductAgent.name,
            updatedAt: issueWorkProducts.updatedAt,
          })
          .from(issueWorkProducts)
          .innerJoin(
            issues,
            and(
              eq(issueWorkProducts.issueId, issues.id),
              eq(issues.companyId, issueWorkProducts.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(issues.projectId, projects.id),
              eq(projects.companyId, issueWorkProducts.companyId),
            ),
          )
          .leftJoin(
            heartbeatRuns,
            and(
              eq(issueWorkProducts.createdByRunId, heartbeatRuns.id),
              eq(heartbeatRuns.companyId, issueWorkProducts.companyId),
            ),
          )
          .leftJoin(
            workProductAgent,
            and(
              eq(heartbeatRuns.agentId, workProductAgent.id),
              eq(workProductAgent.companyId, issueWorkProducts.companyId),
            ),
          )
          .where(and(...workProductConditions))
          .orderBy(desc(issueWorkProducts.updatedAt), desc(workProductArtifactId));
        const workProductRows = await workProductRowsQuery.limit(sourceFetchLimit);

        const workProductAttachmentRows = await db
          .select({
            attachmentId: sql<string | null>`${issueWorkProducts.metadata}->>'attachmentId'`,
          })
          .from(issueWorkProducts)
          .innerJoin(
            issues,
            and(
              eq(issueWorkProducts.issueId, issues.id),
              eq(issues.companyId, issueWorkProducts.companyId),
            ),
          )
          .where(and(...workProductBaseConditions, sql`${issueWorkProducts.metadata}->>'attachmentId' IS NOT NULL`))
          .limit(sourceFetchLimit);

        for (const row of workProductAttachmentRows) {
          if (row.attachmentId) {
            workProductAttachmentIds.add(row.attachmentId);
          }
        }

        for (const row of workProductRows) {
          const metadata = attachmentArtifactWorkProductMetadataSchema.safeParse(row.metadata);
          const attachmentMetadata = metadata.success ? metadata.data : null;
          if (attachmentMetadata) {
            workProductAttachmentIds.add(attachmentMetadata.attachmentId);
          }
          const contentType = attachmentMetadata?.contentType ?? null;
          const identifier = row.issueIdentifier ?? row.issueId;
          artifacts.push({
            id: row.artifactId,
            source: "work_product",
            mediaKind: classifyMediaKind(contentType, attachmentMetadata ? "file" : "empty"),
            title: row.title,
            previewText: normalizePreviewText(row.summary),
            contentType,
            contentPath: attachmentMetadata?.contentPath ?? null,
            openPath: attachmentMetadata?.openPath ?? (typeof row.metadata?.openPath === "string" ? row.metadata.openPath : null),
            downloadPath: attachmentMetadata?.downloadPath ?? null,
            byteSize: attachmentMetadata?.byteSize ?? null,
            originalFilename: attachmentMetadata?.originalFilename ?? null,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `work-product-${row.workProductId}`),
          });
        }

        const attachmentAgent = alias(agents, "attachment_agent");
        const attachmentArtifactId = sql<string>`concat('attachment:', ${issueAttachments.id})`;
        const attachmentConditions: SQL[] = [
          eq(issueAttachments.companyId, companyId),
          isNull(issueAttachments.issueCommentId),
          isNotNull(assets.createdByAgentId),
        ];
        const attachmentCursor = groupBy
          ? undefined
          : cursorCondition(sql<Date>`${issueAttachments.updatedAt}`, attachmentArtifactId, cursor);
        const attachmentKind = contentTypeKindCondition(sql<string>`${assets.contentType}`, query.kind);
        if (attachmentCursor) attachmentConditions.push(attachmentCursor);
        if (groupBy === "task" && query.groupIssueId) attachmentConditions.push(eq(issues.id, query.groupIssueId));
        if (attachmentKind) attachmentConditions.push(attachmentKind);
        if (query.projectId) attachmentConditions.push(eq(issues.projectId, query.projectId));
        if (query.agentId) {
          attachmentConditions.push(eq(attachmentAgent.id, query.agentId));
        } else if (query.noAgent) {
          attachmentConditions.push(isNull(attachmentAgent.id));
        }
        if (q) {
          attachmentConditions.push(
            query.qScope === "filename"
              ? sql`coalesce(${assets.originalFilename}, '') ILIKE ${q} ESCAPE '\\'`
              : sql`(
                coalesce(${assets.originalFilename}, '') ILIKE ${q} ESCAPE '\\'
                OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
                OR ${issues.title} ILIKE ${q} ESCAPE '\\'
              )`,
          );
        }

        const attachmentRowsQuery = db
          .select({
            artifactId: attachmentArtifactId,
            attachmentId: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            projectId: projects.id,
            projectName: projects.name,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            originalFilename: assets.originalFilename,
            createdByAgentId: attachmentAgent.id,
            createdByAgentName: attachmentAgent.name,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(
            assets,
            and(
              eq(issueAttachments.assetId, assets.id),
              eq(assets.companyId, issueAttachments.companyId),
            ),
          )
          .innerJoin(
            issues,
            and(
              eq(issueAttachments.issueId, issues.id),
              eq(issues.companyId, issueAttachments.companyId),
            ),
          )
          .leftJoin(
            projects,
            and(
              eq(issues.projectId, projects.id),
              eq(projects.companyId, issues.companyId),
            ),
          )
          .leftJoin(
            attachmentAgent,
            and(
              eq(assets.createdByAgentId, attachmentAgent.id),
              eq(attachmentAgent.companyId, assets.companyId),
            ),
          )
          .where(and(...attachmentConditions))
          .orderBy(desc(issueAttachments.updatedAt), desc(attachmentArtifactId));
        const attachmentRows = await attachmentRowsQuery.limit(sourceFetchLimit);

        const attachmentArtifacts = await Promise.all(attachmentRows.map(async (row): Promise<CompanyArtifact | null> => {
          if (workProductAttachmentIds.has(row.attachmentId)) return null;
          const mediaKind = classifyMediaKind(row.contentType);
          const contentPath = attachmentContentPath(row.attachmentId);
          const identifier = row.issueIdentifier ?? row.issueId;
          return {
            id: row.artifactId,
            source: "attachment",
            mediaKind,
            title: row.originalFilename ?? "Attachment",
            previewText: mediaKind === "text"
              ? await readTextAttachmentPreview(storage, {
                companyId: row.companyId,
                objectKey: row.objectKey,
                byteSize: row.byteSize,
              })
              : null,
            contentType: row.contentType,
            contentPath,
            openPath: contentPath,
            downloadPath: `${contentPath}?download=1`,
            byteSize: row.byteSize,
            originalFilename: row.originalFilename,
            issue: { id: row.issueId, identifier, title: row.issueTitle },
            project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
            createdByAgent: row.createdByAgentId && row.createdByAgentName
              ? { id: row.createdByAgentId, name: row.createdByAgentName }
              : null,
            updatedAt: row.updatedAt.toISOString(),
            href: buildIssueHref(company.issuePrefix, identifier, `attachment-${row.attachmentId}`),
          };
        }));

        artifacts.push(...attachmentArtifacts.filter((artifact): artifact is CompanyArtifact => artifact !== null));
      }

      const sorted = sortArtifacts(artifacts);
      if (!groupBy) {
        const page = sorted.slice(0, query.limit);
        const nextCursor = sorted.length > query.limit
          ? encodeCursor({ id: page[page.length - 1]?.id ?? "", updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString() })
          : null;

        return { artifacts: page, nextCursor };
      }

      if (groupBy === "agent") {
        let selectedAgent: CompanyArtifactAgentSummary | null = null;
        if (query.groupAgentId) {
          selectedAgent = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.id, query.groupAgentId), eq(agents.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          if (!selectedAgent) {
            return { artifacts: [], selectedGroup: null, nextCursor: null };
          }
        }

        const agentGroups = buildAgentArtifactGroups({
          artifacts: sorted,
          companyPrefix: company.issuePrefix,
          query,
        });

        if (query.groupAgentId || query.noAgent) {
          const selectedGroupId = agentGroupId(query.groupAgentId ?? null);
          const selectedGroup = agentGroups.find((group) => group.id === selectedGroupId)
            ?? emptyAgentGroup({
              companyPrefix: company.issuePrefix,
              query,
              agent: selectedAgent,
            });
          const selectedArtifacts = sorted.filter(
            (artifact) => agentGroupId(artifact.createdByAgent?.id ?? null) === selectedGroupId,
          );
          const { page, nextCursor } = pageByCursor(selectedArtifacts, query.limit, cursor);
          return { artifacts: page, selectedGroup, nextCursor };
        }

        const { page, nextCursor } = pageByCursor(agentGroups, query.limit, cursor);
        return { artifacts: [], groups: page, nextCursor };
      }

      const issueSeedIds = new Set(artifacts.map((artifact) => artifact.issue.id));
      if (query.groupIssueId) issueSeedIds.add(query.groupIssueId);
      const issueRows = await loadIssueGroupingRows(db, companyId, issueSeedIds);
      const groups = buildArtifactGroups({
        artifacts: sorted,
        companyPrefix: company.issuePrefix,
        query,
        groupBy,
        issueRows,
      });

      if (query.groupIssueId) {
        const selectedIssue = issueRows.get(query.groupIssueId);
        if (!selectedIssue) {
          return { artifacts: [], selectedGroup: null, nextCursor: null };
        }

        const selectedGroupIssueId = resolveGroupIssueId(groupBy, selectedIssue.id, issueRows);
        const selectedGroup = groups.find((group) => group.issue?.id === selectedGroupIssueId)
          ?? emptyGroup({
            companyPrefix: company.issuePrefix,
            query,
            groupBy,
            issue: issueRows.get(selectedGroupIssueId) ?? selectedIssue,
          });
        const selectedArtifacts = sorted.filter((artifact) =>
          resolveGroupIssueId(groupBy, artifact.issue.id, issueRows) === selectedGroupIssueId
        );
        const { page, nextCursor } = pageByCursor(selectedArtifacts, query.limit, cursor);
        return { artifacts: page, selectedGroup, nextCursor };
      }

      const { page, nextCursor } = pageByCursor(groups, query.limit, cursor);
      return { artifacts: [], groups: page, nextCursor };
    },

    /**
     * Agents who have made >=1 file across any of the three artifact sources
     * (documents, attachments, work products), most-recently-active first.
     * Backs the `kind=document`-independent agent filter/group dropdown
     * (DUR-64), so it applies the same source-eligibility gates as `list`
     * (system document keys excluded, comment attachments excluded, only
     * "artifact"-type paperclip work products) but no kind/project/search
     * filtering — this is a full, unfiltered roster of makers.
     */
    listAgents: async (companyId: string): Promise<CompanyArtifactAgentSummary[]> => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const latestByAgent = new Map<string, { id: string; name: string; updatedAt: number }>();
      const record = (id: string | null | undefined, name: string | null | undefined, updatedAt: Date) => {
        if (!id || !name) return;
        const timestamp = updatedAt.getTime();
        const existing = latestByAgent.get(id);
        if (!existing || timestamp > existing.updatedAt) {
          latestByAgent.set(id, { id, name, updatedAt: timestamp });
        }
      };

      const documentCreatedAgent = alias(agents, "list_agents_document_created_agent");
      const documentUpdatedAgent = alias(agents, "list_agents_document_updated_agent");
      const documentRows = await db
        .select({
          createdByAgentId: documentCreatedAgent.id,
          createdByAgentName: documentCreatedAgent.name,
          updatedByAgentId: documentUpdatedAgent.id,
          updatedByAgentName: documentUpdatedAgent.name,
          updatedAt: documents.updatedAt,
        })
        .from(issueDocuments)
        .innerJoin(
          documents,
          and(
            eq(issueDocuments.documentId, documents.id),
            eq(documents.companyId, issueDocuments.companyId),
          ),
        )
        .leftJoin(
          documentCreatedAgent,
          and(
            eq(documents.createdByAgentId, documentCreatedAgent.id),
            eq(documentCreatedAgent.companyId, documents.companyId),
          ),
        )
        .leftJoin(
          documentUpdatedAgent,
          and(
            eq(documents.updatedByAgentId, documentUpdatedAgent.id),
            eq(documentUpdatedAgent.companyId, documents.companyId),
          ),
        )
        .where(and(
          eq(issueDocuments.companyId, companyId),
          eq(documents.companyId, companyId),
          or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
          notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
        ));
      for (const row of documentRows) {
        record(row.createdByAgentId, row.createdByAgentName, row.updatedAt);
        record(row.updatedByAgentId, row.updatedByAgentName, row.updatedAt);
      }

      const listAgentsWorkProductAgent = alias(agents, "list_agents_work_product_agent");
      const workProductRows = await db
        .select({
          agentId: listAgentsWorkProductAgent.id,
          agentName: listAgentsWorkProductAgent.name,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .leftJoin(
          heartbeatRuns,
          and(
            eq(issueWorkProducts.createdByRunId, heartbeatRuns.id),
            eq(heartbeatRuns.companyId, issueWorkProducts.companyId),
          ),
        )
        .leftJoin(
          listAgentsWorkProductAgent,
          and(
            eq(heartbeatRuns.agentId, listAgentsWorkProductAgent.id),
            eq(listAgentsWorkProductAgent.companyId, issueWorkProducts.companyId),
          ),
        )
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "artifact"),
          eq(issueWorkProducts.provider, "paperclip"),
          isNotNull(listAgentsWorkProductAgent.id),
        ));
      for (const row of workProductRows) {
        record(row.agentId, row.agentName, row.updatedAt);
      }

      const listAgentsAttachmentAgent = alias(agents, "list_agents_attachment_agent");
      const attachmentRows = await db
        .select({
          agentId: listAgentsAttachmentAgent.id,
          agentName: listAgentsAttachmentAgent.name,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(
          assets,
          and(
            eq(issueAttachments.assetId, assets.id),
            eq(assets.companyId, issueAttachments.companyId),
          ),
        )
        .leftJoin(
          listAgentsAttachmentAgent,
          and(
            eq(assets.createdByAgentId, listAgentsAttachmentAgent.id),
            eq(listAgentsAttachmentAgent.companyId, assets.companyId),
          ),
        )
        .where(and(
          eq(issueAttachments.companyId, companyId),
          isNull(issueAttachments.issueCommentId),
          isNotNull(assets.createdByAgentId),
          isNotNull(listAgentsAttachmentAgent.id),
        ));
      for (const row of attachmentRows) {
        record(row.agentId, row.agentName, row.updatedAt);
      }

      return [...latestByAgent.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
        .map(({ id, name }) => ({ id, name }));
    },
  };
}
