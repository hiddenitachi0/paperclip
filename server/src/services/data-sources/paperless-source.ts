import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KIND_LABELS,
  paperlessNgxConnectionConfigSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { createPaperlessNgxOutboundPolicy, createPinnedInternalFetch, type OutboundFetch } from "../safe-outbound-fetch.js";
import type { PaperlessReadContext } from "./connection-kind.js";
import type { DataSourceKindDefinition, OpenReadContextInput } from "./registry.js";
import { runPaperlessConnectionCheck } from "./paperless-connection-check.js";

/**
 * DUR-4302: the paperless-ngx entry of the source-kind registry. One
 * container per company (Filip, 1 Oct 2026), never publicly reachable --
 * `openPaperlessContext` is the one place that builds the pinned, internal-
 * only, host:port-exact transport (createPinnedInternalFetch) and attaches
 * the company's own token to it. No adapter reads through this context yet:
 * the `search_documents`/`get_document` agent tools are a separate, later
 * slice (see doc/plans/2026-10-01-paperless-ngx-documents-integration.md).
 * Until that slice ships, the only thing that uses this context is "Test".
 */

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
  adapters: {},
};
