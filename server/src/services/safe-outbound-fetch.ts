import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isNonPublicAddress, isPrivateIP } from "@paperclipai/adapter-utils/public-address";
import { FIKEN_API_HOST, normalizeStoreUrlInput } from "@paperclipai/shared";

/**
 * DUR-4013: `isPrivateIP` and `isNonPublicAddress` moved to
 * packages/adapter-utils/src/public-address.ts so the browser egress proxy
 * can share the exact same address rule without depending on the server
 * package. Re-exported here by reference (not redefined) so every existing
 * caller of this module keeps working unchanged.
 */
export { isNonPublicAddress, isPrivateIP };

/**
 * Outbound HTTP calls the server makes on someone else's behalf.
 *
 * Two users:
 *
 *  1. Plugin HTTP fetch (plugin-host-services.ts). `isPrivateIP`,
 *     `validateAndResolveFetchUrl` and `executePinnedHttpRequest` were moved
 *     here unchanged from that file (DUR-3972 S1) and are re-used there, so a
 *     plugin's fetch behaves exactly as before.
 *
 *  2. Business-data connections (DUR-3972, DUR-3997). `createSafeOutboundFetch`
 *     adds a per-source-kind host allow-list on top: https only, and for
 *     Shopify *.myshopify.com only, for Fiken api.fiken.no only, for
 *     WooCommerce the one store host saved on the connection; every resolved
 *     address must be public (a stricter list than the plugin one -- it also
 *     refuses carrier-grade NAT, which is where a tailnet lives); no
 *     redirects are followed; each request has a 10 s limit and a response
 *     size cap.
 *
 * Every connection is pinned to the address that was checked, so a DNS answer
 * that changes between the check and the connect (DNS rebinding) cannot move
 * the request somewhere private.
 */

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Only these protocols are allowed for plugin HTTP requests. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** The plugin fetch body cap, unchanged. */
export const PLUGIN_MAX_RESPONSE_BODY_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Validate a URL for plugin fetch: protocol whitelist + private IP blocking.
 *
 * SSRF Prevention Strategy:
 * 1. Parse and validate the URL syntax
 * 2. Enforce protocol whitelist (http/https only)
 * 3. Resolve the hostname to IP(s) via DNS
 * 4. Validate that ALL resolved IPs are non-private
 * 5. Pin the first safe IP into the URL so fetch() does not re-resolve DNS
 *
 * This prevents DNS rebinding attacks where an attacker controls DNS to
 * resolve to a safe IP during validation, then to a private IP when fetch() runs.
 *
 * @returns Request-routing metadata used to connect directly to the resolved IP
 *          while preserving the original hostname for HTTP Host and TLS SNI.
 */
export interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

export type DnsLookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface ValidateFetchUrlOptions {
  /** DNS resolver; tests inject one. Defaults to node:dns lookup({ all: true }). */
  lookup?: DnsLookupAll;
  /** Address rule. Defaults to isPrivateIP (the plugin rule). */
  isBlockedAddress?: (ip: string) => boolean;
  /**
   * Plugin behaviour (default false): keep the public addresses of a host that
   * resolves to both public and private ones. true: refuse such a host.
   */
  requireAllPublic?: boolean;
}

const defaultLookup: DnsLookupAll = (hostname) => dnsLookup(hostname, { all: true });

export async function validateAndResolveFetchUrl(
  urlString: string,
  options: ValidateFetchUrlOptions = {},
): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`,
    );
  }

  const isBlocked = options.isBlockedAddress ?? isPrivateIP;
  const lookup = options.lookup ?? defaultLookup;

  // Resolve the hostname to an IP and check for private ranges.
  // We pin the resolved IP into the URL to eliminate the TOCTOU window
  // between DNS resolution here and the second resolution fetch() would do.
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  // when DNS is misconfigured or unresponsive.
  const dnsPromise = lookup(originalHostname);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${originalHostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    // Filter to only non-private IPs instead of rejecting the entire request
    // when some IPs are private. This handles multi-homed hosts that resolve
    // to both private and public addresses.
    const safeResults = results.filter((entry) => !isBlocked(entry.address));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }
    if (options.requireAllPublic && safeResults.length !== results.length) {
      throw new Error(
        `All resolved IPs for ${originalHostname} must be public; some are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: parsed.protocol === "https:" && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls: parsed.protocol === "https:",
    };
  } catch (err) {
    // Re-throw our own errors; wrap DNS failures
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildPinnedRequestOptions(
  target: ValidatedFetchTarget,
  init?: RequestInit,
): { options: HttpRequestOptions & { servername?: string }; body: string | undefined } {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  const body = init?.body === undefined || init?.body === null
    ? undefined
    : typeof init.body === "string"
      ? init.body
      : String(init.body);

  headers.set("Host", target.hostHeader);
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  const pathname = `${target.parsedUrl.pathname}${target.parsedUrl.search}`;
  const auth = target.parsedUrl.username || target.parsedUrl.password
    ? `${decodeURIComponent(target.parsedUrl.username)}:${decodeURIComponent(target.parsedUrl.password)}`
    : undefined;

  return {
    options: {
      protocol: target.parsedUrl.protocol,
      host: target.resolvedAddress,
      port: target.parsedUrl.port
        ? Number(target.parsedUrl.port)
        : target.useTls
          ? 443
          : 80,
      path: pathname,
      method,
      headers: Object.fromEntries(headers.entries()),
      auth,
      servername: target.tlsServername,
    },
    body,
  };
}

export interface PinnedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The body decoded as UTF-8 text. Damages binary content such as pictures. */
  body: string;
  /** The body exactly as received. Use this for anything that is not text. */
  bodyBytes: Buffer;
}

/**
 * Test-only seam: where the pinned connection is actually opened. Production
 * code never passes it. Tests use it to send a request that has passed every
 * check (host allow-list, DNS, address rule) to a local fake server over plain
 * HTTP, so the whole guard is exercised without reaching the internet.
 */
export type TestOnlyDialOverride = { host: string; port: number };

export async function executePinnedHttpRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal,
  limits: { maxResponseBytes?: number; testOnlyDial?: TestOnlyDialOverride } = {},
): Promise<PinnedHttpResponse> {
  const { options, body } = buildPinnedRequestOptions(target, init);
  const useTls = limits.testOnlyDial ? false : target.useTls;
  if (limits.testOnlyDial) {
    options.protocol = "http:";
    options.host = limits.testOnlyDial.host;
    options.port = limits.testOnlyDial.port;
    delete options.servername;
  }

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const requestFn = useTls ? httpsRequest : httpRequest;
    const req = requestFn({ ...options, signal }, resolve);

    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

  const MAX_RESPONSE_BODY_BYTES = limits.maxResponseBytes ?? PLUGIN_MAX_RESPONSE_BODY_BYTES;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        chunks.length = 0;
        response.destroy(new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buf);
    });
    response.on("end", resolve);
    response.on("error", reject);
  });

  const bodyBytes = Buffer.concat(chunks);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  return {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
    headers,
    body: bodyBytes.toString("utf8"),
    bodyBytes,
  };
}

// ---------------------------------------------------------------------------
// Business-data sources (DUR-3972)
// ---------------------------------------------------------------------------

/**
 * Which hosts one connection of one kind of data source may reach. The host
 * pattern is per kind -- and for WooCommerce per connection, since the store
 * lives on the operator's own domain. Everything else (https only, port 443
 * only, public addresses only, no redirects, size and time caps) is the same
 * for every kind and enforced in createSafeOutboundFetch below.
 */
export interface OutboundHostPolicy {
  /** Shown in refusals and logs; e.g. "shopify". */
  sourceKind: string;
  protocols: ReadonlyArray<"https:">;
  /** Matched against the lower-cased hostname. */
  hostPattern: RegExp;
  /** Per request, including DNS. */
  timeoutMs: number;
  maxResponseBytes: number;
  /**
   * How many redirects to follow, and only to the SAME host over https (each
   * hop is checked again from the top: host rule, DNS, address rule). A
   * redirect to any other host is refused. Absent or 0: every 3xx is refused,
   * which is what the business-data sources rely on.
   */
  maxSameHostRedirects?: number;
}

const DATA_SOURCE_REQUEST_TIMEOUT_MS = 10_000;
const DATA_SOURCE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export const SHOPIFY_OUTBOUND_POLICY: OutboundHostPolicy = {
  sourceKind: "shopify",
  protocols: ["https:"],
  hostPattern: /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
  timeoutMs: DATA_SOURCE_REQUEST_TIMEOUT_MS,
  maxResponseBytes: DATA_SOURCE_MAX_RESPONSE_BYTES,
};

/** Fiken has exactly one API host. Nothing an operator types can change it. */
export const FIKEN_OUTBOUND_POLICY: OutboundHostPolicy = {
  sourceKind: "fiken",
  protocols: ["https:"],
  hostPattern: new RegExp(`^${FIKEN_API_HOST.replace(/\./g, "\\.")}$`),
  timeoutMs: DATA_SOURCE_REQUEST_TIMEOUT_MS,
  maxResponseBytes: DATA_SOURCE_MAX_RESPONSE_BYTES,
};

/**
 * Quick agents' web_search: Brave's one API host, nothing else. The key goes
 * in a header, so it never appears in a URL, a log line or an error.
 */
export const BRAVE_SEARCH_OUTBOUND_POLICY: OutboundHostPolicy = {
  sourceKind: "Brave Search",
  protocols: ["https:"],
  hostPattern: /^api\.search\.brave\.com$/,
  timeoutMs: 8_000,
  maxResponseBytes: 1024 * 1024,
};

/**
 * Quick agents' read_web_page: any ordinary public web host. The name must be
 * a dotted DNS name with an alphabetic top-level label -- so never an IP
 * literal, never "localhost" -- and not one of the private-network suffixes
 * below. Every resolved address must still be public (checked per request,
 * like every policy here), so a public-looking name that points inside is
 * refused too. Redirects are followed only on the same host.
 */
export const PUBLIC_WEB_PAGE_OUTBOUND_POLICY: OutboundHostPolicy = {
  sourceKind: "web pages",
  protocols: ["https:"],
  hostPattern:
    /^(?=.{4,253}$)(?!.*\.(?:local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid|example)$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
  timeoutMs: 10_000,
  maxResponseBytes: 3 * 1024 * 1024,
  maxSameHostRedirects: 3,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A WooCommerce store runs on the operator's own domain, so its policy is
 * built per connection from the store URL saved on it: that one host, exactly,
 * and nothing else. The URL must be https, without a user name, password or a
 * port other than 443, and must name a public-looking DNS name (not an IP
 * address, not localhost, not a .local/.internal/.lan name). Whether the name
 * really resolves to a public address is checked again on every request, so a
 * store name that later points at something private is refused at that
 * moment too.
 */
export function createWooCommerceOutboundPolicy(storeUrl: string): OutboundHostPolicy {
  const normalized = normalizeStoreUrlInput(storeUrl);
  if (!normalized.ok) {
    throw new SafeOutboundFetchError("host_not_allowed", normalized.message);
  }
  return {
    sourceKind: "woocommerce",
    protocols: ["https:"],
    hostPattern: new RegExp(`^${escapeRegExp(normalized.host)}$`),
    timeoutMs: DATA_SOURCE_REQUEST_TIMEOUT_MS,
    maxResponseBytes: DATA_SOURCE_MAX_RESPONSE_BYTES,
  };
}

export type SafeOutboundRefusalCode =
  | "invalid_url"
  | "protocol_not_allowed"
  | "host_not_allowed"
  | "credentials_in_url"
  | "port_not_allowed"
  | "address_not_public"
  | "dns_failed"
  | "redirect_refused"
  | "response_too_large"
  | "timeout"
  | "network_error";

/**
 * Thrown for every refusal and network failure. The message never contains a
 * request header, a request body or a response body -- only the host and a
 * fixed sentence -- so a credential in a header can never reach a log through
 * this error.
 */
export class SafeOutboundFetchError extends Error {
  readonly code: SafeOutboundRefusalCode;
  constructor(code: SafeOutboundRefusalCode, message: string) {
    super(message);
    this.name = "SafeOutboundFetchError";
    this.code = code;
  }
}

export interface SafeOutboundFetchDeps {
  lookup?: DnsLookupAll;
  /** See TestOnlyDialOverride. */
  testOnlyDial?: TestOnlyDialOverride;
}

/**
 * The shape of fetch that data-source clients take, so tests can swap it.
 * Same type as the global fetch, so it can be handed to anything that takes
 * `fetchImpl: typeof fetch`.
 */
export type OutboundFetch = typeof fetch;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(ugyldig adresse)";
  }
}

/**
 * A fetch that can only reach the hosts `policy` allows. Returns a standard
 * Response. Any 3xx answer is refused rather than followed: a redirect is the
 * classic way to bounce an allowed request to a host that is not allowed.
 */
export function createSafeOutboundFetch(
  policy: OutboundHostPolicy,
  deps: SafeOutboundFetchDeps = {},
): OutboundFetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit, redirectsFollowed = 0): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      // A Request object carries its own headers/body/redirect mode; refuse it
      // rather than half-honour it.
      throw new SafeOutboundFetchError("invalid_url", "The address is not valid.");
    }
    const url = input.toString();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SafeOutboundFetchError("invalid_url", "The address is not valid.");
    }
    const host = parsed.hostname.toLowerCase();
    if (!(policy.protocols as ReadonlyArray<string>).includes(parsed.protocol)) {
      throw new SafeOutboundFetchError(
        "protocol_not_allowed",
        `Only https is allowed for ${policy.sourceKind} (got ${parsed.protocol.replace(/:$/, "")}).`,
      );
    }
    if (parsed.username || parsed.password) {
      throw new SafeOutboundFetchError("credentials_in_url", "The address cannot contain a username or password.");
    }
    if (parsed.port && parsed.port !== "443") {
      throw new SafeOutboundFetchError("port_not_allowed", `Only the default port is allowed for ${policy.sourceKind}.`);
    }
    if (!policy.hostPattern.test(host)) {
      throw new SafeOutboundFetchError(
        "host_not_allowed",
        `${host} is not an allowed address for ${policy.sourceKind}.`,
      );
    }

    // The policy's own limit always applies; a caller's signal (a per-lookup
    // deadline) can only make it shorter.
    const signal = init?.signal
      ? AbortSignal.any([AbortSignal.timeout(policy.timeoutMs), init.signal])
      : AbortSignal.timeout(policy.timeoutMs);
    let target: ValidatedFetchTarget;
    try {
      target = await validateAndResolveFetchUrl(parsed.toString(), {
        lookup: deps.lookup,
        isBlockedAddress: isNonPublicAddress,
        requireAllPublic: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("All resolved IPs")) {
        throw new SafeOutboundFetchError("address_not_public", `${host} points to an internal address and will not be contacted.`);
      }
      throw new SafeOutboundFetchError("dns_failed", `Could not find the address ${host}.`);
    }

    let response: PinnedHttpResponse;
    try {
      response = await executePinnedHttpRequest(target, { method: init?.method, headers: init?.headers, body: init?.body }, signal, {
        maxResponseBytes: policy.maxResponseBytes,
        testOnlyDial: deps.testOnlyDial,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("Response body exceeded")) {
        throw new SafeOutboundFetchError("response_too_large", `The response from ${host} was too large.`);
      }
      if (signal.aborted) {
        throw new SafeOutboundFetchError("timeout", `${host} did not respond within ${Math.round(policy.timeoutMs / 1000)} seconds.`);
      }
      throw new SafeOutboundFetchError("network_error", `Could not reach ${hostOf(url)}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      const maxRedirects = policy.maxSameHostRedirects ?? 0;
      if (location && redirectsFollowed < maxRedirects) {
        let next: URL | null = null;
        try {
          next = new URL(location, parsed);
        } catch {
          next = null;
        }
        // Same host, https, no credentials: follow it through every check
        // again. Anything else is the classic bounce to somewhere not allowed.
        if (next && next.protocol === "https:" && next.hostname.toLowerCase() === host) {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method === "GET" || method === "HEAD") {
            return guarded(next.toString(), { ...init, method }, redirectsFollowed + 1);
          }
        }
      }
      throw new SafeOutboundFetchError(
        "redirect_refused",
        `${host} tried to redirect the request to another address. That is not allowed.`,
      );
    }

    const bodyAllowed = response.status !== 204 && response.status !== 205 && response.status >= 200;
    return new Response(bodyAllowed ? new Uint8Array(response.bodyBytes) : null, {
      status: response.status < 200 || response.status > 599 ? 502 : response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => guarded(input, init)) as OutboundFetch;
}
