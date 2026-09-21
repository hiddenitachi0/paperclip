/**
 * DUR-3972: THE interface between the business-data foundation (slice S1) and
 * the code that actually reads a source (S3 Shopify engine, S4 query service
 * and quick-agent tool, and later the dashboard source).
 *
 * If you are building S3 or S4, this is the one file to read.
 *
 * WHO OWNS WHAT
 * -------------
 *   S1 (this slice) owns:
 *     - the tables: data_connections, data_dataset_sources, data_read_events
 *     - the key: stored as a company secret, bound to the connection, locked so
 *       it can be bound to nothing else, read in exactly one place
 *       (dataConnectionService.resolveCredential)
 *     - the outbound-call guard (safe-outbound-fetch.ts): https only,
 *       *.myshopify.com only, public addresses only, no redirects, 10 s per
 *       request, 5 MB response cap
 *     - the query-only Shopify GraphQL client (shopify-client.ts): refuses
 *       mutations, paces itself on Shopify's cost budget, retries THROTTLED at
 *       most twice, enforces a request and time budget, scrubs the key out of
 *       every error
 *     - the audit writer (data-read-audit.ts): one row per lookup, refusals
 *       included, facts capped at 8 KB and scrubbed
 *
 *   S3 (shopify-adapter.ts) does the counting. It takes a one-request-per-call
 *   transport and does its own pacing, THROTTLED retries and budget on top.
 *   S1 hands it exactly that: `DataSourceReadContext.shopifyTransport` is
 *   structurally S3's `ShopifyQueryClient` ({ shopDomain, request(document,
 *   variables, { signal }) }), already carrying the key (and, for
 *   client-credentials connections, a short-lived token it refreshes itself)
 *   and already going through the outbound guard. The engine never sees the
 *   key, never builds a URL, and never calls fetch itself.
 *
 *   S4 calls, in this order:
 *     0. the instance switch: instanceSettings.getExperimental().enableBusinessData
 *        -- off means "not available", say so plainly. (Steps 1 and 3 check it
 *        again themselves: getActiveDatasetSource returns null and
 *        openReadContext refuses with code business_data_disabled, so an
 *        operator switching it off stops every read even if a caller forgets.)
 *     1. dataConnectionService.getActiveDatasetSource(companyId, "sales")
 *        -- company from the CALLER's context only, never from input;
 *        null means "not connected": say so plainly
 *     2. its limits, counted with countDataReadEvents (data-read-audit.ts)
 *     3. const { read, knownSecrets } =
 *          await dataConnectionService.openReadContext(companyId, connectionId,
 *            { actorType: "agent", actorId: agentId })
 *     4. createShopifySalesAdapter({ client: read.shopifyTransport, ... })
 *          .sales(request)
 *     5. recordDataReadEvent(db, { ..., scrubValues: knownSecrets() })
 *        -- also for every refusal
 *
 * WHAT IS NOT HERE ON PURPOSE
 * ---------------------------
 *   - No write access of any kind. `access` is 'read' by database constraint.
 *   - No route for a full agent (run token) to read data. When one is built it
 *     must count runs by the signed claims.run_id only, never by the
 *     x-paperclip-run-id header.
 */
import type { DataConnectionKind, DataReadChannel } from "@paperclipai/shared";
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
  shopDomain: string;
  apiVersion: string;
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

/** Everything an adapter gets for one lookup. */
export interface DataSourceReadContext {
  connection: DataSourceConnectionInfo;
  /**
   * Raw, one-request-per-call, no-retry transport (S3's ShopifyQueryClient
   * shape), already carrying the key and going through the outbound guard.
   * This is what the S3 sales engine takes.
   */
  shopifyTransport: ShopifyRawTransport;
  /** The same transport with S1's own pacing, retries and budget; for simple reads. */
  shopify: ShopifyGraphQLClient;
  /** Injected clock, so month boundaries are testable. */
  now: () => Date;
}

/**
 * The credential as stored in the company secret, decoded. Only
 * dataConnectionService.resolveCredential produces one, and only the Shopify
 * client's token provider consumes one.
 */
export type DataSourceCredential =
  | { kind: "admin_access_token"; accessToken: string }
  | { kind: "client_credentials"; clientId: string; clientSecret: string };
