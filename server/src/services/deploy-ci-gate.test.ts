import { describe, expect, it } from "vitest";
import { describeDeployCiRefusal } from "./deploy-ci-gate.js";

describe("describeDeployCiRefusal", () => {
  it("lets green, none and unknown through", () => {
    for (const state of ["green", "none", "unknown"] as const) {
      expect(describeDeployCiRefusal({ state, failedChecks: [], pendingChecks: [] })).toBeNull();
    }
  });

  it("refuses pending and names the running checks", () => {
    expect(describeDeployCiRefusal({ state: "pending", failedChecks: [], pendingChecks: ["build", "lint"] })).toEqual({
      code: "deploy_ci_pending",
      message: "This version's checks are still running (build and lint). File the card when they are green.",
    });
  });

  it("refuses pending without names when none are known", () => {
    expect(describeDeployCiRefusal({ state: "pending", failedChecks: [], pendingChecks: [] })?.message).toBe(
      "This version's checks are still running. File the card when they are green.",
    );
  });

  it("refuses failed and names the failed checks", () => {
    const refusal = describeDeployCiRefusal({ state: "failed", failedChecks: ["a", "b", "c"], pendingChecks: [] });
    expect(refusal?.code).toBe("deploy_ci_failed");
    expect(refusal?.message).toMatch(/^This version failed its checks: a, b and c\./);
  });
});
