import { describe, expect, it } from "vitest";
import { evaluateDeployPolicyForRequest } from "./deploy-policy-enforcement.js";

describe("DUR-4139: deploy policy mode/ask-first enforcement", () => {
  it("defaults an unset policy to approval_every_time and allows the request", () => {
    const decision = evaluateDeployPolicyForRequest(null);
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("approval_every_time");
    expect(decision.askFirstActions).toEqual([]);
  });

  it("allows a request when the mode is explicitly approval_every_time", () => {
    const decision = evaluateDeployPolicyForRequest({ enabled: true, mode: "approval_every_time" });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("approval_every_time");
  });

  it("allows a request under auto_after_review with no ask-first categories configured", () => {
    const decision = evaluateDeployPolicyForRequest({ enabled: true, mode: "auto_after_review" });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("auto_after_review");
    expect(decision.askFirstActions).toEqual([]);
  });

  it("allows a request under auto_after_review even with ask-first categories configured -- the card still gets filed", () => {
    const decision = evaluateDeployPolicyForRequest({
      enabled: true,
      mode: "auto_after_review",
      askFirstActions: ["live_data_write", "costs_money"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.askFirstActions).toEqual(["live_data_write", "costs_money"]);
  });

  it("refuses a live deploy request outright when the mode is preview_only", () => {
    const decision = evaluateDeployPolicyForRequest({ enabled: true, mode: "preview_only" });
    expect(decision.allowed).toBe(false);
    expect(decision.refusalReason).toMatch(/preview only/i);
    expect(decision.refusalReason).toMatch(/Git or SFTP/i);
  });

  it("refuses a preview_only request regardless of the ask-first list", () => {
    const decision = evaluateDeployPolicyForRequest({
      enabled: true,
      mode: "preview_only",
      askFirstActions: ["structural_change"],
    });
    expect(decision.allowed).toBe(false);
  });

  it("tolerates a malformed/non-object deployPolicy by falling back to the safe default", () => {
    expect(evaluateDeployPolicyForRequest(undefined).allowed).toBe(true);
    expect(evaluateDeployPolicyForRequest("not an object" as unknown).allowed).toBe(true);
    expect(evaluateDeployPolicyForRequest([]).allowed).toBe(true);
  });

  it("ignores an unrecognized mode value and falls back to the safe default", () => {
    const decision = evaluateDeployPolicyForRequest({ enabled: true, mode: "whatever_an_attacker_sends" });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("approval_every_time");
  });

  it("drops an ask-first entry that is not one of the known categories", () => {
    const decision = evaluateDeployPolicyForRequest({
      enabled: true,
      askFirstActions: ["live_data_write", "made_up_category"],
    });
    expect(decision.askFirstActions).toEqual(["live_data_write"]);
  });
});
