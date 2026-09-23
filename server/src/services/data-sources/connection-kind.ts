/**
 * DUR-3972 / DUR-3997 slice 3: THE interface between the business-data
 * foundation (tables, credential, audit) and the code that actually reads a
 * source (one adapter per kind, registered in registry.ts).
 *
 * If you are adding a source kind, read this file and registry.ts.
 *
 * WHO OWNS WHAT
 * -------------
 *   The foundation (data-connections.ts) owns:
 *     - the tables: data_connections, data_dataset_sources, data_read_events
 *     - the key: stored as a company secret, bound to the connection, locked so
 *       it can be bound to nothing else, read in exactly one place
 *       (dataConnectionService.resolveCredential)
 *     - the outbound-call guard (safe-outbound-fetch.ts): https only, one host
 *       pattern per source kind, public addresses only, no redirects, 10 s per
 *       request, 5 MB response cap
 *     - the audit writer (data-read-audit.ts): one row per lookup, refusals
 *       included, facts capped at 8 KB and scrubbed
 *
 *   A source kind (registry.ts entry) owns:
 *     - its outbound policy (which host it may reach)
 *     - opening a read context: a per-kind transport, already carrying the
 *       key, already going through the guard. The adapter never sees the key,
 *       never builds a URL from user input, and never calls fetch itself.
 *     - its connection check ("Test")
 *     - its dataset adapters: `sales` (Shopify today), later `finance`, ...
 *
 *   The query service (business-data.ts) calls, in this order:
 *     0. the instance switch: instanceSettings.getExperimental().enableBusinessData
 *     1. dataConnectionService.getActiveDatasetSource(companyId, "sales")
 *        -- company from the CALLER's context only, never from input
 *     2. its limits, counted with countDataReadEvents (data-read-audit.ts)
 *     3. const { read, knownSecrets } =
 *          await dataConnectionService.openReadContext(companyId, connectionId,
 *            { actorType: "agent", actorId: agentId })
 *     4. getDataSourceKind(read.kind).adapters.sales(read, ...).sales(request)
 *     5. recordDataReadEvent(db, { ..., scrubValues: knownSecrets() })
 *        -- also for every refusal
 *
 * WHAT IS NOT HERE ON PURPOSE
 * ---------------------------
 *   - No write access for anything but a `read_write` file-server connection
 *     (the company's own server), and even there only through
 *     FileServerOperations, which refuses a write on a `read` connection
 *     before any command is sent. `access` is 'read' or 'read_write' by
 *     database constraint; every other kind is stored with 'read'.
 *   - No route for a full agent (run token) to read data. When one is built it
 *     must count runs by the signed claims.run_id only, never by the
 *     x-paperclip-run-id header.
 */
import type {
  DataConnectionAccessLevel,
  DataConnectionConfig,
  DataConnectionCredentialInput,
  DataConnectionKind,
  DataConnectionObservedSummary,
  DataReadChannel,
  FileServerKind,
} from "@paperclipai/shared";
import type { CatalogResult, DataLookupOutcome, SalesRequest, SalesResult } from "./contract.js";
import type { FileServerOperations } from "./file-server/operations.js";
import type { ShopifyGraphQLClient, ShopifyRawTransport } from "./shopify-client.js";

/** The limits one lookup runs under. Hitting either means a refusal, never a partial answer. */
export interface DataSourceCallBudget {
  /** Upstream HTTP requests allowed for this lookup (S3 plan: 60). */
  maxRequests: number;
  /** Wall-clock time allowed for this lookup, in ms (S3 plan: 25 000). */
  deadlineMs: number;
}

export const DEFAULT_LOOKUP_BUDGET: DataSourceCallBudget = { maxRequests: 60, deadlineMs: 25_000 };

/** What an adapter may know about the connection it reads through. No credential. */
export interface DataSourceConnectionInfo {
  id: string;
  companyId: string;
  kind: DataConnectionKind;
  name: string;
  /** Shopify only; null for other kinds. */
  shopDomain: string | null;
  /** Shopify only; null for other kinds. */
  apiVersion: string | null;
  /** Per-kind non-secret settings, tagged with the kind. */
  config: DataConnectionConfig;
  /** `read_write` only for a file-server connection to the company's own server. */
  access: DataConnectionAccessLevel;
  /** SFTP: the host-key fingerprint pinned at the first Test; null otherwise. */
  hostKeyFingerprint: string | null;
  /** From the last successful Test; may be null on a connection never tested. */
  ianaTimezone: string | null;
  currencyCode: string | null;
  /** ISO timestamp of the earliest order the key can see, from the last Test. */
  earliestVisibleOrderAt: string | null;
}

/** Who is asking, for the audit row. Company comes from the server, never from input. */
export interface DataReadActor {
  channel: DataReadChannel;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
  laneAConversationId?: string | null;
}

/** Upstream traffic so far in this read context, for the audit row. */
export interface DataSourceReadStats {
  requests: number;
  costPoints: number;
}

interface DataSourceReadContextBase {
  connection: DataSourceConnectionInfo;
  /** Injected clock, so month boundaries are testable. */
  now: () => Date;
  /** Requests made through this context so far (all transports it holds). */
  stats: () => DataSourceReadStats;
}

/** What the Shopify sales engine and the Test get. */
export interface ShopifyReadContext extends DataSourceReadContextBase {
  kind: "shopify";
  /**
   * Raw, one-request-per-call, no-retry transport (the engine's
   * ShopifyQueryClient shape), already carrying the key and going through
   * the outbound guard.
   */
  shopifyTransport: ShopifyRawTransport;
  /** The same transport with pacing, retries and budget; for simple reads. */
  shopify: ShopifyGraphQLClient;
}

/**
 * What the file-server Test and the quick-agent file tool get: list, read
 * and (on a read-write connection) write, every path confined under the
 * connection's base folder. The session behind it is opened on the first
 * operation and closed by the caller.
 */
export interface FileServerReadContext extends DataSourceReadContextBase {
  kind: FileServerKind;
  files: FileServerOperations;
}

/**
 * Kinds whose transport is not built yet. The registry refuses to open one
 * (code data_source_kind_unsupported) so no adapter ever receives it; the
 * shape exists so the union is complete and exhaustive switches stay honest.
 */
export interface PendingReadContext extends DataSourceReadContextBase {
  kind: "woocommerce" | "fiken";
}

/** Everything an adapter gets for one lookup, by kind. */
export type DataSourceReadContext = ShopifyReadContext | FileServerReadContext | PendingReadContext;

/**
 * The credential as stored in the company secret, decoded. Only
 * dataConnectionService.resolveCredential produces one (through
 * credential-codec.ts), and only the kind's own transport consumes one. Same
 * shapes as the validated inputs, so nothing is lost between save and use.
 */
export type DataSourceCredential = DataConnectionCredentialInput;

/** A lazily resolved credential: resolved once, on the first request, never before. */
export type CredentialLoader = () => Promise<DataSourceCredential>;

/** What every "sales" adapter answers with, whatever the source. */
export interface SalesAdapter {
  sales(request: SalesRequest): Promise<DataLookupOutcome<SalesResult>>;
  catalog(options?: { includeUnitsSold?: boolean }): Promise<DataLookupOutcome<CatalogResult>>;
}

/** The outcome of "Test" for any kind. */
export interface DataSourceCheckOutcome {
  /** The source answered and could be read. */
  ok: boolean;
  canActivate: boolean;
  problems: string[];
  notes: string[];
  observed: DataConnectionObservedSummary | null;
  /** Upstream traffic the check caused, for the audit row. */
  stats: DataSourceReadStats;
}
