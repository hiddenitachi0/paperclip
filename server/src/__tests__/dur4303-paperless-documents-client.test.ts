import { describe, expect, it } from "vitest";
import type { PaperlessReadContext } from "../services/data-sources/connection-kind.js";
import { DataSourceUpstreamError } from "../services/data-sources/contract.js";
import {
  buildPaperlessSearchQuery,
  fetchPaperlessDocumentDownload,
  getPaperlessDocument,
  PaperlessDocumentNotFoundError,
  searchPaperlessDocuments,
} from "../services/data-sources/paperless-documents-client.js";

/**
 * DUR-4303: the paperless-ngx REST calls behind search_documents/get_document.
 * Unit-level against a fake `PaperlessReadContext.fetch` -- no network, no
 * database -- proving the response mapping (names resolved only for the ids
 * a page actually used, snippets de-highlighted and clipped, dates taken
 * date-only) and the not-found/upstream-error paths the adapter in
 * paperless-source.ts relies on.
 */

function fakeContext(handler: (url: string) => Response): PaperlessReadContext {
  const seen: string[] = [];
  return {
    kind: "paperless_ngx",
    connection: {} as never,
    baseUrl: "http://paperless-a.internal:8001",
    now: () => new Date(),
    stats: () => ({ requests: seen.length, costPoints: 0 }),
    fetch: (async (input) => {
      const url = input.toString();
      seen.push(url);
      return handler(url);
    }) as PaperlessReadContext["fetch"],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("DUR-4303 buildPaperlessSearchQuery", () => {
  it("appends tag qualifiers to the query, quoting ones with spaces", () => {
    expect(buildPaperlessSearchQuery("rental agreement", ["invoice", "q3 2026"])).toBe(
      'rental agreement tag:invoice tag:"q3 2026"',
    );
  });

  it("is just the trimmed query when there are no tags", () => {
    expect(buildPaperlessSearchQuery("  invoice 42  ")).toBe("invoice 42");
  });
});

describe("DUR-4303 searchPaperlessDocuments", () => {
  it("maps results, resolving correspondent/tag names only for the ids this page used", () => {
    const context = fakeContext((url) => {
      if (url.includes("/api/documents/?")) {
        return json({
          count: 1,
          results: [
            {
              id: 7,
              correspondent: 1,
              title: "Leiekontrakt 2026",
              tags: [3],
              created: "2026-01-05T10:00:00Z",
              __search_hit__: { highlights: "a <span>leiekontrakt</span> for 2026" },
            },
          ],
        });
      }
      if (url.includes("/api/correspondents/?id__in=1")) {
        return json({ results: [{ id: 1, name: "Statens vegvesen" }] });
      }
      if (url.includes("/api/tags/?id__in=3")) {
        return json({ results: [{ id: 3, name: "contract" }] });
      }
      throw new Error(`unexpected url ${url}`);
    });

    return searchPaperlessDocuments(context, { query: "leiekontrakt" }).then((result) => {
      expect(result.totalCount).toBe(1);
      expect(result.results).toEqual([
        {
          id: 7,
          title: "Leiekontrakt 2026",
          correspondent: "Statens vegvesen",
          date: "2026-01-05",
          tags: ["contract"],
          snippet: "a leiekontrakt for 2026",
        },
      ]);
    });
  });

  it("clips an overlong snippet instead of returning it whole", async () => {
    const long = "x".repeat(400);
    const context = fakeContext((url) => {
      if (url.includes("/api/documents/?")) {
        return json({ count: 1, results: [{ id: 1, correspondent: null, title: "Big", tags: [], content: long }] });
      }
      return json({ results: [] });
    });
    const result = await searchPaperlessDocuments(context, { query: "x" });
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(300);
    expect(result.results[0]!.snippet.endsWith("…")).toBe(true);
  });

  it("never makes a name-lookup request when a page has no correspondents or tags", async () => {
    const seenPaths: string[] = [];
    const context = fakeContext((url) => {
      seenPaths.push(url);
      return json({ count: 0, results: [] });
    });
    await searchPaperlessDocuments(context, { query: "nothing" });
    expect(seenPaths).toHaveLength(1);
    expect(seenPaths[0]).toContain("/api/documents/?");
  });
});

describe("DUR-4303 getPaperlessDocument", () => {
  it("resolves correspondent, document type and tag names for one document", async () => {
    const context = fakeContext((url) => {
      if (url.endsWith("/api/documents/9/")) {
        return json({ id: 9, title: "Faktura", correspondent: 2, document_type: 5, tags: [4], created: "2026-02-01T00:00:00Z", original_file_name: "faktura.pdf" });
      }
      if (url.endsWith("/api/correspondents/2/")) return json({ name: "Elvia" });
      if (url.endsWith("/api/document_types/5/")) return json({ name: "Invoice" });
      if (url.includes("/api/tags/?id__in=4")) return json({ results: [{ id: 4, name: "power" }] });
      throw new Error(`unexpected url ${url}`);
    });

    const detail = await getPaperlessDocument(context, 9);
    expect(detail).toEqual({
      id: 9,
      title: "Faktura",
      correspondent: "Elvia",
      documentType: "Invoice",
      date: "2026-02-01",
      tags: ["power"],
      originalFileName: "faktura.pdf",
      pageCount: null,
    });
  });

  it("throws PaperlessDocumentNotFoundError on a 404, naming the id, never the container", async () => {
    const context = fakeContext(() => new Response("", { status: 404 }));
    await expect(getPaperlessDocument(context, 404)).rejects.toSatisfy(
      (err: unknown) => err instanceof PaperlessDocumentNotFoundError && err.documentId === 404,
    );
  });

  it("throws DataSourceUpstreamError on a non-2xx, non-404 status", async () => {
    const context = fakeContext(() => new Response("", { status: 500 }));
    await expect(getPaperlessDocument(context, 1)).rejects.toBeInstanceOf(DataSourceUpstreamError);
  });

  it("throws DataSourceUpstreamError when the network call itself fails", async () => {
    const context: PaperlessReadContext = {
      kind: "paperless_ngx",
      connection: {} as never,
      baseUrl: "http://paperless-a.internal:8001",
      now: () => new Date(),
      stats: () => ({ requests: 0, costPoints: 0 }),
      fetch: (async () => {
        throw new Error("network down");
      }) as PaperlessReadContext["fetch"],
    };
    await expect(getPaperlessDocument(context, 1)).rejects.toBeInstanceOf(DataSourceUpstreamError);
  });
});

describe("DUR-4303 fetchPaperlessDocumentDownload", () => {
  it("returns the raw response on a 2xx, for the proxy route to stream", async () => {
    const bytes = new TextEncoder().encode("pdf-bytes");
    const context = fakeContext(() => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }));
    const response = await fetchPaperlessDocumentDownload(context, 1);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("throws PaperlessDocumentNotFoundError on a 404", async () => {
    const context = fakeContext(() => new Response("", { status: 404 }));
    await expect(fetchPaperlessDocumentDownload(context, 2)).rejects.toBeInstanceOf(PaperlessDocumentNotFoundError);
  });
});
