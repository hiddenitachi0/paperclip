import { describe, expect, it } from "vitest";
import { isCardOnlyApproval } from "./approval-card-only";

describe("isCardOnlyApproval", () => {
  it.each([
    "trading_strategy_version",
    "crypto_wallet_tx",
    "crypto_sweep_address",
    "crypto_topup_request",
    "deploy",
    "operator_action",
    "deploy_release",
    "rollout",
  ])("requires opening the card for %s", (kind) => {
    expect(isCardOnlyApproval("request_board_approval", { kind })).toBe(true);
  });

  it.each(["merge_pr", "feature_launch", "general"])("lets %s be answered from a list", (kind) => {
    expect(isCardOnlyApproval("request_board_approval", { kind })).toBe(false);
  });

  it("ignores other approval types and missing payloads", () => {
    expect(isCardOnlyApproval("hire_agent", { kind: "deploy" })).toBe(false);
    expect(isCardOnlyApproval("request_board_approval", null)).toBe(false);
    expect(isCardOnlyApproval("request_board_approval", {})).toBe(false);
  });
});
