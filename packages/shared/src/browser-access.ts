/**
 * "Browser access" for quick agents: same shape as web-search.ts
 * (adapterConfig.laneA.webSearch), but a three-level dial instead of a
 * switch, since a browser can do a lot more than a search box.
 *
 *   - "off": no browser tool at all (the default).
 *   - "browse_and_forms": can navigate pages and fill in forms, but never
 *     enters a payment card or a saved site login.
 *   - "book_and_buy": may also use a saved payment card / site login bound
 *     to it, to actually complete a purchase or a booking.
 *
 * Lives at adapterConfig.laneA.browserAccess, next to webSearch. Board-only
 * for the same reason: an agent that could raise its own level has no
 * ceiling (server/src/routes/agents.ts).
 */

export const BROWSER_ACCESS_LEVELS = ["off", "browse_and_forms", "book_and_buy"] as const;

export type BrowserAccessLevel = (typeof BROWSER_ACCESS_LEVELS)[number];

/** adapterConfig.laneA.browserAccess, read defensively: anything unrecognized is "off". */
export function readLaneABrowserAccess(adapterConfig: unknown): BrowserAccessLevel {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return "off";
  const laneA = (adapterConfig as { laneA?: unknown }).laneA;
  if (typeof laneA !== "object" || laneA === null) return "off";
  const value = (laneA as { browserAccess?: unknown }).browserAccess;
  return (BROWSER_ACCESS_LEVELS as readonly unknown[]).includes(value) ? (value as BrowserAccessLevel) : "off";
}

/** Ordering for the board-only "cannot raise its own level" guard: off < browse_and_forms < book_and_buy. */
export function browserAccessLevelRank(level: BrowserAccessLevel): number {
  return BROWSER_ACCESS_LEVELS.indexOf(level);
}
