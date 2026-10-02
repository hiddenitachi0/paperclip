import { DataSourceUpstreamError } from "./contract.js";
import type { PaperlessReadContext } from "./connection-kind.js";
import type { DocumentDetail, DocumentSearchHit, DocumentSearchResult } from "./documents-contract.js";

/**
 * DUR-4303: the paperless-ngx REST calls search_documents/get_document need,
 * kept separate from documents-contract.ts (the shape) and documents-data.ts
 * (the quick-agent query service). Every call goes through the context's
 * already-pinned, already-authenticated `fetch` (paperless-source.ts); this
 * file never builds a URL from anything but `context.baseUrl` plus a fixed
 * path, and never sees the credential.
 *
 * paperless-ngx's own full-text search accepts qualifiers directly in the
 * `query` string (e.g. `tag:invoice`), so a tag filter costs nothing extra:
 * no second request to resolve tag names to ids is needed to FILTER. Names
 * ARE needed to DISPLAY a correspondent/tag in the answer, since the base
 * document list/detail endpoints return those as bare ids -- resolved here
 * with one small `id__in` lookup per facet, scoped to only the ids a result
 * actually used, not every correspondent/tag the company has.
 */

const SEARCH_RESULT_LIMIT = 10;
const SNIPPET_MAX_CHARS = 300;

export class PaperlessDocumentNotFoundError extends Error {
  readonly documentId: number;
  constructor(documentId: number) {
    super(`No document ${documentId}.`);
    this.name = "PaperlessDocumentNotFoundError";
    this.documentId = documentId;
  }
}

function quoteSearchTerm(term: string): string {
  const trimmed = term.trim();
  return /\s/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
}

/** `query` plus `tag:` qualifiers, paperless-ngx's own search syntax -- never a second request. */
export function buildPaperlessSearchQuery(query: string, tags?: string[]): string {
  const clauses = [query.trim(), ...(tags ?? []).map((tag) => `tag:${quoteSearchTerm(tag)}`)];
  return clauses.filter((clause) => clause.length > 0).join(" ");
}

function stripHighlightMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function clipSnippet(value: string, max = SNIPPET_MAX_CHARS): string {
  const clean = stripHighlightMarkup(value);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

async function paperlessGet(
  context: PaperlessReadContext,
  path: string,
  options: { notFoundDocumentId?: number } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetch(`${context.baseUrl}${path}`, { method: "GET" });
  } catch {
    throw new DataSourceUpstreamError(
      "upstream_error",
      "Could not reach the paperless-ngx container, so I am not giving any documents.",
    );
  }
  if (response.status === 404 && options.notFoundDocumentId !== undefined) {
    throw new PaperlessDocumentNotFoundError(options.notFoundDocumentId);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DataSourceUpstreamError(
      "upstream_error",
      `The paperless-ngx container answered with an error (status ${response.status}), so I am not giving any documents.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new DataSourceUpstreamError(
      "unexpected_shape",
      "The paperless-ngx container's answer could not be read, so I am not giving any documents.",
    );
  }
}

interface RawDocumentListItem {
  id: number;
  correspondent: number | null;
  document_type?: number | null;
  title: string;
  content?: string;
  tags?: number[];
  created?: string | null;
  original_file_name?: string | null;
  __search_hit__?: { highlights?: string; score?: number; rank?: number };
}

interface RawListResponse<T> {
  count?: number;
  results?: T[];
}

function asRawList<T>(value: unknown): RawListResponse<T> {
  if (!value || typeof value !== "object") return {};
  return value as RawListResponse<T>;
}

/** `id__in` lookups for only the ids a page of results actually used; never the whole facet. */
async function resolveNames(
  context: PaperlessReadContext,
  path: "correspondents" | "tags" | "document_types",
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids)].filter((id) => Number.isFinite(id));
  const names = new Map<number, string>();
  if (unique.length === 0) return names;
  const raw = await paperlessGet(
    context,
    `/api/${path}/?id__in=${unique.join(",")}&page_size=${unique.length}`,
  );
  const list = asRawList<{ id: number; name: string }>(raw);
  for (const entry of list.results ?? []) {
    if (typeof entry?.id === "number" && typeof entry?.name === "string") names.set(entry.id, entry.name);
  }
  return names;
}

export async function searchPaperlessDocuments(
  context: PaperlessReadContext,
  request: { query: string; tags?: string[] },
): Promise<DocumentSearchResult> {
  const builtQuery = buildPaperlessSearchQuery(request.query, request.tags);
  const raw = await paperlessGet(
    context,
    `/api/documents/?query=${encodeURIComponent(builtQuery)}&page_size=${SEARCH_RESULT_LIMIT}`,
  );
  const list = asRawList<RawDocumentListItem>(raw);
  const items = (list.results ?? []).slice(0, SEARCH_RESULT_LIMIT);

  const correspondentIds = items.map((item) => item.correspondent).filter((id): id is number => typeof id === "number");
  const tagIds = items.flatMap((item) => item.tags ?? []).filter((id): id is number => typeof id === "number");
  const [correspondents, tags] = await Promise.all([
    resolveNames(context, "correspondents", correspondentIds),
    resolveNames(context, "tags", tagIds),
  ]);

  const results: DocumentSearchHit[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    correspondent: item.correspondent !== null && item.correspondent !== undefined ? correspondents.get(item.correspondent) ?? null : null,
    date: dateOnly(item.created),
    tags: (item.tags ?? []).map((id) => tags.get(id)).filter((name): name is string => typeof name === "string"),
    snippet: clipSnippet(item.__search_hit__?.highlights ?? item.content ?? ""),
  }));

  return {
    kind: "document_search",
    query: request.query,
    tags: request.tags && request.tags.length > 0 ? request.tags : null,
    results,
    totalCount: typeof list.count === "number" ? list.count : results.length,
  };
}

export async function getPaperlessDocument(context: PaperlessReadContext, documentId: number): Promise<DocumentDetail> {
  const raw = await paperlessGet(context, `/api/documents/${documentId}/`, { notFoundDocumentId: documentId });
  const doc = raw as RawDocumentListItem & { document_type?: number | null };

  const [correspondentName, documentTypeName, tagNames] = await Promise.all([
    typeof doc.correspondent === "number"
      ? paperlessGet(context, `/api/correspondents/${doc.correspondent}/`).then(
          (value) => (value as { name?: string } | null)?.name ?? null,
          () => null,
        )
      : Promise.resolve(null),
    typeof doc.document_type === "number"
      ? paperlessGet(context, `/api/document_types/${doc.document_type}/`).then(
          (value) => (value as { name?: string } | null)?.name ?? null,
          () => null,
        )
      : Promise.resolve(null),
    resolveNames(context, "tags", doc.tags ?? []),
  ]);

  return {
    id: doc.id,
    title: doc.title,
    correspondent: correspondentName,
    documentType: documentTypeName,
    date: dateOnly(doc.created),
    tags: (doc.tags ?? []).map((id) => tagNames.get(id)).filter((name): name is string => typeof name === "string"),
    originalFileName: doc.original_file_name ?? null,
    // Not fetched: would need a separate /metadata/ request for a field
    // Phase 1's contract does not require. See doc/plans/2026-10-01-paperless-ngx-documents-integration.md.
    pageCount: null,
  };
}

const PAPERLESS_DOWNLOAD_PATH = (documentId: number) => `/api/documents/${documentId}/download/`;

/** The raw download response (status + body), for the proxy route to stream on. Never read into memory beyond the transport's own cap. */
export async function fetchPaperlessDocumentDownload(
  context: PaperlessReadContext,
  documentId: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await context.fetch(`${context.baseUrl}${PAPERLESS_DOWNLOAD_PATH(documentId)}`, { method: "GET" });
  } catch {
    throw new DataSourceUpstreamError(
      "upstream_error",
      "Could not reach the paperless-ngx container, so the file could not be downloaded.",
    );
  }
  if (response.status === 404) throw new PaperlessDocumentNotFoundError(documentId);
  if (response.status < 200 || response.status >= 300) {
    throw new DataSourceUpstreamError(
      "upstream_error",
      `The paperless-ngx container answered with an error (status ${response.status}), so the file could not be downloaded.`,
    );
  }
  return response;
}
