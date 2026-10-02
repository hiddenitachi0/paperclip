import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type { DataReadChannel, DataReadOutcome } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "./data-connections.js";
import { countDataReadEvents, recordDataReadEvent } from "./data-read-audit.js";
import { getDataSourceKind } from "./data-sources/registry.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { zonedDayStart, zonedParts } from "./data-sources/zoned-time.js";
import type { DocumentDetail, DocumentsAdapter, DocumentSearchResult } from "./data-sources/documents-contract.js";
import { createDocumentDownloadToken } from "./documents-download-token.js";
import { documentsSettingsService } from "./documents-settings.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * DUR-4303: the documents query service -- the ONE place an agent's
 * search_documents/get_document tool call becomes a read through a
 * company's own paperless-ngx container. Modelled on business-data.ts and
 * company-files.ts, in the same fixed order:
 *
 *   1. the company comes from the caller's server-side context, never input
 *   2. the instance switch ("Data sources") and the per-company
 *      `documentsEnabled` flag must both be on (documents-settings.ts)
 *   3. the company's active "documents" dataset source is looked up
 *   4. input is validated strictly
 *   5. limits, counted from data_read_events: per run (signed run id only)
 *      and per agent per minute -- the request budget that bounds how much
 *      one conversation can hit the company's own container
 *   6. the key is resolved inside openReadContext; never returned here
 *   7. the paperless-ngx documents adapter answers (paperless-source.ts)
 *   8. get_document only: a short-lived download token is minted, naming
 *      only companyId + documentId -- never the container's host/port or
 *      its API token (documents-download-token.ts; the proxy route in
 *      documents-download.ts re-resolves the connection from companyId
 *      fresh on every download, never from a cached value)
 *   9. the audit row is written -- for refusals too
 *
 * costPoints is always 0 for this kind (no per-request cost unit like
 * Shopify's query cost).
 */

export const DOCUMENTS_DATASET = "documents" as const;

export const DOCUMENTS_LIMITS = {
  /** The request budget: bounds how much one conversation can hit the container. */
  perRun: 10,
  perAgentPerMinute: 6,
} as const;

/** The whole lookup (search or get, including name resolution) must finish in this time. */
export const DOCUMENTS_LOOKUP_TIMEOUT_MS = 15_000;
const LOOKUP_BUDGET = { maxRequests: 6, deadlineMs: DOCUMENTS_LOOKUP_TIMEOUT_MS };
const LIMIT_DAY_TIMEZONE = "Europe/Oslo";
const NOT_COUNTED_OUTCOMES: DataReadOutcome[] = ["rate_limited"];
/** How long a get_document download link stays valid. */
const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

export const searchDocumentsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  })
  .strict();
export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;

export const getDocumentInputSchema = z
  .object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((value) => Number(value)),
  })
  .strict();
export type GetDocumentInput = z.infer<typeof getDocumentInputSchema>;

/** Who is asking. Built by the server from the authenticated request, never from tool input. */
export interface DocumentsCaller {
  companyId: string;
  channel: DataReadChannel;
  agentId: string | null;
  userId: string | null;
  /** The run from a SIGNED agent token only (see business-data.ts's signedRunIdFromActor). */
  runId: string | null;
  laneAConversationId: string | null;
}

export interface DocumentsAnswer {
  ok: boolean;
  outcome: DataReadOutcome;
  refusalCode: string | null;
  lookupId: string | null;
  /** What the model is shown. */
  text: string;
}

const FEATURE_OFF_MESSAGE =
  "Data sources are switched off for this Paperclip installation, so I cannot read documents right now. An administrator can switch them on.";

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface DocumentsServiceDeps extends DataConnectionServiceDeps {
  /** Tests only: overrides the download token minted for get_document. */
  createDownloadToken?: typeof createDocumentDownloadToken;
}

export function documentsDataService(db: Db, deps: DocumentsServiceDeps = {}) {
  const connections = dataConnectionService(db, deps);
  const instanceSettings = instanceSettingsService(db);
  const documentsSettings = documentsSettingsService(db);
  const nowMs = deps.now ?? Date.now;
  const mintToken = deps.createDownloadToken ?? createDocumentDownloadToken;

  async function featureOn(): Promise<boolean> {
    const experimental = await instanceSettings.getExperimental();
    return experimental.enableBusinessData === true;
  }

  async function companyName(companyId: string): Promise<string> {
    const [row] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    return row?.name ?? "This company";
  }

  /** Whether the quick-agent tools should be offered at all: instance switch, company flag, and an active connection. */
  async function isAvailable(companyId: string): Promise<boolean> {
    if (!(await featureOn())) return false;
    if (!(await documentsSettings.isEnabled(companyId))) return false;
    return (await connections.getActiveDatasetSource(companyId, DOCUMENTS_DATASET)) !== null;
  }

  async function writeAudit(
    caller: DocumentsCaller,
    input: {
      id?: string;
      connectionId: string | null;
      dataset: "search_documents" | "get_document";
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      refusalCode: string | null;
      facts?: Record<string, unknown> | null;
      upstreamRequests?: number;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<string> {
    return recordDataReadEvent(db, {
      id: input.id,
      createdAt: new Date(nowMs()),
      companyId: caller.companyId,
      connectionId: input.connectionId,
      dataset: DOCUMENTS_DATASET,
      channel: caller.channel,
      agentId: caller.agentId,
      userId: caller.userId,
      runId: caller.runId,
      laneAConversationId: caller.laneAConversationId,
      params: { action: input.dataset, ...input.params },
      outcome: input.outcome,
      refusalCode: input.refusalCode,
      facts: input.facts ?? null,
      upstreamRequests: input.upstreamRequests ?? 0,
      costPoints: 0,
      durationMs: nowMs() - input.startedAt,
      scrubValues: input.scrubValues,
    });
  }

  async function refuse(
    caller: DocumentsCaller,
    input: {
      connectionId: string | null;
      dataset: "search_documents" | "get_document";
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      code: string;
      message: string;
      upstreamRequests?: number;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<DocumentsAnswer> {
    let lookupId: string | null = null;
    try {
      lookupId = await writeAudit(caller, {
        connectionId: input.connectionId,
        dataset: input.dataset,
        params: input.params,
        outcome: input.outcome,
        refusalCode: input.code,
        facts: { answer: input.message },
        upstreamRequests: input.upstreamRequests,
        startedAt: input.startedAt,
        scrubValues: input.scrubValues,
      });
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, code: input.code, err: error instanceof Error ? error.message : String(error) },
        "documents: could not write the audit row for a refusal",
      );
    }
    return { ok: false, outcome: input.outcome, refusalCode: input.code, lookupId, text: input.message };
  }

  async function limitRefusal(
    caller: DocumentsCaller,
    connectionId: string,
    dailyCap: number,
    name: string,
  ): Promise<{ code: string; message: string } | null> {
    const now = new Date(nowMs());
    const base = { companyId: caller.companyId, dataset: DOCUMENTS_DATASET, excludeOutcomes: NOT_COUNTED_OUTCOMES };
    if (caller.runId) {
      const used = await countDataReadEvents(db, { ...base, runId: caller.runId, since: new Date(0) });
      if (used >= DOCUMENTS_LIMITS.perRun) {
        return {
          code: "run_limit",
          message: `This run has already made ${DOCUMENTS_LIMITS.perRun} document lookups, which is the limit per run. No more documents are read now.`,
        };
      }
    }
    if (caller.agentId) {
      const used = await countDataReadEvents(db, { ...base, agentId: caller.agentId, since: new Date(now.getTime() - 60_000) });
      if (used >= DOCUMENTS_LIMITS.perAgentPerMinute) {
        return {
          code: "agent_minute_limit",
          message: `I have made ${DOCUMENTS_LIMITS.perAgentPerMinute} document lookups in the last minute, which is the limit per agent. Wait a minute and ask again.`,
        };
      }
    }
    const today = zonedParts(now, LIMIT_DAY_TIMEZONE);
    const dayStart = zonedDayStart(today.year, today.month, today.day, LIMIT_DAY_TIMEZONE);
    const usedToday = await countDataReadEvents(db, { ...base, connectionId, since: dayStart });
    if (usedToday >= dailyCap) {
      return {
        code: "daily_cap",
        message:
          `${name} has used all ${dailyCap} document lookups for today, which is the connection's daily limit. ` +
          "The limit resets at midnight (Norwegian time). A board user can raise it under Settings → Data sources.",
      };
    }
    return null;
  }

  /**
   * Everything through step 3: the feature flags, the connection, and the
   * opened read context. Shared by search and get. Returns either a ready
   * context or a finished refusal.
   */
  async function openForRead(
    caller: DocumentsCaller,
    dataset: "search_documents" | "get_document",
    params: Record<string, unknown>,
    startedAt: number,
  ): Promise<
    | { ok: true; connectionId: string; context: DocumentsAdapter; knownSecrets: () => string[] }
    | { ok: false; answer: DocumentsAnswer }
  > {
    const name = await companyName(caller.companyId);
    if (!(await featureOn())) {
      return {
        ok: false,
        answer: await refuse(caller, {
          connectionId: null, dataset, params, outcome: "refused", code: "business_data_disabled",
          message: FEATURE_OFF_MESSAGE, startedAt,
        }),
      };
    }
    if (!(await documentsSettings.isEnabled(caller.companyId))) {
      return {
        ok: false,
        answer: await refuse(caller, {
          connectionId: null, dataset, params, outcome: "refused", code: "documents_disabled",
          message: "Documents are switched off for this company. An owner or admin can turn them on under Data sources settings.",
          startedAt,
        }),
      };
    }
    const row = await connections.getActiveDatasetSource(caller.companyId, DOCUMENTS_DATASET);
    if (!row) {
      return {
        ok: false,
        answer: await refuse(caller, {
          connectionId: null, dataset, params, outcome: "refused", code: "not_connected",
          message: `${name} has no paperless-ngx connection switched on for documents. A board user can add one under Settings → Data sources.`,
          startedAt,
        }),
      };
    }
    const limited = await limitRefusal(caller, row.id, row.dailyLookupCap, name);
    if (limited) {
      return {
        ok: false,
        answer: await refuse(caller, {
          connectionId: row.id, dataset, params, outcome: "rate_limited", code: limited.code, message: limited.message, startedAt,
        }),
      };
    }
    let opened: Awaited<ReturnType<typeof connections.openReadContext>>;
    try {
      opened = await connections.openReadContext(
        caller.companyId,
        row.id,
        caller.agentId ? { actorType: "agent", actorId: caller.agentId } : { actorType: caller.userId ? "user" : "system", actorId: caller.userId ?? "documents" },
        LOOKUP_BUDGET,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        const code = (error.details as { code?: string } | undefined)?.code ?? "not_available";
        return { ok: false, answer: await refuse(caller, { connectionId: row.id, dataset, params, outcome: "refused", code, message: error.message, startedAt }) };
      }
      throw error;
    }
    const source = getDataSourceKind(opened.read.kind);
    if (!source.adapters.documents) {
      return {
        ok: false,
        answer: await refuse(caller, {
          connectionId: row.id, dataset, params, outcome: "refused", code: "data_source_kind_unsupported",
          message: `${source.label} connections cannot answer document questions yet.`, startedAt,
        }),
      };
    }
    const adapter = source.adapters.documents(opened.read);
    return { ok: true, connectionId: row.id, context: adapter, knownSecrets: opened.knownSecrets };
  }

  function renderSearchCard(result: DocumentSearchResult, lookupId: string): string {
    if (result.results.length === 0) {
      return `No documents matched "${result.query}"${result.tags ? ` with tags ${result.tags.join(", ")}` : ""}. Lookup ${lookupId}.`;
    }
    const lines = result.results.map((hit) => {
      const parts = [
        `#${hit.id} "${hit.title}"`,
        hit.correspondent ? `from ${hit.correspondent}` : null,
        hit.date ? `(${hit.date})` : null,
        hit.tags.length > 0 ? `[${hit.tags.join(", ")}]` : null,
      ].filter(Boolean);
      return `- ${parts.join(" ")}\n  ${hit.snippet}`;
    });
    const shown = result.results.length;
    const more = result.totalCount > shown ? ` (${result.totalCount} total match${result.totalCount === 1 ? "" : "es"}; showing the top ${shown})` : "";
    return [`Documents matching "${result.query}"${more}. Lookup ${lookupId}.`, ...lines].join("\n");
  }

  function renderDocumentCard(detail: DocumentDetail, lookupId: string, downloadUrl: string | null): string {
    const lines = [
      `#${detail.id} "${detail.title}"`,
      detail.correspondent ? `Correspondent: ${detail.correspondent}` : null,
      detail.documentType ? `Type: ${detail.documentType}` : null,
      detail.date ? `Date: ${detail.date}` : null,
      detail.tags.length > 0 ? `Tags: ${detail.tags.join(", ")}` : null,
      detail.originalFileName ? `File: ${detail.originalFileName}` : null,
      downloadUrl
        ? `Download (expires in ${Math.round(DOWNLOAD_TOKEN_TTL_SECONDS / 60)} minutes): ${downloadUrl}`
        : "Download link could not be created right now.",
      `Lookup ${lookupId}.`,
    ].filter(Boolean);
    return lines.join("\n");
  }

  /** search_documents: up to ~10 results, paperless-ngx's own OCR snippet as-is. */
  async function searchDocuments(caller: DocumentsCaller, rawInput: unknown): Promise<DocumentsAnswer> {
    const startedAt = nowMs();
    const parsed = searchDocumentsInputSchema.safeParse(rawInput);
    const params: Record<string, unknown> = parsed.success
      ? { query: parsed.data.query.slice(0, 300), tags: parsed.data.tags?.slice(0, 10) ?? null }
      : {};
    if (!parsed.success) {
      return refuse(caller, {
        connectionId: null, dataset: "search_documents", params, outcome: "refused", code: "invalid_request",
        message: "The request was not understood. Send only query (required) and, optionally, tags.", startedAt,
      });
    }
    const opened = await openForRead(caller, "search_documents", params, startedAt);
    if (!opened.ok) return opened.answer;
    const { connectionId, context: adapter, knownSecrets } = opened;
    try {
      const outcome = await adapter.search({ query: parsed.data.query, tags: parsed.data.tags });
      if (!outcome.ok) {
        return refuse(caller, {
          connectionId, dataset: "search_documents", params, outcome: "upstream_error", code: outcome.refusal.code,
          message: outcome.refusal.message, upstreamRequests: outcome.audit.upstreamRequests, startedAt, scrubValues: knownSecrets(),
        });
      }
      const lookupId = randomUUID();
      const card = scrubSecrets(renderSearchCard(outcome.result, lookupId), knownSecrets());
      const facts = { answer: card, resultCount: outcome.result.results.length, totalCount: outcome.result.totalCount };
      if (byteLength(facts) > 8192 - 512) {
        return refuse(caller, {
          connectionId, dataset: "search_documents", params, outcome: "refused", code: "answer_too_large",
          message: "The answer was too large to give in one go. Ask a narrower question.", startedAt, scrubValues: knownSecrets(),
        });
      }
      await writeAudit(caller, {
        id: lookupId, connectionId, dataset: "search_documents", params, outcome: outcome.result.results.length === 0 ? "no_data" : "ok",
        refusalCode: null, facts, upstreamRequests: outcome.audit.upstreamRequests, startedAt, scrubValues: knownSecrets(),
      });
      return { ok: true, outcome: outcome.result.results.length === 0 ? "no_data" : "ok", refusalCode: null, lookupId, text: card };
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, err: scrubSecrets(error instanceof Error ? error.message : String(error), knownSecrets()) },
        "documents: search failed unexpectedly",
      );
      return refuse(caller, {
        connectionId, dataset: "search_documents", params, outcome: "upstream_error", code: "unexpected_error",
        message: "The search could not be completed because of an error, so no documents are shown. The error has been logged.",
        startedAt, scrubValues: knownSecrets(),
      });
    }
  }

  /** get_document: full metadata plus a short-lived, server-proxied download link. */
  async function getDocument(caller: DocumentsCaller, rawInput: unknown): Promise<DocumentsAnswer> {
    const startedAt = nowMs();
    const parsed = getDocumentInputSchema.safeParse(rawInput);
    const params: Record<string, unknown> = parsed.success ? { id: parsed.data.id } : {};
    if (!parsed.success) {
      return refuse(caller, {
        connectionId: null, dataset: "get_document", params, outcome: "refused", code: "invalid_request",
        message: "The request was not understood. Send only id (the document's number).", startedAt,
      });
    }
    const opened = await openForRead(caller, "get_document", params, startedAt);
    if (!opened.ok) return opened.answer;
    const { connectionId, context: adapter, knownSecrets } = opened;
    try {
      const outcome = await adapter.get(parsed.data.id);
      if (!outcome.ok) {
        return refuse(caller, {
          connectionId, dataset: "get_document", params, outcome: outcome.refusal.code === "not_found" ? "refused" : "upstream_error",
          code: outcome.refusal.code, message: outcome.refusal.message, upstreamRequests: outcome.audit.upstreamRequests,
          startedAt, scrubValues: knownSecrets(),
        });
      }
      const lookupId = randomUUID();
      // DUR-4303 security note: the token names only companyId + documentId.
      // The proxy route (documents-download.ts) re-resolves THIS company's
      // own connection row fresh from the database on every download -- the
      // token itself carries no connectionId, host or credential, so it can
      // never be used to reach another company's container.
      const token = mintToken(caller.companyId, outcome.result.id, DOWNLOAD_TOKEN_TTL_SECONDS);
      const downloadUrl = token ? `${(process.env.PAPERCLIP_PUBLIC_URL ?? "").replace(/\/+$/, "")}/api/documents/download/${token}` : null;
      const card = scrubSecrets(renderDocumentCard(outcome.result, lookupId, downloadUrl), knownSecrets());
      await writeAudit(caller, {
        id: lookupId, connectionId, dataset: "get_document", params, outcome: "ok", refusalCode: null,
        facts: { answer: card }, upstreamRequests: outcome.audit.upstreamRequests, startedAt, scrubValues: knownSecrets(),
      });
      return { ok: true, outcome: "ok", refusalCode: null, lookupId, text: card };
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, err: scrubSecrets(error instanceof Error ? error.message : String(error), knownSecrets()) },
        "documents: get failed unexpectedly",
      );
      return refuse(caller, {
        connectionId, dataset: "get_document", params, outcome: "upstream_error", code: "unexpected_error",
        message: "The document could not be read because of an error, so nothing is shown. The error has been logged.",
        startedAt, scrubValues: knownSecrets(),
      });
    }
  }

  return { featureOn, isAvailable, companyName, searchDocuments, getDocument };
}

export type DocumentsDataService = ReturnType<typeof documentsDataService>;
