import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KIND_LABELS,
  paperlessNgxConnectionConfigSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { createPaperlessNgxOutboundPolicy, createPinnedInternalFetch, type OutboundFetch } from "../safe-outbound-fetch.js";
import type { DataSourceReadContext, PaperlessReadContext } from "./connection-kind.js";
import { DataSourceUpstreamError } from "./contract.js";
import type { DocumentsAdapter, DocumentsOutcome } from "./documents-contract.js";
import { getPaperlessDocument, PaperlessDocumentNotFoundError, searchPaperlessDocuments } from "./paperless-documents-client.js";
import type { DataSourceKindDefinition, OpenReadContextInput } from "./registry.js";
import { runPaperlessConnectionCheck } from "./paperless-connection-check.js";

/**
 * DUR-4302: the paperless-ngx entry of the source-kind registry. One
 * container per company (Filip, 1 Oct 2026), never publicly reachable --
 * `openPaperlessContext` is the one place that builds the pinned, internal-
 * only, host:port-exact transport (createPinnedInternalFetch) and attaches
 * the company's own token to it.
 *
 * DUR-4303: `adapters.documents` is the read-only search_documents/
 * get_document surface, through this same pinned context -- it never opens
 * its own transport, so every document read is bound to the exact same
 * host:port-pinned, company-own-token-carrying fetch "Test" already uses.
 */
function documentsAdapterFor(context: PaperlessReadContext): DocumentsAdapter {
  async function run<T>(fn: () => Promise<T>): Promise<DocumentsOutcome<T>> {
    const startRequests = context.stats().requests;
    const startedAt = Date.now();
    try {
      const result = await fn();
      return { ok: true, result, audit: { upstreamRequests: context.stats().requests - startRequests, durationMs: Date.now() - startedAt } };
    } catch (error) {
      const audit = { upstreamRequests: context.stats().requests - startRequests, durationMs: Date.now() - startedAt };
      if (error instanceof PaperlessDocumentNotFoundError) {
        return { ok: false, refusal: { code: "not_found", message: `No document with id ${error.documentId} in paperless-ngx.` }, audit };
      }
      if (error instanceof DataSourceUpstreamError) {
        return { ok: false, refusal: { code: error.code === "unexpected_shape" ? "unexpected_shape" : "upstream_error", message: error.message }, audit };
      }
      throw error;
    }
  }

  return {
    search(request) {
      return run(() => searchPaperlessDocuments(context, request));
    },
    get(documentId) {
      return run(() => getPaperlessDocument(context, documentId));
    },
  };
}

function configOf(input: OpenReadContextInput) {
  const { connection } = input;
  if (connection.kind !== "paperless_ngx" || connection.config.kind !== "paperless_ngx") {
    throw unprocessable("This connection is of another kind than the paperless-ngx adapter expected.", {
      code: "data_source_kind_mismatch",
    });
  }
  return connection.config;
}

function openPaperlessContext(input: OpenReadContextInput): PaperlessReadContext {
  const config = configOf(input);
  const { connection, deps } = input;
  const now = deps.now ?? Date.now;
  const policy = createPaperlessNgxOutboundPolicy(config.host, config.port);
  const baseUrl = `${policy.protocol}//${policy.host}:${policy.port}`;
  const guardedFetch = deps.fetchImpl ?? createPinnedInternalFetch(policy);

  let requests = 0;
  const authedFetch: OutboundFetch = (async (fetchInput, init) => {
    const credential = await input.loadCredential();
    if (credential.kind !== "paperless_api_token") {
      throw unprocessable("The stored key does not fit a paperless-ngx connection. Paste it in again.", {
        code: "credential_kind_mismatch",
      });
    }
    requests += 1;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Token ${credential.apiToken}`);
    return guardedFetch(fetchInput, { ...init, headers });
  }) as OutboundFetch;

  return {
    kind: "paperless_ngx",
    connection,
    baseUrl,
    fetch: authedFetch,
    now: () => new Date(now()),
    stats: () => ({ requests, costPoints: 0 }),
  };
}

export const paperlessNgxDataSource: DataSourceKindDefinition = {
  kind: "paperless_ngx",
  label: DATA_CONNECTION_KIND_LABELS.paperless_ngx,
  supported: true,
  credentialKinds: DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND.paperless_ngx,
  datasets: ["documents"],
  configSchema: paperlessNgxConnectionConfigSchema,
  storedShape(input) {
    if (input.kind !== "paperless_ngx") throw unprocessable("Wrong kind of connection for paperless-ngx.");
    // The config schema keeps only its own fields: the credential, the name
    // and the cap are stripped, so no secret can land in `config`.
    const config = paperlessNgxConnectionConfigSchema.parse(input) as Record<string, unknown>;
    return { shopDomain: null, apiVersion: null, config, access: "read" };
  },
  describeTarget(connection) {
    const config = connection.config;
    if (config.kind !== "paperless_ngx") return "";
    return `${config.host}:${config.port}`;
  },
  outboundPolicy(config) {
    if (config.kind !== "paperless_ngx") return null;
    return createPaperlessNgxOutboundPolicy(config.host, config.port);
  },
  canActivate(observed) {
    if (!observed?.checkedAt) return { ok: false, problems: ["The connection has not passed Test yet. Press Test first."] };
    return { ok: true, problems: [] };
  },
  openReadContext: openPaperlessContext,
  adapters: {
    documents(context: DataSourceReadContext) {
      if (context.kind !== "paperless_ngx") {
        throw unprocessable("This connection is of another kind than the paperless-ngx documents adapter expected.", {
          code: "data_source_kind_mismatch",
        });
      }
      return documentsAdapterFor(context);
    },
  },
  async check(input) {
    const context = openPaperlessContext(input);
    const outcome = await runPaperlessConnectionCheck(context);
    return {
      ok: outcome.ok,
      canActivate: outcome.ok,
      problems: outcome.problems,
      notes: outcome.notes,
      observed: outcome.ok
        ? {
            shopName: null,
            shopDomain: null,
            ianaTimezone: null,
            currencyCode: null,
            grantedScopes: [],
            earliestVisibleOrderAt: null,
            productTypeCoverage: null,
            fileServer: null,
            checkedAt: context.now().toISOString(),
          }
        : null,
      stats: context.stats(),
    };
  },
};
