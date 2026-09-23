import type {
  DataConnectionAccessLevel,
  DataConnectionConfig,
  DataConnectionCredentialKind,
  DataConnectionKind,
  DataConnectionStatus,
  DataDataset,
  DataReadChannel,
  DataReadOutcome,
} from "../validators/data-connection.js";

/**
 * DUR-3972 slice S1: what the app shows about a business-data connection.
 *
 * There is no credential field anywhere in this file. The key reaches exactly
 * one place -- the server-side data-connections service -- and the shapes the
 * routes answer with simply have no room for it. `credentialHint` is the last
 * four characters only.
 */
/**
 * What "Test" saw on a file server: the base folder's contents, whether the
 * write check passed (null for a read-only connection, which never tries),
 * and for SFTP the server's host-key fingerprint, pinned from then on.
 */
export type FileServerObservedSummary = {
  protocol: "ftp" | "ftps" | "sftp";
  /** Files (not folders) directly in the base folder. */
  fileCount: number;
  directoryCount: number;
  /** True when a zero-byte write and delete succeeded; false when refused; null when not attempted (read-only). */
  writable: boolean | null;
  /** SHA-256 of the SSH host key, base64; SFTP only. */
  hostKeyFingerprint: string | null;
  /** The server's greeting or software name, if it said one. Never a credential. */
  serverSoftware: string | null;
};

export type DataConnectionObservedSummary = {
  shopName: string | null;
  shopDomain: string | null;
  ianaTimezone: string | null;
  currencyCode: string | null;
  grantedScopes: string[];
  earliestVisibleOrderAt: string | null;
  productTypeCoverage: {
    complete: boolean;
    productsScanned: number;
    productsWithoutType: number;
    types: Array<{ productType: string; products: number }>;
  } | null;
  /** File-server kinds only; null for every other kind. */
  fileServer: FileServerObservedSummary | null;
  checkedAt: string | null;
};

export type DataConnectionSummary = {
  id: string;
  companyId: string;
  kind: DataConnectionKind;
  /** Plain name of the kind, e.g. "Shopify". */
  kindLabel: string;
  /** False for a kind that is saved but cannot be read through yet ("kommer snart"). */
  supported: boolean;
  name: string;
  /**
   * Where the connection points, in words: the shop address, the store URL's
   * host, the Fiken company slug, or "host:/path" for files. Never a secret.
   */
  target: string;
  /** Shopify only; null for every other kind. */
  shopDomain: string | null;
  /** Shopify only; null for every other kind. */
  apiVersion: string | null;
  /** Per-kind non-secret settings (data_connections.config), tagged with the kind. */
  config: DataConnectionConfig;
  credentialKind: DataConnectionCredentialKind;
  credentialHint: string;
  access: DataConnectionAccessLevel;
  status: DataConnectionStatus;
  dailyLookupCap: number;
  observed: DataConnectionObservedSummary | null;
  /** Datasets this company currently answers from this connection. */
  datasets: DataDataset[];
  /** Datasets this kind of source can answer at all (what may be granted). */
  datasetsOffered: DataDataset[];
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The answer to "Test": what the source says, and whether it may be switched on. */
export type DataConnectionCheckResult = {
  ok: boolean;
  /** True only when every check passed and the key cannot write. */
  canActivate: boolean;
  /** Plain-language sentences, one per problem, for the settings screen. */
  problems: string[];
  /** Plain-language sentences worth showing even when the check passed. */
  notes: string[];
  observed: DataConnectionObservedSummary | null;
  status: DataConnectionStatus;
  checkedAt: string;
};

export type DataDatasetSourceSummary = {
  dataset: DataDataset;
  connectionId: string;
  grantedByUserId: string | null;
  grantedAt: string;
};

export type DataReadEventSummary = {
  id: string;
  connectionId: string | null;
  dataset: string;
  channel: DataReadChannel;
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  params: Record<string, unknown>;
  outcome: DataReadOutcome;
  refusalCode: string | null;
  upstreamRequests: number;
  durationMs: number | null;
  createdAt: string;
};

/**
 * DUR-3972 slice S2: the answer to "Prøveberegning". `card` is the same fixed
 * Norwegian answer card an agent would relay; `reconciliationNotes` are plain
 * sentences about differences Paperclip itself noticed (for example between
 * Shopify's sales record and its refunds), to explain before going live.
 */
export type DataTrialCalculationResult =
  | {
      ok: true;
      lookupId: string;
      card: string;
      reconciliationNotes: string[];
    }
  | {
      ok: false;
      lookupId: string | null;
      code: string;
      message: string;
    };
