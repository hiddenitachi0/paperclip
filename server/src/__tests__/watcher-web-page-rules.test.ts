import { describe, expect, it } from "vitest";
import { evaluateWatcherWebPageRule, type WatcherWebPageSnapshot } from "../services/watcher-web-page-rules.ts";
import type { WatcherWebPageFetchResult } from "../services/watcher-web-page.ts";

const T0 = new Date("2026-10-01T00:00:00.000Z");

function fetched(overrides: Partial<WatcherWebPageFetchResult> = {}): WatcherWebPageFetchResult {
  return { price: null, inStock: null, itemKeys: null, contentHash: null, snippet: "", observedAt: T0, ...overrides };
}

describe("evaluateWatcherWebPageRule", () => {
  describe("price", () => {
    const rule = { kind: "price" as const, url: "https://example.com/p", selector: ".price", direction: "below" as const, targetPrice: 100, currency: "USD" };

    it("fires the first time the price is already on the alert side", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ price: 90 }), null, false);
      expect(outcome.wantsAlert).toBe(true);
      expect(outcome.conditionNow).toBe(true);
      expect(outcome.changeSummary).toContain("90");
      expect(outcome.nextSnapshot.lastPrice).toBe(90);
    });

    it("does not re-fire for the same crossing", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ price: 85 }), { lastPrice: 90, lastInStock: null, lastItemKeys: null, lastContentHash: null }, true);
      expect(outcome.wantsAlert).toBe(false);
      expect(outcome.conditionNow).toBe(true);
    });

    it("fires again once the price crosses back and then below again", () => {
      // Back above the line: conditionNow false, no alert.
      const above = evaluateWatcherWebPageRule(rule, fetched({ price: 110 }), { lastPrice: 85, lastInStock: null, lastItemKeys: null, lastContentHash: null }, true);
      expect(above.wantsAlert).toBe(false);
      expect(above.conditionNow).toBe(false);
      // Below the line again, with the crossing cleared: fires.
      const below = evaluateWatcherWebPageRule(rule, fetched({ price: 95 }), { lastPrice: 110, lastInStock: null, lastItemKeys: null, lastContentHash: null }, false);
      expect(below.wantsAlert).toBe(true);
    });

    it("direction 'above' fires when the price rises to the target", () => {
      const r = { ...rule, direction: "above" as const, targetPrice: 200 };
      const outcome = evaluateWatcherWebPageRule(r, fetched({ price: 205 }), null, false);
      expect(outcome.wantsAlert).toBe(true);
    });

    it("no price in the fetch leaves the snapshot and never fires", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ price: null }), { lastPrice: 90, lastInStock: null, lastItemKeys: null, lastContentHash: null }, false);
      expect(outcome.wantsAlert).toBe(false);
      expect(outcome.nextSnapshot.lastPrice).toBe(90);
    });
  });

  describe("stock", () => {
    const rule = { kind: "stock" as const, url: "https://example.com/p", selector: ".buy", inStockPhrase: "Add to cart", alertWhen: "becomes_in_stock" as const };

    it("the first check only records state, never fires", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ inStock: false }), null, false);
      expect(outcome.wantsAlert).toBe(false);
      expect(outcome.nextSnapshot.lastInStock).toBe(false);
    });

    it("fires when it becomes in stock and alertWhen matches", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ inStock: true }), { lastPrice: null, lastInStock: false, lastItemKeys: null, lastContentHash: null }, false);
      expect(outcome.wantsAlert).toBe(true);
      expect(outcome.changeSummary).toContain("in stock");
    });

    it("does not fire for the opposite transition", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ inStock: false }), { lastPrice: null, lastInStock: true, lastItemKeys: null, lastContentHash: null }, false);
      expect(outcome.wantsAlert).toBe(false);
    });

    it("'either' fires on both transitions", () => {
      const r = { ...rule, alertWhen: "either" as const };
      const inStock = evaluateWatcherWebPageRule(r, fetched({ inStock: true }), { lastPrice: null, lastInStock: false, lastItemKeys: null, lastContentHash: null }, false);
      const outOfStock = evaluateWatcherWebPageRule(r, fetched({ inStock: false }), { lastPrice: null, lastInStock: true, lastItemKeys: null, lastContentHash: null }, false);
      expect(inStock.wantsAlert).toBe(true);
      expect(outOfStock.wantsAlert).toBe(true);
    });

    it("no change in stock state does not fire", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ inStock: true }), { lastPrice: null, lastInStock: true, lastItemKeys: null, lastContentHash: null }, false);
      expect(outcome.wantsAlert).toBe(false);
    });
  });

  describe("new_products", () => {
    const rule = { kind: "new_products" as const, url: "https://example.com/list", selector: ".product", identifyBy: "href" as const };

    it("the first check records the current set, never fires (a new watcher is not surprised by existing products)", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ itemKeys: ["/a", "/b"] }), null, false);
      expect(outcome.wantsAlert).toBe(false);
      expect(outcome.nextSnapshot.lastItemKeys).toEqual(["/a", "/b"]);
    });

    it("fires when a key appears that was not in the last snapshot", () => {
      const outcome = evaluateWatcherWebPageRule(
        rule,
        fetched({ itemKeys: ["/a", "/b", "/c"] }),
        { lastPrice: null, lastInStock: null, lastItemKeys: ["/a", "/b"], lastContentHash: null },
        false,
      );
      expect(outcome.wantsAlert).toBe(true);
      expect(outcome.changeSummary).toContain("/c");
    });

    it("does not fire when the set is unchanged, even if the order changed", () => {
      const outcome = evaluateWatcherWebPageRule(
        rule,
        fetched({ itemKeys: ["/b", "/a"] }),
        { lastPrice: null, lastInStock: null, lastItemKeys: ["/a", "/b"], lastContentHash: null },
        false,
      );
      expect(outcome.wantsAlert).toBe(false);
    });

    it("does not fire when an item merely disappears", () => {
      const outcome = evaluateWatcherWebPageRule(
        rule,
        fetched({ itemKeys: ["/a"] }),
        { lastPrice: null, lastInStock: null, lastItemKeys: ["/a", "/b"], lastContentHash: null },
        false,
      );
      expect(outcome.wantsAlert).toBe(false);
    });
  });

  describe("text_change", () => {
    const rule = { kind: "text_change" as const, url: "https://example.com/page", selector: "" };

    it("the first check records the hash, never fires", () => {
      const outcome = evaluateWatcherWebPageRule(rule, fetched({ contentHash: "abc123" }), null, false);
      expect(outcome.wantsAlert).toBe(false);
      expect(outcome.nextSnapshot.lastContentHash).toBe("abc123");
    });

    it("fires when the hash differs from last time", () => {
      const outcome = evaluateWatcherWebPageRule(
        rule,
        fetched({ contentHash: "def456", snippet: "new text here" }),
        { lastPrice: null, lastInStock: null, lastItemKeys: null, lastContentHash: "abc123" },
        false,
      );
      expect(outcome.wantsAlert).toBe(true);
      expect(outcome.changeSummary).toContain("new text here");
    });

    it("does not fire when the hash is the same", () => {
      const outcome = evaluateWatcherWebPageRule(
        rule,
        fetched({ contentHash: "abc123" }),
        { lastPrice: null, lastInStock: null, lastItemKeys: null, lastContentHash: "abc123" },
        false,
      );
      expect(outcome.wantsAlert).toBe(false);
    });
  });
});
