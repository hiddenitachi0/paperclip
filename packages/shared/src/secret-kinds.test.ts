import { describe, expect, it } from "vitest";
import { KNOWN_INTEGRATION_ENV_KEYS } from "./integration-keys.js";
import {
  SECRET_KINDS,
  SECRET_KIND_IDS,
  getSecretKind,
  isSecretKind,
  isTestableSecretKind,
  secretKindForEnvKey,
  secretKindLabel,
  secretKindsByCategory,
  secretValueLooksWrongForKind,
} from "./secret-kinds.js";

// DUR-3997: the one list of "what a secret is". These tests pin the shape the
// Secrets screens, the migration backfill and the Test button all rely on.

describe("secret kinds taxonomy", () => {
  it("has one descriptor per id, with a plain label and a category", () => {
    expect(SECRET_KINDS.map((kind) => kind.id).sort()).toEqual([...SECRET_KIND_IDS].sort());
    expect(new Set(SECRET_KINDS.map((kind) => kind.id)).size).toBe(SECRET_KINDS.length);
    for (const kind of SECRET_KINDS) {
      expect(kind.label.length).toBeGreaterThan(3);
      expect(kind.label).not.toMatch(/_/);
      expect(kind.description.length).toBeGreaterThan(10);
    }
  });

  it("marks exactly the AI-provider API keys and the local endpoint as testable", () => {
    const testable = SECRET_KINDS.filter((kind) => kind.testable).map((kind) => kind.id).sort();
    expect(testable).toEqual([
      "anthropic_api_key",
      "google_api_key",
      "local_model_endpoint",
      "openai_api_key",
      "openrouter_api_key",
    ]);
    for (const id of testable) expect(getSecretKind(id)?.category).toBe("ai_provider");
    expect(isTestableSecretKind("github_token")).toBe(false);
    expect(isTestableSecretKind(null)).toBe(false);
    expect(isTestableSecretKind("not-a-kind")).toBe(false);
  });

  it("groups kinds by category in display order, leaving no empty group", () => {
    const groups = secretKindsByCategory();
    expect(groups.map((group) => group.category)).toEqual(["ai_provider", "data_source", "vcs", "messaging", "other"]);
    expect(groups.flatMap((group) => group.kinds).length).toBe(SECRET_KINDS.length);
    for (const group of groups) expect(group.label).not.toMatch(/_/);
  });

  it("gives every well-known integration env key a kind, and finds it back by env key", () => {
    for (const entry of KNOWN_INTEGRATION_ENV_KEYS) {
      expect(entry.kind, entry.key).toBeDefined();
      expect(secretKindForEnvKey(entry.key), entry.key).toBe(entry.kind);
    }
    expect(secretKindForEnvKey("GH_TOKEN")).toBe("github_token");
    expect(secretKindForEnvKey("openai_api_key__all_agents")).toBe("openai_api_key");
    expect(secretKindForEnvKey("SOMETHING_ELSE")).toBe(null);
    expect(secretKindForEnvKey("")).toBe(null);
  });

  it("only warns about a value's shape when it clearly does not fit", () => {
    expect(secretValueLooksWrongForKind("anthropic_api_key", `sk-ant-api03-${"a".repeat(40)}`)).toBe(false);
    expect(secretValueLooksWrongForKind("anthropic_api_key", "hello")).toBe(true);
    expect(secretValueLooksWrongForKind("openai_api_key", `sk-proj-${"b".repeat(40)}`)).toBe(false);
    expect(secretValueLooksWrongForKind("google_api_key", `AIza${"c".repeat(35)}`)).toBe(false);
    expect(secretValueLooksWrongForKind("openrouter_api_key", `sk-or-v1-${"d".repeat(40)}`)).toBe(false);
    expect(secretValueLooksWrongForKind("local_model_endpoint", "http://localhost:11434 my-key")).toBe(false);
    expect(secretValueLooksWrongForKind("local_model_endpoint", "localhost:11434")).toBe(true);
    expect(secretValueLooksWrongForKind("telegram_bot_token", `123456789:${"e".repeat(35)}`)).toBe(false);
    // No pattern, or no kind: never a warning.
    expect(secretValueLooksWrongForKind("fiken_api_token", "anything")).toBe(false);
    expect(secretValueLooksWrongForKind(null, "anything")).toBe(false);
    expect(secretValueLooksWrongForKind("openai_api_key", "   ")).toBe(false);
  });

  it("answers plainly for unknown ids", () => {
    expect(isSecretKind("openai_api_key")).toBe(true);
    expect(isSecretKind("mystery")).toBe(false);
    expect(secretKindLabel("openai_api_key")).toBe("OpenAI API key");
    expect(secretKindLabel(null)).toBe(null);
    expect(secretKindLabel("mystery")).toBe(null);
  });
});
