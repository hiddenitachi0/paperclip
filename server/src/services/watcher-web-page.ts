/**
 * DUR-4168: fetches the one value a web-page watcher's rule cares about
 * (a price, an in/out-of-stock phrase, the set of product links on a
 * listing, or a hash of the watched text) from a live page.
 *
 * `WatcherWebPageFetcher` is the seam: `createWatcherWebPageFetcher` is the
 * real implementation (robots.txt, the shared Crawl4AI client, a per-host
 * rate limit -- the same three steps server/src/services/product-grabber/
 * service.ts already uses for the same worker), and
 * `createFakeWatcherWebPageFetcher` is a fixed-responses test double so
 * rule-evaluation and scheduler-wiring tests never need a real page or the
 * Crawl4AI worker running. This keeps the feature testable end to end before
 * DUR-4161's worker overlay is deployed anywhere: swapping the fake for the
 * real fetcher is the only change a later deploy needs.
 */

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { watcherWebPageUrlProblem, type WatcherWebPageRule } from "@paperclipai/shared";
import { createCrawl4aiClientFromEnv, Crawl4aiNotConfiguredError, type Crawl4aiClient } from "./crawl4ai-client.js";
import { createRobotsTxtChecker, type RobotsTxtChecker } from "./product-grabber/robots.js";
import { PerHostRateLimiter } from "./product-grabber/rate-limiter.js";
import { createSafeOutboundFetch, PUBLIC_WEB_PAGE_OUTBOUND_POLICY, type SafeOutboundFetchDeps } from "./safe-outbound-fetch.js";

export const WATCHER_WEB_PAGE_USER_AGENT = "PaperclipWatcherBot/1.0 (+https://paperclip.ing)";
export const WATCHER_WEB_PAGE_MIN_HOST_INTERVAL_MS = 3_000;

export type WatcherWebPageFetchErrorKind = "invalid_url" | "robots_blocked" | "upstream" | "not_configured" | "selector_not_found";

export interface WatcherWebPageFetchError {
  kind: WatcherWebPageFetchErrorKind;
  /** A plain sentence for the operator. Never carries a raw upstream error or page body. */
  message: string;
}

export interface WatcherWebPageFetchResult {
  /** `rule.kind === "price"`: the first number found at the selector, or null if none. */
  price: number | null;
  /** `rule.kind === "stock"`: whether `rule.inStockPhrase` appears (case-insensitive) at the selector. */
  inStock: boolean | null;
  /** `rule.kind === "new_products"`: the identifying key (href or text) of every matching element, in page order. */
  itemKeys: string[] | null;
  /** `rule.kind === "text_change"`: a hash of the selector's (or whole page's) visible text. */
  contentHash: string | null;
  /** A short plain-text snippet of what was found, for the alert. Always scrubbed to a fixed max length. */
  snippet: string;
  observedAt: Date;
}

export interface WatcherWebPageFetcher {
  fetch(rule: WatcherWebPageRule, now?: Date): Promise<WatcherWebPageFetchResult | WatcherWebPageFetchError>;
}

export function isWatcherWebPageFetchError(
  value: WatcherWebPageFetchResult | WatcherWebPageFetchError,
): value is WatcherWebPageFetchError {
  return "kind" in value;
}

const SNIPPET_MAX = 160;

function snippetOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX)}…` : collapsed;
}

function firstNumber(text: string): number | null {
  const match = text.replace(/[,\s]/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function selectElements(html: string, selector: string): { texts: string[]; hrefs: (string | null)[] } {
  const dom = new JSDOM(html);
  const nodes = Array.from(dom.window.document.querySelectorAll(selector));
  return {
    texts: nodes.map((node) => node.textContent ?? ""),
    hrefs: nodes.map((node) => node.getAttribute("href")),
  };
}

function wholePageText(html: string): string {
  const dom = new JSDOM(html);
  return dom.window.document.body?.textContent ?? "";
}

/** Reads the one fetched page into the fields `rule.kind` needs. Throws nothing: a parse miss is a result, not an error. */
function readRule(rule: WatcherWebPageRule, html: string): WatcherWebPageFetchResult {
  const observedAt = new Date();
  const empty: WatcherWebPageFetchResult = {
    price: null,
    inStock: null,
    itemKeys: null,
    contentHash: null,
    snippet: "",
    observedAt,
  };

  if (rule.kind === "price" || rule.kind === "stock") {
    const { texts } = selectElements(html, rule.selector);
    const text = texts[0] ?? "";
    if (rule.kind === "price") {
      return { ...empty, price: firstNumber(text), snippet: snippetOf(text) };
    }
    const inStock = text.toLowerCase().includes(rule.inStockPhrase.toLowerCase());
    return { ...empty, inStock, snippet: snippetOf(text) };
  }

  if (rule.kind === "new_products") {
    const { texts, hrefs } = selectElements(html, rule.selector);
    const keys =
      rule.identifyBy === "href"
        ? hrefs.map((href, i) => href ?? `#text:${snippetOf(texts[i] ?? "")}`)
        : texts.map((text) => snippetOf(text));
    return { ...empty, itemKeys: keys, snippet: keys.slice(0, 3).join(", ") };
  }

  // text_change
  const text = rule.selector ? selectElements(html, rule.selector).texts.join(" ") : wholePageText(html);
  const hash = createHash("sha256").update(text).digest("hex");
  return { ...empty, contentHash: hash, snippet: snippetOf(text) };
}

export interface WatcherWebPageFetcherDeps extends SafeOutboundFetchDeps {
  crawl4ai?: Crawl4aiClient;
  robots?: RobotsTxtChecker;
  rateLimiter?: PerHostRateLimiter;
}

/**
 * The real fetcher: robots.txt, then the shared Crawl4AI worker client
 * (DUR-4161), then this file's own selector reading above. Until that
 * worker overlay is deployed on an instance, `crawl4ai` is an
 * `UnconfiguredCrawl4aiClient` and every call fails the same safe,
 * plain-sentence way `WATCHER_SOURCE_INFO`'s other "not available yet"
 * sources already do -- never a thrown error reaching the scheduler.
 *
 * DUR-4249: unlike product-grabber's use of the same robots.ts checker
 * (always a fixed per-vendor hostname from `registry.findTemplate`), this
 * feature's URL is owner/admin-typed with no allowlist, so the default
 * `fetchImpl` (robots.ts's direct, unproxied `fetch`) would let an operator
 * reach an internal address -- including one that only resolves there via
 * DNS rebinding after `watcherWebPageUrlProblem`'s literal-IP check already
 * passed. The robots.txt request is routed through the same
 * resolve-then-pin, public-address-only, no-redirect-bounce outbound guard
 * (`PUBLIC_WEB_PAGE_OUTBOUND_POLICY`) that quick agents' read_web_page tool
 * already uses for the same "arbitrary operator/agent URL" shape, instead of
 * a bespoke check here. A host the guard refuses throws, which
 * `getRobotsForOrigin` already treats the same as any other robots.txt
 * fetch failure: fail open (allow), since the real page fetch below never
 * uses this path -- it always goes through Crawl4AI's own browser-egress
 * proxy regardless of what robots.txt said.
 */
export function createWatcherWebPageFetcher(deps: WatcherWebPageFetcherDeps = {}): WatcherWebPageFetcher {
  const crawl4ai = deps.crawl4ai ?? createCrawl4aiClientFromEnv();
  const robots =
    deps.robots ??
    createRobotsTxtChecker({
      userAgent: WATCHER_WEB_PAGE_USER_AGENT,
      // robots.ts vets the resolved address itself before fetching (#470);
      // give it the same resolver the outbound guard uses.
      lookupImpl: deps.lookup,
      fetchImpl: createSafeOutboundFetch(PUBLIC_WEB_PAGE_OUTBOUND_POLICY, {
        lookup: deps.lookup,
        testOnlyDial: deps.testOnlyDial,
      }),
    });
  const rateLimiter = deps.rateLimiter ?? new PerHostRateLimiter(WATCHER_WEB_PAGE_MIN_HOST_INTERVAL_MS);

  return {
    async fetch(rule) {
      const problem = watcherWebPageUrlProblem(rule.url);
      if (problem) return { kind: "invalid_url", message: problem };

      let hostname: string;
      try {
        hostname = new URL(rule.url).hostname;
      } catch {
        return { kind: "invalid_url", message: "Use a full web address, starting with http:// or https://." };
      }

      const allowed = await robots.isAllowed(rule.url);
      if (!allowed) {
        return { kind: "robots_blocked", message: `robots.txt for ${hostname} disallows fetching this page.` };
      }

      await rateLimiter.waitForTurn(hostname);
      try {
        const result = await crawl4ai.crawl(rule.url);
        if (!result.success || !result.html) {
          return { kind: "upstream", message: "The page could not be fetched. The next check tries again." };
        }
        return readRule(rule, result.html);
      } catch (error) {
        if (error instanceof Crawl4aiNotConfiguredError) {
          return { kind: "not_configured", message: "Web-page watchers are not available on this instance yet." };
        }
        return { kind: "upstream", message: "The page could not be fetched. The next check tries again." };
      }
    },
  };
}

/** A fixed-responses fetcher for tests: no network, no Crawl4AI worker, no robots.txt fetch. */
export function createFakeWatcherWebPageFetcher(
  responses: Map<string, WatcherWebPageFetchResult | WatcherWebPageFetchError>,
): WatcherWebPageFetcher {
  return {
    async fetch(rule) {
      const result = responses.get(rule.url);
      if (!result) return { kind: "upstream", message: "No fake response was registered for this URL." };
      return result;
    },
  };
}
