import { redactKnownLeakedSecretPatterns, redactKnownSecretValues } from "../../redaction.js";

/**
 * DUR-3972 S3: the ONE seam between the Shopify sales engine
 * (shopify-adapter.ts) and the network.
 *
 * The engine never builds URLs, never sees the access token and never calls
 * `fetch` itself. It only hands a read-only GraphQL document plus variables to
 * a `ShopifyQueryClient` and gets the raw GraphQL response body back. Pacing,
 * THROTTLED retries and the request/time budget live in the adapter (they have
 * to be counted per lookup), so an implementation of this interface must do
 * exactly ONE HTTP request per `request()` call and must NOT retry.
 *
 * S1 (connection + locked key + safe outbound fetch) wires a real client by
 * either:
 *   - calling `createFetchShopifyQueryClient` below with its
 *     `safe-outbound-fetch` as `fetchImpl` and `resolveCredential` as
 *     `getAccessToken`, or
 *   - implementing `ShopifyQueryClient` on top of its own shopify-client.ts,
 *     keeping the same one-request-per-call, no-retry contract.
 */

export interface ShopifyGraphqlError {
  message?: string;
  extensions?: { code?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyCostExtension {
  requestedQueryCost?: number | null;
  actualQueryCost?: number | null;
  throttleStatus?: ShopifyThrottleStatus | null;
}

export interface ShopifyGraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: ShopifyGraphqlError[] | null;
  extensions?: { cost?: ShopifyCostExtension | null; [key: string]: unknown } | null;
}

export interface ShopifyQueryRequestOptions {
  /** Aborts the single HTTP request (the adapter passes its per-lookup deadline). */
  signal?: AbortSignal;
}

export interface ShopifyQueryClient {
  /** The shop this client talks to, e.g. `nordstrand.myshopify.com`. Used only for labels. */
  readonly shopDomain: string;
  /**
   * Send one read-only GraphQL document. Resolves with the parsed response body
   * (HTTP 200 bodies, including GraphQL `errors` such as THROTTLED). Rejects
   * with a `ShopifyTransportError` for anything else (network, non-200,
   * oversized or non-JSON body). Error messages must never contain the token.
   */
  request(
    document: string,
    variables: Record<string, unknown>,
    options?: ShopifyQueryRequestOptions,
  ): Promise<ShopifyGraphqlResponse>;
}

export class ShopifyTransportError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ShopifyTransportError";
    this.httpStatus = httpStatus;
  }
}

const WRITE_OPERATION_RE = /\b(mutation|subscription)\b/i;

/** True when the document could perform a write (or subscribe). The engine only ever reads. */
export function isWriteLikeGraphqlDocument(document: string): boolean {
  return WRITE_OPERATION_RE.test(document);
}

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION_RE = /^\d{4}-(01|04|07|10)$/;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface FetchShopifyQueryClientOptions {
  shopDomain: string;
  apiVersion: string;
  /** Returns the current access token. Called once per request; never logged. */
  getAccessToken: () => Promise<string>;
  /** S1 passes its safe outbound fetch here (host allow-list, no redirects, private-IP block). */
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Reference implementation of `ShopifyQueryClient` over an injected fetch.
 * Read-only by construction: any document containing `mutation` or
 * `subscription` is refused before the token is even read. The token travels
 * only in the `X-Shopify-Access-Token` header, and every error text is cleaned
 * twice (known token patterns, then the exact token value).
 */
export function createFetchShopifyQueryClient(options: FetchShopifyQueryClientOptions): ShopifyQueryClient {
  const shopDomain = options.shopDomain.trim().toLowerCase();
  if (!SHOP_DOMAIN_RE.test(shopDomain)) {
    throw new ShopifyTransportError("Shop address must look like <name>.myshopify.com");
  }
  if (!API_VERSION_RE.test(options.apiVersion)) {
    throw new ShopifyTransportError("Shopify API version must look like YYYY-01/04/07/10");
  }
  const endpoint = `https://${shopDomain}/admin/api/${options.apiVersion}/graphql.json`;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    shopDomain,
    async request(document, variables, requestOptions) {
      if (isWriteLikeGraphqlDocument(document)) {
        throw new ShopifyTransportError("Refused: only read-only Shopify queries are allowed");
      }
      const token = await options.getAccessToken();
      const clean = (text: string) =>
        redactKnownSecretValues(redactKnownLeakedSecretPatterns(text), token ? [token] : []);
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (requestOptions?.signal) signals.push(requestOptions.signal);
      let response: Response;
      try {
        response = await options.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-shopify-access-token": token,
          },
          body: JSON.stringify({ query: document, variables }),
          redirect: "error",
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        throw new ShopifyTransportError(clean(`Shopify request failed: ${describeError(error)}`));
      }
      const text = await readCapped(response, maxBytes).catch((error: unknown) => {
        throw new ShopifyTransportError(clean(`Shopify response unreadable: ${describeError(error)}`), response.status);
      });
      if (response.status !== 200) {
        throw new ShopifyTransportError(
          clean(`Shopify answered HTTP ${response.status}: ${text.slice(0, 300)}`),
          response.status,
        );
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
        return parsed as ShopifyGraphqlResponse;
      } catch (error) {
        throw new ShopifyTransportError(clean(`Shopify response was not JSON: ${describeError(error)}`), 200);
      }
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response larger than ${maxBytes} bytes`);
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
