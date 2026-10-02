/**
 * DUR-4303: the documents contract -- the shape every "documents" dataset
 * adapter answers in (paperless-ngx today), mirroring contract.ts's sales
 * shape but kept separate: a document result has nothing in common with a
 * sales invariant check, and reusing DATA_REFUSAL_CODES (a sales-specific
 * enum) here would make an unrelated kind's refusal codes look reusable when
 * they are not.
 *
 * Phase 1 is read-only: search and get. No upload/consume adapter exists
 * (see doc/plans/2026-10-01-paperless-ngx-documents-integration.md).
 */

export const DOCUMENTS_REFUSAL_CODES = [
  "invalid_request",
  "not_found",
  "throttled",
  "request_budget_exceeded",
  "time_budget_exceeded",
  "upstream_error",
  "unexpected_shape",
] as const;
export type DocumentsRefusalCode = (typeof DOCUMENTS_REFUSAL_CODES)[number];

export interface DocumentsRefusal {
  code: DocumentsRefusalCode;
  message: string;
  /** Machine detail for the audit row (never shown to the model). */
  detail?: string[];
}

/** What one documents-adapter call writes into data_read_events (costPoints is always 0 for this kind). */
export interface DocumentsAudit {
  upstreamRequests: number;
  durationMs: number;
}

export type DocumentsOutcome<T> =
  | { ok: true; result: T; audit: DocumentsAudit }
  | { ok: false; refusal: DocumentsRefusal; audit: DocumentsAudit };

/** One search hit: paperless-ngx's own OCR snippet as-is, never re-ranked or re-written. */
export interface DocumentSearchHit {
  id: number;
  title: string;
  /** Correspondent's display name; null when the document has none. */
  correspondent: string | null;
  /** The document's own "created" date, ISO (date-only), null when paperless-ngx has none. */
  date: string | null;
  /** Tag display names, not ids. */
  tags: string[];
  /** paperless-ngx's own search snippet/highlight around the match. */
  snippet: string;
}

export interface DocumentSearchResult {
  kind: "document_search";
  query: string;
  tags: string[] | null;
  /** At most ~10, per the design doc. */
  results: DocumentSearchHit[];
  /** paperless-ngx's own total match count, which may be larger than `results.length`. */
  totalCount: number;
}

export interface DocumentDetail {
  id: number;
  title: string;
  correspondent: string | null;
  documentType: string | null;
  date: string | null;
  tags: string[];
  originalFileName: string | null;
  pageCount: number | null;
}

/** What the adapter gets for one "documents" lookup. */
export interface DocumentsAdapter {
  search(request: { query: string; tags?: string[] }): Promise<DocumentsOutcome<DocumentSearchResult>>;
  get(documentId: number): Promise<DocumentsOutcome<DocumentDetail>>;
}
