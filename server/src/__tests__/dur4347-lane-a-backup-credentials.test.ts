import { describe, expect, it } from "vitest";
import { backupMayUseMainBinding } from "../services/lane-a.js";

describe("backupMayUseMainBinding (Least privilege: the main key never follows a backup elsewhere)", () => {
  it("allows the same provider on the same host", () => {
    expect(backupMayUseMainBinding({ provider: "openai", baseUrl: null }, { provider: "openai", baseUrl: null })).toBe(true);
  });
  it("refuses a different provider", () => {
    expect(backupMayUseMainBinding({ provider: "openai", baseUrl: null }, { provider: "anthropic", baseUrl: null })).toBe(false);
  });
  it("refuses the same provider on a different base URL", () => {
    expect(
      backupMayUseMainBinding({ provider: "local", baseUrl: "http://evil.example" }, { provider: "local", baseUrl: "http://10.0.0.5:11434" }),
    ).toBe(false);
  });
});
