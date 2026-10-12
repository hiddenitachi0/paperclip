import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KIND_LABELS,
  fikenConnectionConfigSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { FIKEN_OUTBOUND_POLICY } from "../safe-outbound-fetch.js";
import type { FikenReadContext } from "./connection-kind.js";
import { DataSourceUpstreamError } from "./contract.js";
import { createFikenClient } from "./fiken-client.js";
import type { DataSourceKindDefinition, OpenReadContextInput } from "./registry.js";

/**
 * DUR-4072 PR3: the Fiken entry of the source-kind registry -- read-only.
 *
 * Until now Fiken was a `pendingKind` (stored, never read). This entry gives
 * it a transport (fiken-client.ts: GET only, api.fiken.no only, this
 * company's slug only), a Test, and the report readers in
 * report-data-readers.ts. It answers no agent "sales" question; the only
 * reader is a report template's server-side data fetch.
 *
 * How a person gets a key (shown on the Data sources screen):
 *   In Fiken, open the company, then your name (top right) → Innstillinger →
 *   API → «Personlige API-nøkler» and create a key called "Paperclip". The
 *   company needs Fiken's API module switched on (a paid add-on in Fiken).
 *   The key can do whatever your Fiken user can; Paperclip itself only ever
 *   sends read requests with it.
 */

function configOf(input: OpenReadContextInput) {
  const { connection } = input;
  if (connection.kind !== "fiken" || connection.config.kind !== "fiken") {
    throw unprocessable("This connection is of another kind than the Fiken adapter expected.", { code: "data_source_kind_mismatch" });
  }
  return connection.config;
}

function openFikenContext(input: OpenReadContextInput): FikenReadContext {
  const config = configOf(input);
  const now = input.deps.now ?? Date.now;
  const fiken = createFikenClient({
    companySlug: config.companySlug,
    getApiToken: async () => {
      const credential = await input.loadCredential();
      if (credential.kind !== "api_token") {
        throw unprocessable("The stored key does not fit a Fiken connection. Paste it in again.", { code: "credential_kind_mismatch" });
      }
      return credential.apiToken;
    },
    budget: input.budget,
    knownSecrets: input.knownSecrets,
    fetchImpl: input.deps.fetchImpl,
    now,
    sleep: input.deps.sleep,
  });
  return {
    kind: "fiken",
    connection: input.connection,
    fiken,
    now: () => new Date(now()),
    stats: () => ({ requests: fiken.stats().requests, costPoints: 0 }),
  };
}

export const FIKEN_READ_ONLY_NOTE =
  "Paperclip only reads from Fiken: it sends nothing but read requests. Fiken's API keys can also change data, so keep the key private.";

export const fikenDataSource: DataSourceKindDefinition = {
  kind: "fiken",
  label: DATA_CONNECTION_KIND_LABELS.fiken,
  supported: true,
  credentialKinds: DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND.fiken,
  datasets: ["finance"],
  configSchema: fikenConnectionConfigSchema,
  storedShape(create) {
    if (create.kind !== "fiken") throw unprocessable("Wrong kind of connection for Fiken.");
    // The config schema keeps only the slug: no secret can land in `config`.
    return { shopDomain: null, apiVersion: null, config: fikenConnectionConfigSchema.parse(create) as Record<string, unknown>, access: "read" };
  },
  describeTarget(connection) {
    return connection.config.kind === "fiken" ? connection.config.companySlug : "";
  },
  outboundPolicy: () => FIKEN_OUTBOUND_POLICY,
  canActivate(observed) {
    if (!observed?.checkedAt) return { ok: false, problems: ["The connection has not passed Test yet. Press Test first."] };
    return { ok: true, problems: [] };
  },
  openReadContext: openFikenContext,
  async check(input) {
    const context = openFikenContext(input);
    try {
      const { body } = await context.fiken.get("");
      const company = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const name = typeof company.name === "string" ? company.name : context.fiken.companySlug;
      return {
        ok: true,
        canActivate: true,
        problems: [],
        notes: [`Connected to ${name} in Fiken.`, FIKEN_READ_ONLY_NOTE],
        observed: {
          shopName: name,
          shopDomain: null,
          ianaTimezone: "Europe/Oslo",
          currencyCode: "NOK",
          grantedScopes: [],
          earliestVisibleOrderAt: null,
          productTypeCoverage: null,
          fileServer: null,
          checkedAt: context.now().toISOString(),
        },
        stats: context.stats(),
      };
    } catch (error) {
      if (!(error instanceof DataSourceUpstreamError)) throw error;
      return { ok: false, canActivate: false, problems: [error.message], notes: [], observed: null, stats: context.stats() };
    }
  },
  adapters: {},
};
