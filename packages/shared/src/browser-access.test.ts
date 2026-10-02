import { describe, expect, it } from "vitest";
import {
  BROWSER_ACCESS_LEVELS,
  browserAccessLevelRank,
  effectiveLaneABrowserAccess,
  readLaneABrowserAccess,
} from "./browser-access.js";
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

// DUR-4070: the trust-level ceiling. "limited" must force "off" no matter
// what adapterConfig.laneA.browserAccess itself stores -- this is the exact
// shape of bug (an operator's book_and_buy switch surviving a downgrade to
// Limited) the ceiling exists to close.
describe("effectiveLaneABrowserAccess", () => {
  it("forces 'off' for a limited-trust agent regardless of its own browserAccess switch", () => {
    for (const level of BROWSER_ACCESS_LEVELS) {
      expect(
        effectiveLaneABrowserAccess({ adapterConfig: { laneA: { browserAccess: level } }, laneATrustLevel: "limited" }),
      ).toBe("off");
    }
  });

  it("passes through the real switch for standard and full trust", () => {
    for (const trust of ["standard", "full"] as const) {
      for (const level of BROWSER_ACCESS_LEVELS) {
        expect(
          effectiveLaneABrowserAccess({ adapterConfig: { laneA: { browserAccess: level } }, laneATrustLevel: trust }),
        ).toBe(level);
      }
    }
  });

  it("treats a missing/null trust level as full (today's behavior, unchanged)", () => {
    expect(
      effectiveLaneABrowserAccess({ adapterConfig: { laneA: { browserAccess: "book_and_buy" } } }),
    ).toBe("book_and_buy");
    expect(
      effectiveLaneABrowserAccess({ adapterConfig: { laneA: { browserAccess: "book_and_buy" } }, laneATrustLevel: null }),
    ).toBe("book_and_buy");
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

// DUR-4378 follow-up: apiKeyByProvider (server/src/routes/agents.ts stashes
// each provider's key here across a laneAProvider switch) must be declared
// on this .strict() schema, or the very next PATCH that echoes
// adapterConfig.laneA back (e.g. a settings-form round trip) is rejected
// with a 422 for an "unrecognized key".
describe("laneAAdapterConfigSchema apiKeyByProvider", () => {
  const ref = { type: "secret_ref" as const, secretId: "44444444-4444-4444-8444-444444444444", version: "latest" as const };

  it("round-trips a map of provider -> key ref (or null)", () => {
    const value = { apiKeyByProvider: { openrouter: ref, local: null } };
    expect(laneAAdapterConfigSchema.parse(value)).toEqual(value);
  });

  it("leaves apiKeyByProvider out entirely when absent", () => {
    expect(laneAAdapterConfigSchema.parse({})).toEqual({});
  });
});
