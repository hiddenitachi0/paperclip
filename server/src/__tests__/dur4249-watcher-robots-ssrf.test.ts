import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WatcherWebPageRule } from "@paperclipai/shared";
import { createWatcherWebPageFetcher, isWatcherWebPageFetchError } from "../services/watcher-web-page.js";
import { PerHostRateLimiter } from "../services/product-grabber/rate-limiter.js";
import type { Crawl4aiClient, Crawl4aiCrawlResult } from "../services/crawl4ai-client.js";

/**
 * DUR-4249: the watcher web-page feature lets an owner/admin type any
 * hostname, unlike product-grabber's fixed per-vendor allowlist -- so the
 * robots.txt pre-check in createWatcherWebPageFetcher must never reach a
 * host directly the way robots.ts's default `fetchImpl` (global `fetch`)
 * would. It must go through the same resolve-then-pin outbound guard the
 * real content fetch's neighbours already use, which also closes the DNS
 * rebinding gap `watcherWebPageUrlProblem`'s literal-IP check cannot.
 */

function fakeCrawl4ai(html = "<html><body>ok</body></html>"): { client: Crawl4aiClient; calls: string[] } {
  const calls: string[] = [];
  const result: Crawl4aiCrawlResult = {
    url: "",
    success: true,
    statusCode: 200,
    markdown: null,
    html,
    links: { internal: [], external: [] },
    error: null,
  };
  return {
    calls,
    client: {
      crawl: async (url: string) => {
        calls.push(url);
        return { ...result, url };
      },
      health: async () => ({ status: "ok", version: "test" }),
    },
  };
}

function rule(url: string): WatcherWebPageRule {
  return { kind: "text_change", url, selector: "" };
}

const NOOP_RATE_LIMITER = new PerHostRateLimiter(0, async () => {});

describe("DUR-4249: watcher web-page robots.txt check is not a direct unproxied fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never calls the global fetch for a hostname that resolves to a private address (DNS rebinding)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client: crawl4ai, calls } = fakeCrawl4ai();

    const fetcher = createWatcherWebPageFetcher({
      crawl4ai,
      rateLimiter: NOOP_RATE_LIMITER,
      // Looks like an ordinary public host at URL-validation time, but
      // resolves to a private address at request time -- the DNS-rebinding
      // shape the ticket calls out. The literal-IP check in
      // watcherWebPageUrlProblem cannot catch this; only a resolve-then-check
      // immediately before the request can.
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
    });

    const result = await fetcher.fetch(rule("https://rebinding-attacker.example.com/page"));

    // The robots.txt guard refuses the private-resolving address and throws;
    // createRobotsTxtChecker treats that the same as any other robots.txt
    // fetch failure (fail open), so the call proceeds to the real content
    // fetch below -- which is fine, since that always goes through
    // Crawl4AI's own browser-egress proxy, never this process's own fetch.
    expect(isWatcherWebPageFetchError(result)).toBe(false);
    expect(calls).toEqual(["https://rebinding-attacker.example.com/page"]);

    // The key assertion: nothing in this call ever asked the Node runtime's
    // global fetch to contact the private-resolving host directly. Before
    // this fix, robots.ts's default `fetchImpl` was exactly that direct,
    // unproxied `fetch("https://rebinding-attacker.example.com/robots.txt")`.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still honors a real robots.txt disallow for an ordinary public host, routed through the outbound guard", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /blocked");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const { client: crawl4ai, calls } = fakeCrawl4ai();
      const fetcher = createWatcherWebPageFetcher({
        crawl4ai,
        rateLimiter: NOOP_RATE_LIMITER,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        testOnlyDial: { host: "127.0.0.1", port },
      });

      const blocked = await fetcher.fetch(rule("https://good-shop.example.com/blocked/page"));
      expect(isWatcherWebPageFetchError(blocked) && blocked.kind).toBe("robots_blocked");
      expect(calls).toEqual([]);

      const allowed = await fetcher.fetch(rule("https://good-shop.example.com/open/page"));
      expect(isWatcherWebPageFetchError(allowed)).toBe(false);
      expect(calls).toEqual(["https://good-shop.example.com/open/page"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
