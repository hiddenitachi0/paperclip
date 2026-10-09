import {
  createSafeOutboundFetch,
  PUBLIC_WEB_PAGE_OUTBOUND_POLICY,
  SafeOutboundFetchError,
  type OutboundFetch,
} from "./safe-outbound-fetch.js";

/**
 * Crawls a website from a start URL, follows same-origin links up to a depth,
 * and reports links that answer 4xx/5xx or cannot be reached. Internal links
 * are crawled; external links are only checked. All requests go through the
 * safe outbound fetch (public https hosts only), so a page cannot steer the
 * checker at an internal address.
 */

export interface LinkCheckOptions {
  /** 0 = only the start page's links are checked, none are crawled further. */
  maxDepth?: number;
  maxPages?: number;
  checkExternal?: boolean;
  fetchImpl?: OutboundFetch;
}

export interface BrokenLink {
  url: string;
  /** Null when the host could not be reached or the request was refused. */
  status: number | null;
  error?: string;
  internal: boolean;
  /** Pages on which the link was found. */
  sourcePages: string[];
}

export interface LinkCheckResult {
  startUrl: string;
  pagesCrawled: number;
  linksChecked: number;
  broken: BrokenLink[];
  truncated: boolean;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 100;
const HREF_RE = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|sms:|#)/i;

export function normalizeUrl(raw: string, base?: string): string | null {
  const trimmed = raw.trim().replace(/&amp;/g, "&");
  if (!trimmed || SKIP_SCHEMES.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname === "") url.pathname = "/";
  return url.toString();
}

export function extractLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(HREF_RE)) {
    const normalized = normalizeUrl(m[1] ?? m[2] ?? m[3] ?? "", pageUrl);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

interface Probe {
  status: number | null;
  error?: string;
  html?: string;
}

async function probe(fetchImpl: OutboundFetch, url: string, wantBody: boolean): Promise<Probe> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Probe> => {
    try {
      const res = await fetchImpl(url, { method });
      const contentType = res.headers.get("content-type") ?? "";
      const html = method === "GET" && wantBody && /html/i.test(contentType) ? await res.text() : undefined;
      return { status: res.status, html };
    } catch (error) {
      // A refused redirect means the server answered with a 3xx: the link works.
      if (error instanceof SafeOutboundFetchError && error.code === "redirect_refused") {
        return { status: 302 };
      }
      return { status: null, error: error instanceof Error ? error.message : "request failed" };
    }
  };
  if (wantBody) return attempt("GET");
  const head = await attempt("HEAD");
  // Some servers reject HEAD; retry with GET before calling the link broken.
  if (head.status === null || head.status === 405 || head.status === 501 || head.status >= 400) {
    return attempt("GET");
  }
  return head;
}

export async function checkLinks(startUrl: string, options: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error("startUrl must be a valid http(s) URL");
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const checkExternal = options.checkExternal ?? true;
  const fetchImpl = options.fetchImpl ?? createSafeOutboundFetch(PUBLIC_WEB_PAGE_OUTBOUND_POLICY);
  const origin = new URL(start).origin;

  const sources = new Map<string, Set<string>>();
  const results = new Map<string, Probe>();
  const crawled = new Set<string>();
  let truncated = false;
  let frontier: string[] = [start];
  sources.set(start, new Set());

  for (let depth = 0; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const pageUrl of frontier) {
      if (crawled.size >= maxPages) {
        truncated = true;
        break;
      }
      crawled.add(pageUrl);
      const page = await probe(fetchImpl, pageUrl, true);
      results.set(pageUrl, page);
      if (!page.html) continue;
      for (const link of extractLinks(page.html, pageUrl)) {
        const internal = new URL(link).origin === origin;
        if (!internal && !checkExternal) continue;
        let srcs = sources.get(link);
        if (!srcs) sources.set(link, (srcs = new Set()));
        srcs.add(pageUrl);
        if (results.has(link) || crawled.has(link) || next.includes(link)) continue;
        if (internal && depth < maxDepth) {
          next.push(link);
        } else {
          results.set(link, await probe(fetchImpl, link, false));
        }
      }
    }
    frontier = next;
  }

  const broken: BrokenLink[] = [];
  for (const [url, p] of results) {
    if (p.status !== null && p.status < 400) continue;
    broken.push({
      url,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
      internal: new URL(url).origin === origin,
      sourcePages: [...(sources.get(url) ?? [])],
    });
  }
  return { startUrl: start, pagesCrawled: crawled.size, linksChecked: results.size, broken, truncated };
}
