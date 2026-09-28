import { describe, expect, it } from "vitest";
import { BROWSER_ACCESS_LEVELS, browserAccessLevelRank, readLaneABrowserAccess } from "./browser-access.js";
import { laneAAdapterConfigSchema } from "./validators/agent.js";

describe("readLaneABrowserAccess", () => {
  it("defaults to off on anything unset, malformed or unrecognized", () => {
    expect(readLaneABrowserAccess(undefined)).toBe("off");
    expect(readLaneABrowserAccess(null)).toBe("off");
    expect(readLaneABrowserAccess("not an object")).toBe("off");
    expect(readLaneABrowserAccess({})).toBe("off");
    expect(readLaneABrowserAccess({ laneA: null })).toBe("off");
    expect(readLaneABrowserAccess({ laneA: {} })).toBe("off");
    expect(readLaneABrowserAccess({ laneA: { browserAccess: "not_a_level" } })).toBe("off");
    expect(readLaneABrowserAccess({ laneA: { browserAccess: true } })).toBe("off");
  });

  it("reads each real level", () => {
    for (const level of BROWSER_ACCESS_LEVELS) {
      expect(readLaneABrowserAccess({ laneA: { browserAccess: level } })).toBe(level);
    }
  });
});

describe("browserAccessLevelRank", () => {
  it("orders off < browse_and_forms < book_and_buy", () => {
    expect(browserAccessLevelRank("off")).toBeLessThan(browserAccessLevelRank("browse_and_forms"));
    expect(browserAccessLevelRank("browse_and_forms")).toBeLessThan(browserAccessLevelRank("book_and_buy"));
  });
});

// DUR-4019: laneAAdapterConfigSchema is .strict(), so browserAccess must be
// declared there or every save of it is silently stripped.
describe("laneAAdapterConfigSchema", () => {
  it("accepts a real browserAccess level", () => {
    for (const level of BROWSER_ACCESS_LEVELS) {
      expect(laneAAdapterConfigSchema.parse({ browserAccess: level })).toEqual({ browserAccess: level });
    }
  });

  it("refuses a level that is not one of the three", () => {
    expect(laneAAdapterConfigSchema.safeParse({ browserAccess: "everything" }).success).toBe(false);
  });

  it("leaves browserAccess out entirely when absent, same as webSearch", () => {
    expect(laneAAdapterConfigSchema.parse({})).toEqual({});
  });
});
