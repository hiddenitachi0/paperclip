import { describe, expect, it, vi } from "vitest";
import {
  HttpCrawl4aiClient,
  UnconfiguredCrawl4aiClient,
  Crawl4aiNotConfiguredError,
  createCrawl4aiClientFromEnv,
  type Crawl4aiClient,
} from "./crawl4ai-client.js";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("HttpCrawl4aiClient", () => {
  it("sends the bearer token and a single-url batch request to /crawl", async () => {
    const fetchImpl = vi.fn().mockReturnValue(
      jsonResponse({
        results: [{ success: true, status_code: 200, markdown: "# Hi", html: "<h1>Hi</h1>", links: { internal: ["/a"], external: ["https://x.example"] } }],
      }),
    );
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "secret-token", fetchImpl: fetchImpl as any });

    const result = await client.crawl("https://example.com");

    expect(result).toEqual({
      url: "https://example.com",
      success: true,
      statusCode: 200,
      markdown: "# Hi",
      html: "<h1>Hi</h1>",
      links: { internal: ["/a"], external: ["https://x.example"] },
      error: null,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://crawl4ai.internal:11235/crawl");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body);
    expect(body.urls).toEqual(["https://example.com"]);
  });

  it("always forces the egress proxy and disables downloads on every crawl request", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ results: [{ success: true }] }));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "t", fetchImpl: fetchImpl as any });

    await client.crawl("https://example.com");

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.browser_config.params.proxy_config.params.server).toBe("http://browser-egress:3128");
    expect(body.browser_config.params.accept_downloads).toBe(false);
  });

  it("uses a configured egress proxy url over the default", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ results: [{ success: true }] }));
    const client = new HttpCrawl4aiClient({
      baseUrl: "http://crawl4ai.internal:11235",
      token: "t",
      egressProxyUrl: "http://custom-egress:3128",
      fetchImpl: fetchImpl as any,
    });

    await client.crawl("https://example.com");

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.browser_config.params.proxy_config.params.server).toBe("http://custom-egress:3128");
  });

  it("clamps an out-of-range timeout to the maximum", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ results: [{ success: true }] }));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "t", fetchImpl: fetchImpl as any });

    await client.crawl("https://example.com", { timeoutMs: 999_999 });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.crawler_config.params.page_timeout).toBe(60_000);
  });

  it("bypasses the worker's cache by default and can opt back into it", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => jsonResponse({ results: [{ success: true }] }));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "t", fetchImpl: fetchImpl as any });

    await client.crawl("https://example.com");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).crawler_config.params.cache_mode).toBe("bypass");

    await client.crawl("https://example.com", { bypassCache: false });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).crawler_config.params.cache_mode).toBe("enabled");
  });

  it("throws with the worker's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ error: "invalid token" }, 401));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "bad", fetchImpl: fetchImpl as any });

    await expect(client.crawl("https://example.com")).rejects.toThrow("invalid token");
  });

  it("tolerates a non-enveloped single-result response body", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ success: true, status_code: 200, markdown: "hi" }));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "t", fetchImpl: fetchImpl as any });

    const result = await client.crawl("https://example.com");

    expect(result.success).toBe(true);
    expect(result.markdown).toBe("hi");
  });

  it("calls /health with GET and no body", async () => {
    const fetchImpl = vi.fn().mockReturnValue(jsonResponse({ status: "healthy", version: "0.9.4" }));
    const client = new HttpCrawl4aiClient({ baseUrl: "http://crawl4ai.internal:11235", token: "t", fetchImpl: fetchImpl as any });

    const result = await client.health();

    expect(result).toEqual({ status: "healthy", version: "0.9.4" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("UnconfiguredCrawl4aiClient", () => {
  it("refuses every call", async () => {
    const client: Crawl4aiClient = new UnconfiguredCrawl4aiClient();
    await expect(client.crawl("https://example.com")).rejects.toBeInstanceOf(Crawl4aiNotConfiguredError);
    await expect(client.health()).rejects.toBeInstanceOf(Crawl4aiNotConfiguredError);
  });
});

describe("createCrawl4aiClientFromEnv", () => {
  it("returns the unconfigured client when the env vars are unset", () => {
    const client = createCrawl4aiClientFromEnv({});
    expect(client).toBeInstanceOf(UnconfiguredCrawl4aiClient);
  });

  it("returns an HTTP client when the URL and token are set", () => {
    const client = createCrawl4aiClientFromEnv({
      PAPERCLIP_SERVER_CRAWL4AI_URL: "http://crawl4ai:11235",
      PAPERCLIP_SERVER_CRAWL4AI_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(HttpCrawl4aiClient);
  });

  it("stays unconfigured when only the token is set", () => {
    const client = createCrawl4aiClientFromEnv({
      PAPERCLIP_SERVER_CRAWL4AI_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(UnconfiguredCrawl4aiClient);
  });
});
