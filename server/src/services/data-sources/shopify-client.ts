import { createHash } from "node:crypto";
import { redactKnownLeakedSecretPatterns, redactKnownSecretValues } from "../../redaction.js";
import {
  createSafeOutboundFetch,
  SafeOutboundFetchError,
  SHOPIFY_OUTBOUND_POLICY,
  type OutboundFetch,
} from "../safe-outbound-fetch.js";
import type { DataSourceCallBudget } from "./connection-kind.js";
import { DataSourceUpstreamError } from "./contract.js";

/**
 * DUR-3972 S1: a query-only Shopify Admin GraphQL client.
 *
 *  - It refuses any document containing `mutation` or `subscription`, before
 *    anything is sent. Together with a key that has no write_* scope (the Test
 *    check refuses to activate one that does), Paperclip cannot change a shop.
 *  - The key travels only in the X-Shopify-Access-Token header, never in a URL.
 *  - It paces itself from `extensions.cost.throttleStatus`, and retries a
 *    THROTTLED answer at most twice.
 *  - Every lookup runs under a request budget and a deadline. Running out is an
 *    error, never a partial result.
 *  - Every error text is cleaned twice: known key shapes (shpat_, shpss_, ...)
 *    and the exact key values in use are removed before the text leaves here.
 */

export type ShopifyClientErrorCode =
  | "mutation_refused"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "throttled"
  | "budget_exhausted"
  | "deadline_exceeded"
  | "http_error"
  | "graphql_error"
  | "bad_response"
  | "network";

export class ShopifyClientError extends DataSourceUpstreamError {
  declare readonly code: ShopifyClientErrorCode;
  /** The HTTP status Shopify answered with, when there was one. */
  readonly httpStatus: number | null;
  /** From a 429's Retry-After header, in ms. */
  readonly retryAfterMs: number | null;
  constructor(code: ShopifyClientErrorCode, message: string, httpStatus: number | null = null, retryAfterMs: number | null = null) {
    super(code, message);
    this.name = "ShopifyClientError";
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A Shopify GraphQL response body, as Shopify sends it. */
export interface ShopifyRawResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message?: string; extensions?: { code?: string; [key: string]: unknown } | null; [key: string]: unknown }> | null;
  extensions?: {
    cost?: {
      requestedQueryCost?: number | null;
      actualQueryCost?: number | null;
      throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } | null;
    } | null;
    [key: string]: unknown;
  } | null;
}

/**
 * ONE guarded HTTP request per call, no retry, no pacing -- the raw seam.
 *
 * This is structurally the `ShopifyQueryClient` interface the S3 sales engine
 * (shopify-query-client.ts) takes: `{ shopDomain, request(document,
 * variables, { signal }) }`, resolving with the parsed body of an HTTP 200
 * (GraphQL `errors` such as THROTTLED included) and rejecting for anything
 * else. The engine does its own pacing and budget on top; the settings Test
 * uses `createShopifyClient` below, which adds them here.
 */
export interface ShopifyRawTransport {
  readonly shopDomain: string;
  request(
    document: string,
    variables: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ShopifyRawResponse>;
}

export interface ShopifyTransportOptions {
  shopDomain: string;
  apiVersion: string;
  /** Called for every request; may refresh a short-lived token. Never logged. */
  getAccessToken: () => Promise<string>;
  /** Defaults to the guarded fetch for Shopify (safe-outbound-fetch.ts). */
  fetchImpl?: OutboundFetch;
  /** Extra exact values to scrub from errors (the client secret, in client-credentials mode). */
  extraSecrets?: () => string[];
}

const WRITE_DOCUMENT_RE = /\b(mutation|subscription)\b/i;

export function isWriteLikeShopifyDocument(document: string): boolean {
  return WRITE_DOCUMENT_RE.test(document);
}

export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  return redactKnownSecretValues(redactKnownLeakedSecretPatterns(text), secrets);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function createShopifyRawTransport(options: ShopifyTransportOptions): ShopifyRawTransport {
  const fetchImpl = options.fetchImpl ?? createSafeOutboundFetch(SHOPIFY_OUTBOUND_POLICY);
  const endpoint = `https://${options.shopDomain}/admin/api/${options.apiVersion}/graphql.json`;
  const knownSecrets = new Set<string>();
  const scrub = (text: string) => scrubSecrets(text, [...knownSecrets, ...(options.extraSecrets?.() ?? [])]);

  return {
    shopDomain: options.shopDomain,
    async request(document, variables, requestOptions) {
      if (isWriteLikeShopifyDocument(document)) {
        throw new ShopifyClientError(
          "mutation_refused",
          "Paperclip only reads from Shopify. Requests that could change anything are never sent.",
        );
      }
      const token = await options.getAccessToken();
      knownSecrets.add(token);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify(
            variables && Object.keys(variables).length > 0 ? { query: document, variables } : { query: document },
          ),
          signal: requestOptions?.signal,
        });
      } catch (error) {
        throw new ShopifyClientError(
          "network",
          error instanceof SafeOutboundFetchError ? scrub(error.message) : "Could not reach Shopify. Try again in a moment.",
        );
      }

      if (response.status === 401) {
        throw new ShopifyClientError(
          "unauthorized",
          "Shopify did not accept the key. Check that you pasted the right key for this shop, and that the app is still installed.",
          401,
        );
      }
      if (response.status === 403) {
        throw new ShopifyClientError(
          "forbidden",
          "Shopify says the key is not allowed to do this. Check that the app has the read_orders, read_all_orders and read_products permissions.",
          403,
        );
      }
      if (response.status === 404) {
        throw new ShopifyClientError("not_found", "Shopify could not find the shop or the API version. Check the shop address.", 404);
      }
      if (response.status === 429) {
        const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
        throw new ShopifyClientError(
          "throttled",
          "Shopify is too busy right now. Try again in a moment.",
          429,
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : null,
        );
      }
      if (response.status !== 200) {
        throw new ShopifyClientError(
          "http_error",
          `Shopify answered with an error (${response.status}). Try again in a moment.`,
          response.status,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ShopifyClientError("bad_response", "Shopify did not answer as expected.", 200);
      }
      if (!asRecord(body)) {
        throw new ShopifyClientError("bad_response", "Shopify did not answer as expected.", 200);
      }
      const record = body as ShopifyRawResponse;
      // Error messages can echo what was sent; clean them before anyone reads them.
      if (Array.isArray(record.errors)) {
        record.errors = record.errors.map((entry) => {
          const item = asRecord(entry) ?? {};
          return { ...item, message: typeof item.message === "string" ? scrub(item.message) : item.message } as NonNullable<ShopifyRawResponse["errors"]>[number];
        });
      }
      return record;
    },
  };
}

export interface ShopifyClientStats {
  requests: number;
  costPoints: number;
  throttledRetries: number;
}

export interface ShopifyGraphQLClient {
  /** Runs one read-only GraphQL document. Throws ShopifyClientError on anything but complete data. */
  query<TData>(document: string, variables?: Record<string, unknown>): Promise<TData>;
  stats(): ShopifyClientStats;
}

type ThrottleStatus = { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };

export interface ShopifyClientOptions extends ShopifyTransportOptions {
  budget?: DataSourceCallBudget;
  maxThrottleRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Use an existing transport instead of building one from the options above. */
  transport?: ShopifyRawTransport;
}

const DEFAULT_BUDGET: DataSourceCallBudget = { maxRequests: 60, deadlineMs: 25_000 };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readThrottle(extensions: unknown): { status: ThrottleStatus | null; requested: number | null; actual: number | null } {
  const cost = asRecord(asRecord(extensions)?.cost);
  const throttle = asRecord(cost?.throttleStatus);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const status =
    throttle && num(throttle.currentlyAvailable) !== null && num(throttle.restoreRate) !== null
      ? {
          maximumAvailable: num(throttle.maximumAvailable) ?? 0,
          currentlyAvailable: num(throttle.currentlyAvailable)!,
          restoreRate: num(throttle.restoreRate)!,
        }
      : null;
  return { status, requested: num(cost?.requestedQueryCost), actual: num(cost?.actualQueryCost) };
}

/**
 * The paced client: the raw transport plus Shopify cost pacing, at most two
 * THROTTLED retries, a request budget and a deadline, and "complete or
 * nothing" (data that comes back alongside an error is dropped).
 */
export function createShopifyClient(options: ShopifyClientOptions): ShopifyGraphQLClient {
  const transport = options.transport ?? createShopifyRawTransport(options);
  const budget = options.budget ?? DEFAULT_BUDGET;
  const maxThrottleRetries = options.maxThrottleRetries ?? 2;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadlineAt = now() + budget.deadlineMs;
  const stats: ShopifyClientStats = { requests: 0, costPoints: 0, throttledRetries: 0 };
  let lastThrottle: ThrottleStatus | null = null;
  let lastRequestedCost: number | null = null;

  async function waitFor(ms: number) {
    if (ms <= 0) return;
    if (now() + ms > deadlineAt) {
      throw new ShopifyClientError(
        "deadline_exceeded",
        "Shopify asked us to wait longer than the time limit for one lookup. Try again in a moment.",
      );
    }
    await sleep(ms);
  }

  /** Wait until the last known budget has room for a query like the last one. */
  async function pace() {
    if (!lastThrottle || lastRequestedCost === null) return;
    const shortfall = lastRequestedCost - lastThrottle.currentlyAvailable;
    if (shortfall <= 0 || lastThrottle.restoreRate <= 0) return;
    await waitFor(Math.ceil((shortfall / lastThrottle.restoreRate) * 1000));
  }

  async function query<TData>(document: string, variables?: Record<string, unknown>): Promise<TData> {
    if (isWriteLikeShopifyDocument(document)) {
      throw new ShopifyClientError(
        "mutation_refused",
        "Paperclip leser bare fra Shopify. Forespørsler som kan endre noe blir aldri sendt.",
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      await pace();
      if (stats.requests >= budget.maxRequests) {
        throw new ShopifyClientError(
          "budget_exhausted",
          `The lookup needed more than ${budget.maxRequests} requests to Shopify and was stopped, so it does not give a half answer.`,
        );
      }
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        throw new ShopifyClientError(
          "deadline_exceeded",
          `The lookup took more than ${Math.round(budget.deadlineMs / 1000)} seconds and was stopped, so it does not give a half answer.`,
        );
      }
      stats.requests += 1;
      let body: ShopifyRawResponse;
      try {
        body = await transport.request(document, variables ?? {}, { signal: AbortSignal.timeout(Math.max(1, remaining)) });
      } catch (error) {
        if (error instanceof ShopifyClientError && error.code === "throttled" && attempt < maxThrottleRetries) {
          stats.throttledRetries += 1;
          await waitFor(error.retryAfterMs ?? 1000);
          continue;
        }
        throw error;
      }

      const throttle = readThrottle(body.extensions);
      if (throttle.status) lastThrottle = throttle.status;
      if (throttle.requested !== null) lastRequestedCost = throttle.requested;
      stats.costPoints += Math.round(throttle.actual ?? throttle.requested ?? 0);

      const errors = Array.isArray(body.errors) ? body.errors : [];
      if (errors.length > 0) {
        const throttled = errors.some((entry) => asRecord(asRecord(entry)?.extensions)?.code === "THROTTLED");
        if (throttled) {
          if (attempt >= maxThrottleRetries) {
            throw new ShopifyClientError("throttled", "Shopify is too busy right now. Try again in a moment.");
          }
          stats.throttledRetries += 1;
          // Paced on the next loop from the throttle status just read; if that
          // said nothing useful, wait one second.
          if (!throttle.status) await waitFor(1000);
          continue;
        }
        const messages = errors
          .map((entry) => {
            const record = asRecord(entry);
            const code = asRecord(record?.extensions)?.code;
            const message = typeof record?.message === "string" ? record.message : "unknown error";
            return typeof code === "string" ? `${code}: ${message}` : message;
          })
          .slice(0, 5)
          .join("; ");
        // Complete or nothing: data that came back alongside an error is dropped.
        throw new ShopifyClientError("graphql_error", `Shopify rejected the query: ${messages}`.slice(0, 1000));
      }

      if (!asRecord(body.data)) {
        throw new ShopifyClientError("bad_response", "Shopify answered without data.");
      }
      return body.data as TData;
    }
  }

  return {
    query,
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// Client-credentials tokens (Shopify Dev Dashboard apps)
// ---------------------------------------------------------------------------

/**
 * A short-lived access token from Shopify's client-credentials grant. Kept in
 * this process's memory only -- never written to the database, never logged --
 * and refreshed before it expires.
 */
type CachedToken = { accessToken: string; expiresAt: number; obtainedAt: number };

const tokenCache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

/** For tests. */
export function resetShopifyTokenCache() {
  tokenCache.clear();
  inFlight.clear();
}

/** For removal and rotation: drop every cached token for this connection. */
export function forgetShopifyTokensForConnection(connectionId: string) {
  for (const key of [...tokenCache.keys()]) {
    if (key.startsWith(`${connectionId}:`)) tokenCache.delete(key);
  }
}

/** Minimum lifetime left before a cached token is replaced. */
function refreshMarginMs(lifetimeMs: number): number {
  return Math.min(5 * 60_000, Math.max(0, Math.floor(lifetimeMs / 2)));
}

export async function getClientCredentialsAccessToken(input: {
  connectionId: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: OutboundFetch;
  now?: () => number;
}): Promise<string> {
  const now = input.now ?? Date.now;
  // Keyed by a hash of the credential too, so a rotated key never reuses a
  // token minted with the old one.
  const fingerprint = createHash("sha256").update(`${input.clientId}\0${input.clientSecret}`).digest("hex").slice(0, 16);
  const key = `${input.connectionId}:${fingerprint}`;
  const cached = tokenCache.get(key);
  if (cached && now() < cached.expiresAt - refreshMarginMs(cached.expiresAt - cached.obtainedAt)) {
    return cached.accessToken;
  }
  const pending = inFlight.get(key);
  if (pending) return (await pending).accessToken;

  const fetchImpl = input.fetchImpl ?? createSafeOutboundFetch(SHOPIFY_OUTBOUND_POLICY);
  const scrub = (text: string) => scrubSecrets(text, [input.clientSecret, input.clientId]);
  const exchange = (async (): Promise<CachedToken> => {
    let response: Response;
    try {
      response = await fetchImpl(`https://${input.shopDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          grant_type: "client_credentials",
        }),
      });
    } catch (error) {
      throw new ShopifyClientError(
        "network",
        error instanceof SafeOutboundFetchError ? scrub(error.message) : "Could not reach Shopify. Try again in a moment.",
      );
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new ShopifyClientError(
        "unauthorized",
        "Shopify did not accept the client ID and client secret. Check that both are from the app installed in this shop.",
      );
    }
    if (!response.ok) {
      throw new ShopifyClientError("http_error", `Shopify answered with an error (${response.status}) when we asked for access.`);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(await response.json());
    } catch {
      body = null;
    }
    const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
    const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    if (!accessToken) {
      throw new ShopifyClientError("bad_response", "Shopify did not return an access token.");
    }
    const obtainedAt = now();
    return { accessToken, obtainedAt, expiresAt: obtainedAt + expiresIn * 1000 };
  })();

  inFlight.set(key, exchange);
  try {
    const token = await exchange;
    forgetShopifyTokensForConnection(input.connectionId);
    tokenCache.set(key, token);
    return token.accessToken;
  } finally {
    inFlight.delete(key);
  }
}
