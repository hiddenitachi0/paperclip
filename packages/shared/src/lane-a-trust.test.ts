import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANE_A_TRUST_LEVEL,
  LANE_A_TRUST_LEVELS,
  isLaneATrustLimited,
  normalizeLaneATrustLevel,
} from "./lane-a-trust.js";

describe("normalizeLaneATrustLevel", () => {
  it("reads each real level back unchanged", () => {
    for (const level of LANE_A_TRUST_LEVELS) {
      expect(normalizeLaneATrustLevel(level)).toBe(level);
    }
  });

  it("defaults to full on null, undefined, empty, or an unrecognized value", () => {
    expect(normalizeLaneATrustLevel(null)).toBe(DEFAULT_LANE_A_TRUST_LEVEL);
    expect(normalizeLaneATrustLevel(undefined)).toBe(DEFAULT_LANE_A_TRUST_LEVEL);
    expect(normalizeLaneATrustLevel("")).toBe(DEFAULT_LANE_A_TRUST_LEVEL);
    expect(normalizeLaneATrustLevel("omniscient")).toBe(DEFAULT_LANE_A_TRUST_LEVEL);
  });
});

describe("isLaneATrustLimited", () => {
  it("is true only for 'limited'", () => {
    expect(isLaneATrustLimited("limited")).toBe(true);
    expect(isLaneATrustLimited("standard")).toBe(false);
    expect(isLaneATrustLimited("full")).toBe(false);
  });

  it("is false (defaults to full) for null, undefined, or unrecognized values", () => {
    expect(isLaneATrustLimited(null)).toBe(false);
    expect(isLaneATrustLimited(undefined)).toBe(false);
    expect(isLaneATrustLimited("not_a_level")).toBe(false);
  });
});
