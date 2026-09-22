import type { z } from "zod";
import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KINDS,
  DATA_CONNECTION_KIND_LABELS,
  fikenConnectionConfigSchema,
  sftpFileConnectionConfigSchema,
  wooCommerceConnectionConfigSchema,
  type CreateDataConnectionInput,
  type DataConnectionConfig,
  type DataConnectionCredentialKind,
  type DataConnectionKind,
  type DataConnectionObservedSummary,
  type DataDataset,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import {
  createWooCommerceOutboundPolicy,
  FIKEN_OUTBOUND_POLICY,
  type OutboundFetch,
  type OutboundHostPolicy,
} from "../safe-outbound-fetch.js";
import type {
  CredentialLoader,
  DataSourceCallBudget,
  DataSourceCheckOutcome,
  DataSourceConnectionInfo,
  DataSourceReadContext,
  SalesAdapter,
} from "./connection-kind.js";
import { shopifyDataSource } from "./shopify-source.js";

/**
 * DUR-3997 slice 3: the source-kind registry.
 *
 * One entry per kind a data_connections row can have. Everything that used to
 * be "if Shopify" in data-connections.ts, business-data.ts and data-trial.ts
 * now goes through `getDataSourceKind(row.kind)`, so adding WooCommerce or
 * Fiken means writing one entry (its transport, its Test, its adapters) and
 * nothing else changes.
 *
 * Shopify is the only kind with `supported: true` today. The other three are
 * registered so that a connection of that kind can be validated, stored and
 * shown, and so that every path that would read through it answers with the
 * same plain sentence instead of crashing.
 */

/** Everything a kind gets when it opens a read context or runs its Test. No credential value. */
export interface OpenReadContextInput {
  connection: DataSourceConnectionInfo;
  /** Resolves the credential once, lazily, when the transport first needs it. */
  loadCredential: CredentialLoader;
  budget: DataSourceCallBudget;
  /** Values that must be scrubbed out of every error text (grows as tokens are minted). */
  knownSecrets: () => string[];
  /** Adds a derived value (a short-lived token) to the scrub list. */
  registerSecret: (value: string) => void;
  deps: {
    /** Replaces the guarded fetch; tests only. */
    fetchImpl?: OutboundFetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Product pages the Shopify Test reads at most (250 products each). */
    maxProductPages?: number;
  };
}

export interface SalesAdapterOptions {
  limits?: { maxDurationMs?: number };
  sleep?: (ms: number) => Promise<void>;
}

/** What a create input becomes in the row: Shopify's own columns, or `config` for every other kind. */
export interface StoredConnectionShape {
  shopDomain: string | null;
  apiVersion: string | null;
  config: Record<string, unknown>;
}

export interface DataSourceKindDefinition {
  kind: DataConnectionKind;
  label: string;
  /** Whether Paperclip can read through this kind today. */
  supported: boolean;
  credentialKinds: readonly DataConnectionCredentialKind[];
  /** Datasets this kind can answer at all (what may be granted to it). */
  datasets: readonly DataDataset[];
  /** The per-kind non-secret settings kept in data_connections.config. */
  configSchema: z.ZodTypeAny;
  storedShape(input: CreateDataConnectionInput): StoredConnectionShape;
  /** Where the connection points, in words. Never a secret. */
  describeTarget(connection: Pick<DataSourceConnectionInfo, "shopDomain" | "config">): string;
  /** Which host this connection may reach; null for a kind without an HTTP transport. */
  outboundPolicy(config: DataConnectionConfig): OutboundHostPolicy | null;
  /** From what the last Test observed: may the connection be switched on? */
  canActivate(observed: DataConnectionObservedSummary | null): { ok: boolean; problems: string[] };
  /** The per-kind transport for one lookup, carrying the key. Throws 422 for an unsupported kind. */
  openReadContext(input: OpenReadContextInput): DataSourceReadContext;
  /** "Test": ask the source who it is and what the key may do. Never throws for an unsupported kind. */
  check(input: OpenReadContextInput): Promise<DataSourceCheckOutcome>;
  /** When the key is replaced or the connection removed: drop any cached short-lived token. */
  forgetCachedTokens?(connectionId: string): void;
  adapters: {
    sales?: (context: DataSourceReadContext, options?: SalesAdapterOptions) => SalesAdapter;
    /** Exact product types in the catalog, for matching a person's words. */
    productTypes?: (context: DataSourceReadContext) => Promise<string[]>;
  };
}

export function unsupportedKindMessage(kind: DataConnectionKind): string {
  return `${DATA_CONNECTION_KIND_LABELS[kind]}-koblinger kan ikke leses ennå. Koblingen er lagret, og tas i bruk når støtten er klar.`;
}

export function unsupportedKindError(kind: DataConnectionKind) {
  return unprocessable(unsupportedKindMessage(kind), { code: "data_source_kind_unsupported", kind });
}

/**
 * A kind that is accepted and stored but has no transport yet. Every read
 * path answers with one plain sentence; nothing is contacted.
 */
function pendingKind(input: {
  kind: Exclude<DataConnectionKind, "shopify">;
  datasets: readonly DataDataset[];
  configSchema: z.ZodTypeAny;
  describeTarget: (config: DataConnectionConfig) => string;
  outboundPolicy: (config: DataConnectionConfig) => OutboundHostPolicy | null;
}): DataSourceKindDefinition {
  const { kind } = input;
  return {
    kind,
    label: DATA_CONNECTION_KIND_LABELS[kind],
    supported: false,
    credentialKinds: DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND[kind],
    datasets: input.datasets,
    configSchema: input.configSchema,
    storedShape(create) {
      if (create.kind !== kind) throw unprocessable(`Feil type kobling for ${DATA_CONNECTION_KIND_LABELS[kind]}.`);
      // The config schema keeps only its own fields: the credential, the name
      // and the cap are stripped, so no secret can land in `config`.
      return { shopDomain: null, apiVersion: null, config: input.configSchema.parse(create) as Record<string, unknown> };
    },
    describeTarget(connection) {
      return input.describeTarget(connection.config);
    },
    outboundPolicy: input.outboundPolicy,
    canActivate() {
      return { ok: false, problems: [unsupportedKindMessage(kind)] };
    },
    openReadContext() {
      throw unsupportedKindError(kind);
    },
    async check() {
      return {
        ok: false,
        canActivate: false,
        problems: [unsupportedKindMessage(kind)],
        notes: [],
        observed: null,
        stats: { requests: 0, costPoints: 0 },
      };
    },
    adapters: {},
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const REGISTRY: Record<DataConnectionKind, DataSourceKindDefinition> = {
  shopify: shopifyDataSource,
  woocommerce: pendingKind({
    kind: "woocommerce",
    datasets: ["sales"],
    configSchema: wooCommerceConnectionConfigSchema,
    describeTarget: (config) => (config.kind === "woocommerce" ? hostOf(config.storeUrl) : ""),
    outboundPolicy: (config) => (config.kind === "woocommerce" ? createWooCommerceOutboundPolicy(config.storeUrl) : null),
  }),
  fiken: pendingKind({
    kind: "fiken",
    datasets: ["finance"],
    configSchema: fikenConnectionConfigSchema,
    describeTarget: (config) => (config.kind === "fiken" ? config.companySlug : ""),
    outboundPolicy: () => FIKEN_OUTBOUND_POLICY,
  }),
  sftp_file: pendingKind({
    kind: "sftp_file",
    datasets: ["custom"],
    configSchema: sftpFileConnectionConfigSchema,
    describeTarget: (config) =>
      config.kind === "sftp_file"
        ? `${config.host}${config.port === 22 ? "" : `:${config.port}`}${config.remotePath}`
        : "",
    // No HTTP transport: the SFTP transport is a pending decision, and nothing
    // in this slice opens a socket to an SFTP host.
    outboundPolicy: () => null,
  }),
};

export function isDataSourceKind(kind: string): kind is DataConnectionKind {
  return (DATA_CONNECTION_KINDS as readonly string[]).includes(kind);
}

/** The entry for a kind. An unknown kind (a row nobody in this codebase wrote) is refused, never guessed. */
export function getDataSourceKind(kind: string): DataSourceKindDefinition {
  if (!isDataSourceKind(kind)) {
    throw unprocessable("Denne datakoblingen er av en type Paperclip ikke kjenner.", {
      code: "data_source_kind_unknown",
    });
  }
  return REGISTRY[kind];
}

export function listDataSourceKinds(): DataSourceKindDefinition[] {
  return DATA_CONNECTION_KINDS.map((kind) => REGISTRY[kind]);
}
