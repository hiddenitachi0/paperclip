/**
 * DUR-4168: rule evaluation for web-page watchers. Pure code, no AI, no I/O
 * -- the same split watcher-rules.ts keeps for the price-based sources, kept
 * in its own file because a web-page rule compares the latest fetch to a
 * single last-seen snapshot (watcher_web_page_snapshots), not a price
 * history window.
 *
 *   price          "the price at the selector drops to/rises to a target".
 *                  Fires once per crossing, the same as the numeric `level`
 *                  rule (see watcher-rules.ts): it stays silent on every
 *                  later check still on the alert side, until the price is
 *                  back on the other side first.
 *   stock          "the selector's text changes in/out of stock".
 *                  `alertWhen` picks which transition(s) count.
 *   new_products   "a new item (by href or text) appears in the selector's
 *                  matches since last time". The first check for a watcher
 *                  only records the current set -- a brand-new watcher does
 *                  not treat every existing product as "new".
 *   text_change    "the selector's (or whole page's) text hash differs from
 *                  last time". Same first-check rule as above.
 */

import type { WatcherWebPageRule } from "@paperclipai/shared";
import type { WatcherWebPageFetchResult } from "./watcher-web-page.js";

export interface WatcherWebPageSnapshot {
  lastPrice: number | null;
  lastInStock: boolean | null;
  lastItemKeys: string[] | null;
  lastContentHash: string | null;
}

export interface WatcherWebPageRuleOutcome {
  wantsAlert: boolean;
  /** The level rule's memory: true once an alert went out for the current crossing (price rule only). */
  conditionNow: boolean;
  /** What changed, in one short sentence, when `wantsAlert` is true. */
  changeSummary: string | null;
  /** The snapshot fields to persist for next time. */
  nextSnapshot: WatcherWebPageSnapshot;
}

function unchanged(snapshot: WatcherWebPageSnapshot): WatcherWebPageRuleOutcome {
  return { wantsAlert: false, conditionNow: false, changeSummary: null, nextSnapshot: snapshot };
}

export function evaluateWatcherWebPageRule(
  rule: WatcherWebPageRule,
  fetched: WatcherWebPageFetchResult,
  previous: WatcherWebPageSnapshot | null,
  /** The price rule's memory of whether an alert already went out for the current crossing, like the numeric `level` rule. */
  alertedThisCrossing: boolean,
): WatcherWebPageRuleOutcome {
  if (rule.kind === "price") {
    const price = fetched.price;
    if (price === null) return unchanged({ lastPrice: previous?.lastPrice ?? null, lastInStock: null, lastItemKeys: null, lastContentHash: null });
    const conditionNow = rule.direction === "below" ? price <= rule.targetPrice : price >= rule.targetPrice;
    const wantsAlert = conditionNow && !alertedThisCrossing;
    return {
      wantsAlert,
      conditionNow,
      changeSummary: wantsAlert
        ? `The price is now ${rule.currency} ${price} (target: ${rule.direction} ${rule.currency} ${rule.targetPrice}).`
        : null,
      nextSnapshot: { lastPrice: price, lastInStock: null, lastItemKeys: null, lastContentHash: null },
    };
  }

  if (rule.kind === "stock") {
    const inStock = fetched.inStock;
    if (inStock === null) return unchanged({ lastPrice: null, lastInStock: previous?.lastInStock ?? null, lastItemKeys: null, lastContentHash: null });
    const nextSnapshot: WatcherWebPageSnapshot = { lastPrice: null, lastInStock: inStock, lastItemKeys: null, lastContentHash: null };
    if (previous === null || previous.lastInStock === null) {
      // First check: record the state, nothing to compare against yet.
      return { ...unchanged(nextSnapshot) };
    }
    if (previous.lastInStock === inStock) return unchanged(nextSnapshot);
    const becameInStock = inStock === true;
    const matches =
      rule.alertWhen === "either" ||
      (rule.alertWhen === "becomes_in_stock" && becameInStock) ||
      (rule.alertWhen === "becomes_out_of_stock" && !becameInStock);
    return {
      wantsAlert: matches,
      conditionNow: inStock,
      changeSummary: matches ? `The item is now ${becameInStock ? "in stock" : "out of stock"}.` : null,
      nextSnapshot,
    };
  }

  if (rule.kind === "new_products") {
    const keys = fetched.itemKeys ?? [];
    const nextSnapshot: WatcherWebPageSnapshot = { lastPrice: null, lastInStock: null, lastItemKeys: keys, lastContentHash: null };
    if (previous === null || previous.lastItemKeys === null) {
      return unchanged(nextSnapshot);
    }
    const seen = new Set(previous.lastItemKeys);
    const added = keys.filter((key) => !seen.has(key));
    if (added.length === 0) return unchanged(nextSnapshot);
    return {
      wantsAlert: true,
      conditionNow: true,
      changeSummary:
        added.length === 1 ? `A new product appeared: ${added[0]}` : `${added.length} new products appeared, including ${added[0]}`,
      nextSnapshot,
    };
  }

  // text_change
  const hash = fetched.contentHash;
  const nextSnapshot: WatcherWebPageSnapshot = { lastPrice: null, lastInStock: null, lastItemKeys: null, lastContentHash: hash };
  if (hash === null || previous === null || previous.lastContentHash === null) {
    return unchanged(nextSnapshot);
  }
  if (previous.lastContentHash === hash) return unchanged(nextSnapshot);
  return {
    wantsAlert: true,
    conditionNow: true,
    changeSummary: `The watched text changed. It now reads: "${fetched.snippet}"`,
    nextSnapshot,
  };
}
