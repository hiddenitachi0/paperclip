import { describe, expect, it } from "vitest";
import type { Contract } from "../api/contracts";
import { suggestPreviousVersion } from "./contract-version-suggestion";

function make(id: string, title: string, over: Partial<Contract> = {}): Contract {
  return { id, title, type: "rental_lease", status: "active", ...over } as Contract;
}

describe("suggestPreviousVersion", () => {
  const existing = [
    make("a", "Office lease Oslo"),
    make("b", "Warehouse lease Drammen"),
    make("c", "Office lease Oslo (old)", { status: "superseded" }),
    make("d", "Office lease Oslo", { type: "service" }),
  ];

  it("suggests the same kind of contract with a matching name", () => {
    expect(suggestPreviousVersion("Office_lease_Oslo_v2.pdf", "rental_lease", existing)?.id).toBe("a");
  });

  it("does not suggest a replaced contract, a different kind, or a different contract", () => {
    expect(suggestPreviousVersion("Office lease Oslo", "rental_lease", [existing[2]!, existing[3]!])).toBeNull();
    expect(suggestPreviousVersion("Insurance policy", "rental_lease", existing)).toBeNull();
    expect(suggestPreviousVersion("", "rental_lease", existing)).toBeNull();
  });
});
