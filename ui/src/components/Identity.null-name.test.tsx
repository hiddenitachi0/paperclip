import { describe, expect, it } from "vitest";
import { deriveInitials } from "./Identity";

describe("deriveInitials with missing names (Costs page crash, 18 Oct)", () => {
  it("never throws on null, undefined or blank names", () => {
    expect(deriveInitials(null)).toBe("?");
    expect(deriveInitials(undefined)).toBe("?");
    expect(deriveInitials("   ")).toBe("?");
  });

  it("keeps the normal initials", () => {
    expect(deriveInitials("Fork Lead")).toBe("FL");
    expect(deriveInitials("Maja")).toBe("MA");
  });
});
