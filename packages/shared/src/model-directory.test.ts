import { describe, expect, it } from "vitest";
import {
  createModelDirectoryEntrySchema,
  modelDirectoryEntryIssue,
  updateModelDirectoryEntrySchema,
} from "./validators/model-directory.js";

const uuid = "33333333-3333-4333-8333-333333333333";

describe("model directory validators (DUR-4379)", () => {
  it("accepts a minimal hosted entry and a local entry with an address", () => {
    expect(createModelDirectoryEntrySchema.safeParse({ name: "Claude", provider: "anthropic", model: "claude-sonnet-5" }).success).toBe(true);
    expect(
      createModelDirectoryEntrySchema.safeParse({ name: "L", provider: "local", model: "llama3.1", baseUrl: "http://localhost:11434/v1" }).success,
    ).toBe(true);
  });

  it("refuses a local/openrouter entry without an address, a wrong model for the provider, and any key field", () => {
    expect(createModelDirectoryEntrySchema.safeParse({ name: "L", provider: "local", model: "llama3.1" }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ name: "A", provider: "anthropic", model: "gpt-4.1" }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ name: "A", provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-x" }).success).toBe(false);
  });

  it("restricts host routing to OpenRouter and validates the address shape", () => {
    expect(
      createModelDirectoryEntrySchema.safeParse({ name: "A", provider: "anthropic", model: "claude-sonnet-5", providerRouting: { only: ["deepinfra"] } }).success,
    ).toBe(false);
    expect(
      createModelDirectoryEntrySchema.safeParse({ name: "O", provider: "openrouter", model: "x/y", baseUrl: "https://openrouter.ai/api/v1", providerRouting: { only: ["deepinfra"] } }).success,
    ).toBe(true);
    expect(createModelDirectoryEntrySchema.safeParse({ name: "L", provider: "local", model: "m", baseUrl: "http://u:p@h/v1" }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ name: "L", provider: "local", model: "m", baseUrl: "file:///etc" }).success).toBe(false);
  });

  it("bounds thinking, temperature, answer length, backups and name", () => {
    const ok = { name: "A", provider: "anthropic", model: "claude-sonnet-5" };
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, defaultThinking: "on", defaultTemperature: 1.5, defaultMaxOutputTokens: 8192 }).success).toBe(true);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, defaultThinking: "auto" }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, defaultTemperature: 2 }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, defaultMaxOutputTokens: 10 }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, backupEntryIds: ["nope"] }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, backupEntryIds: [uuid, uuid] }).success).toBe(false);
    expect(createModelDirectoryEntrySchema.safeParse({ ...ok, name: "   " }).success).toBe(false);
  });

  it("update is partial and strict; the merged-row check forbids a self-backup", () => {
    expect(updateModelDirectoryEntrySchema.parse({})).toEqual({});
    expect(updateModelDirectoryEntrySchema.safeParse({ companyId: uuid }).success).toBe(false);
    expect(modelDirectoryEntryIssue({ id: uuid, provider: "anthropic", model: "claude-sonnet-5", backupEntryIds: [uuid] })).toMatch(/own backup/);
  });
});

describe("curated starters (8 Oct 2026)", () => {
  it("every starter is a valid saved model with catalogue fields and a unique id and name", async () => {
    const { MODEL_DIRECTORY_STARTERS, createModelDirectoryEntrySchema } = await import("./validators/model-directory.js");
    expect(new Set(MODEL_DIRECTORY_STARTERS.map((s) => s.id)).size).toBe(MODEL_DIRECTORY_STARTERS.length);
    expect(new Set(MODEL_DIRECTORY_STARTERS.map((s) => s.name)).size).toBe(MODEL_DIRECTORY_STARTERS.length);
    for (const { id: _id, ...starter } of MODEL_DIRECTORY_STARTERS) {
      const parsed = createModelDirectoryEntrySchema.safeParse(starter);
      expect(parsed.success, `${starter.name}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });
});
