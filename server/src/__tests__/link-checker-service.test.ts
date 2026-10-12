import { describe, expect, it } from "vitest";
import { checkLinks, extractLinks, normalizeUrl } from "../services/link-checker-service.js";

function siteFetch(site: Record<string, { status?: number; html?: string }>) {
  return (async (input: RequestInfo | URL) => {
    const page = site[input.toString()];
    if (!page) throw new Error("unreachable");
    return new Response(page.html ?? null, {
      status: page.status ?? 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
}

describe("link-checker-service", () => {
  it("normalizes URLs and skips non-http links", () => {
    expect(normalizeUrl("/a#x", "https://Example.com")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(extractLinks(`<a class="x" href='/p?a=1&amp;b=2'>x</a><a href=/q>`, "https://e.com/")).toEqual([
      "https://e.com/p?a=1&b=2",
      "https://e.com/q",
    ]);
  });

  it("reports nothing for a clean site", async () => {
    const fetchImpl = siteFetch({
      "https://e.com/": { html: `<a href="/about">a</a><a href="https://other.com/">o</a>` },
      "https://e.com/about": { html: `<a href="/">home</a>` },
      "https://other.com/": {},
    });
    const r = await checkLinks("https://e.com", { fetchImpl });
    expect(r.broken).toEqual([]);
    expect(r.pagesCrawled).toBe(2);
  });

  it("finds broken internal and external links with source pages", async () => {
    const fetchImpl = siteFetch({
      "https://e.com/": { html: `<a href="/about">a</a><a href="https://dead.com/x">d</a>` },
      "https://e.com/about": { html: `<a href="/missing">m</a><a href="https://gone.com/">g</a>` },
      "https://e.com/missing": { status: 404 },
      "https://dead.com/x": { status: 500 },
    });
    const r = await checkLinks("https://e.com/", { fetchImpl });
    const byUrl = Object.fromEntries(r.broken.map((b) => [b.url, b]));
    expect(byUrl["https://e.com/missing"]).toMatchObject({ status: 404, internal: true, sourcePages: ["https://e.com/about"] });
    expect(byUrl["https://dead.com/x"]).toMatchObject({ status: 500, internal: false, sourcePages: ["https://e.com/"] });
    expect(byUrl["https://gone.com/"]).toMatchObject({ status: null, internal: false });
  });

  it("respects depth, page cap and checkExternal", async () => {
    const fetchImpl = siteFetch({
      "https://e.com/": { html: `<a href="/a">a</a><a href="https://dead.com/">d</a>` },
      "https://e.com/a": { html: `<a href="/b">b</a>` },
      "https://e.com/b": { status: 404 },
    });
    const shallow = await checkLinks("https://e.com/", { fetchImpl, maxDepth: 0, checkExternal: false });
    // /a is beyond the crawl depth so it is only checked, and /b is never seen.
    expect(shallow.pagesCrawled).toBe(1);
    expect(shallow.broken).toEqual([]);
    const capped = await checkLinks("https://e.com/", { fetchImpl, maxPages: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.pagesCrawled).toBe(1);
  });
});
