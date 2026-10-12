import { describe, expect, it } from "vitest";
import { backupKeyState, mainModelKeyState, type AgentKeys } from "./quick-agent-key-state";

const localMain: AgentKeys = {
  main: { provider: "local", baseUrl: "http://pc:11434/v1" },
  hasMainKey: false,
  providerKeys: {},
};

describe("mainModelKeyState", () => {
  it("a local model needs no key", () => {
    expect(mainModelKeyState("local", localMain)).toBe("not_needed");
  });
  it("same provider uses the main key; another provider uses the agent's key for it", () => {
    const keys: AgentKeys = { ...localMain, main: { provider: "openrouter", baseUrl: null }, hasMainKey: true };
    expect(mainModelKeyState("openrouter", keys)).toBe("set");
    expect(mainModelKeyState("openai", keys)).toBe("missing");
    expect(mainModelKeyState("openai", { ...keys, providerKeys: { openai: { name: "OpenAI" } } })).toBe("set");
  });
  it("Claude without a key falls back to Paperclip's own, when it is set", () => {
    expect(mainModelKeyState("anthropic", localMain)).toBe("paperclip");
    expect(mainModelKeyState("anthropic", { ...localMain, instanceClaudeKey: false })).toBe("paperclip_missing");
  });
});

describe("backupKeyState (mirrors laneABackupKeySlot)", () => {
  it("another provider at its own address uses the agent's key for that provider", () => {
    expect(backupKeyState({ provider: "openrouter" }, localMain)).toBe("missing");
    expect(backupKeyState({ provider: "openrouter" }, { ...localMain, providerKeys: { openrouter: { name: "OR" } } })).toBe("set");
  });
  it("the main model's provider and address share the main key", () => {
    const keys: AgentKeys = { main: { provider: "openrouter", baseUrl: null }, hasMainKey: true, providerKeys: {} };
    expect(backupKeyState({ provider: "openrouter" }, keys)).toBe("set");
    expect(backupKeyState({ provider: "openrouter" }, { ...keys, hasMainKey: false })).toBe("missing");
  });
  it("a key is never sent to a different address", () => {
    const keys: AgentKeys = { main: { provider: "openrouter", baseUrl: null }, hasMainKey: true, providerKeys: {} };
    expect(backupKeyState({ provider: "openrouter", baseUrl: "https://elsewhere.example/v1" }, keys)).toBe("wrong_address");
    const stashed: AgentKeys = {
      ...localMain,
      providerKeys: { openrouter: { name: "OR" } },
      stashedBaseUrls: { openrouter: "https://proxy.example/v1" },
    };
    expect(backupKeyState({ provider: "openrouter" }, stashed)).toBe("wrong_address");
  });
  it("local backups need none; Claude backups fall back to Paperclip's key", () => {
    expect(backupKeyState({ provider: "local", baseUrl: "http://other:11434/v1" }, localMain)).toBe("not_needed");
    expect(backupKeyState({ provider: "anthropic" }, localMain)).toBe("paperclip");
  });
});
