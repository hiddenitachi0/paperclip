/**
 * DUR-4151/DUR-4161: the server's HTTP client for the internal Crawl4AI
 * worker (docker/docker-compose.crawl4ai.yml). Holds the
 * `PAPERCLIP_SERVER_CRAWL4AI_TOKEN` bearer token -- never sent to an agent,
 * kept out of agent envs the same way as every other `PAPERCLIP_SERVER_`
 * variable (`packages/adapter-utils/src/server-env-secrets.ts`).
 *
 * Talks plain HTTP to `crawl4ai:11235` over the `crawl4ai-internal` docker
 * network in production -- that network is `internal: true` and its only
 * other member is `server`, so the worker is unreachable from the host or
 * the public internet on this path. See the compose file's own comment for
 * the worker's other network membership (its egress path).
 *
 * This client is the ONLY caller of the worker and exposes a narrow, fixed
 * set of options -- it never accepts or forwards raw hook/JS-code text from
 * an agent or user, and it always sets `proxy_config` so the worker's own
 * fetches go through the existing `browser-egress` proxy rather than a
 * second egress path, and `accept_downloads: false` since Crawl4AI does not
 * document a server-wide downloads switch.
 */

const DEFAULT_EGRESS_PROXY_URL = "http://browser-egress:3128";
const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
const MAX_PAGE_TIMEOUT_MS = 60_000;

export interface Crawl4aiLinks {
  internal: string[];
  external: string[];
}

export interface Crawl4aiCrawlResult {
  url: string;
  success: boolean;
  statusCode: number | null;
  markdown: string | null;
  html: string | null;
  links: Crawl4aiLinks;
  error: string | null;
}

export interface Crawl4aiCrawlOptions {
  /** Always fetch fresh rather than serve the worker's own page cache. Defaults to true. */
  bypassCache?: boolean;
  /** Bounded wait for the page to settle, in ms. Clamped to [0, MAX_PAGE_TIMEOUT_MS]. */
  timeoutMs?: number;
}

export interface Crawl4aiHealth {
  status: string;
  version: string;
}

export interface Crawl4aiClient {
  crawl(url: string, options?: Crawl4aiCrawlOptions): Promise<Crawl4aiCrawlResult>;
  health(): Promise<Crawl4aiHealth>;
}

export class Crawl4aiNotConfiguredError extends Error {
  constructor() {
    super(
      "The Crawl4AI worker is not configured on this instance yet (PAPERCLIP_SERVER_CRAWL4AI_URL / " +
        "PAPERCLIP_SERVER_CRAWL4AI_TOKEN are unset). The crawl4ai overlay has not been deployed here.",
    );
    this.name = "Crawl4aiNotConfiguredError";
  }
}

export interface HttpCrawl4aiClientConfig {
  baseUrl: string;
  token: string;
  /** Forward proxy the worker's own fetches must use. Defaults to the production egress proxy. */
  egressProxyUrl?: string;
  fetchImpl?: typeof fetch;
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  return Math.max(0, Math.min(value, MAX_PAGE_TIMEOUT_MS));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseCrawlResult(url: string, body: unknown): Crawl4aiCrawlResult {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // The Docker API returns a batch envelope (`{ results: [...] }`) for
  // multi-URL requests; this client always sends exactly one URL, so unwrap
  // the first result when present and fall back to a top-level result body
  // for server versions that reply without the envelope for a single URL.
  const resultsField = record.results;
  const result = (Array.isArray(resultsField) && resultsField.length > 0 ? resultsField[0] : record) as Record<string, unknown>;
  const linksField = (result.links && typeof result.links === "object" ? result.links : {}) as Record<string, unknown>;
  return {
    url,
    success: result.success === true,
    statusCode: typeof result.status_code === "number" ? result.status_code : null,
    markdown: typeof result.markdown === "string" ? result.markdown : null,
    html: typeof result.html === "string" ? result.html : null,
    links: {
      internal: asStringArray(linksField.internal),
      external: asStringArray(linksField.external),
    },
    error: typeof result.error_message === "string" ? result.error_message : null,
  };
}

export class HttpCrawl4aiClient implements Crawl4aiClient {
  constructor(private readonly config: HttpCrawl4aiClientConfig) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `Crawl4AI request to ${path} failed with ${response.status}`;
      throw new Error(message);
    }
    return parsed as T;
  }

  async crawl(url: string, options?: Crawl4aiCrawlOptions): Promise<Crawl4aiCrawlResult> {
    const proxyServer = this.config.egressProxyUrl ?? DEFAULT_EGRESS_PROXY_URL;
    const body = await this.request<unknown>("/crawl", {
      urls: [url],
      browser_config: {
        type: "BrowserConfig",
        params: {
          headless: true,
          accept_downloads: false,
          proxy_config: {
            type: "ProxyConfig",
            params: { server: proxyServer },
          },
        },
      },
      crawler_config: {
        type: "CrawlerRunConfig",
        params: {
          cache_mode: options?.bypassCache === false ? "enabled" : "bypass",
          page_timeout: clampTimeoutMs(options?.timeoutMs),
        },
      },
    });
    return parseCrawlResult(url, body);
  }

  health(): Promise<Crawl4aiHealth> {
    return this.request<Crawl4aiHealth>("/health");
  }
}

/** Refuses every call with `Crawl4aiNotConfiguredError` -- the safe default before this overlay is deployed anywhere. */
export class UnconfiguredCrawl4aiClient implements Crawl4aiClient {
  crawl(): Promise<Crawl4aiCrawlResult> {
    return Promise.reject(new Crawl4aiNotConfiguredError());
  }
  health(): Promise<Crawl4aiHealth> {
    return Promise.reject(new Crawl4aiNotConfiguredError());
  }
}

export function createCrawl4aiClientFromEnv(env: NodeJS.ProcessEnv = process.env): Crawl4aiClient {
  const baseUrl = env.PAPERCLIP_SERVER_CRAWL4AI_URL?.trim();
  const token = env.PAPERCLIP_SERVER_CRAWL4AI_TOKEN?.trim();
  if (!baseUrl || !token) return new UnconfiguredCrawl4aiClient();
  const egressProxyUrl = env.PAPERCLIP_SERVER_CRAWL4AI_EGRESS_PROXY_URL?.trim();
  return new HttpCrawl4aiClient({ baseUrl, token, egressProxyUrl: egressProxyUrl || undefined });
}
