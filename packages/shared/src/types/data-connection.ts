import type {
  DataConnectionAccessLevel,
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
  checkedAt: string | null;
};

export type DataConnectionSummary = {
  id: string;
  companyId: string;
  kind: DataConnectionKind;
  name: string;
  shopDomain: string;
  apiVersion: string;
  credentialKind: DataConnectionCredentialKind;
  credentialHint: string;
  access: DataConnectionAccessLevel;
  status: DataConnectionStatus;
  dailyLookupCap: number;
  observed: DataConnectionObservedSummary | null;
  /** Datasets this company currently answers from this connection. */
  datasets: DataDataset[];
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The answer to "Test": what Shopify says, and whether it may be switched on. */
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
