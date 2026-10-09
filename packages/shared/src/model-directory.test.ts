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
      // A local starter gets the company's model server address when it is added.
      const withAddress = starter.provider === "local" ? { ...starter, baseUrl: "http://192.168.1.20:11434/v1" } : starter;
      const parsed = createModelDirectoryEntrySchema.safeParse(withAddress);
      expect(parsed.success, `${starter.name}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("assumes nobody's computer: no address, not installed, no fit verdict, neutral notes", async () => {
    const { MODEL_DIRECTORY_STARTERS } = await import("./validators/model-directory.js");
    const local = MODEL_DIRECTORY_STARTERS.filter((s) => s.provider === "local");
    expect(local.length).toBeGreaterThan(0);
    for (const starter of local) {
      expect(starter.baseUrl, starter.name).toBeNull();
      expect(starter.availability, starter.name).toBe("planned");
    }
    for (const starter of MODEL_DIRECTORY_STARTERS) {
      expect(starter.specs?.fitsLocalGpu, starter.name).toBeUndefined();
      expect(starter.note, starter.name).not.toMatch(/your PC|the PC|you asked|you started|your installed|already uses it|Filip/i);
    }
  });
});

describe("Settings > Models settings", () => {
  it("takes the graphics memory and the model server address, each optional, null clears", async () => {
    const { updateModelDirectorySettingsSchema } = await import("./validators/model-directory.js");
    const ok = (body: unknown) => updateModelDirectorySettingsSchema.safeParse(body).success;
    expect(ok({ localGpuVramGb: 12 })).toBe(true);
    expect(ok({ localGpuVramGb: 0 })).toBe(true);
    expect(ok({ localGpuVramGb: null })).toBe(true);
    expect(ok({ localBaseUrl: "http://192.168.1.20:11434/v1" })).toBe(true);
    expect(ok({ localBaseUrl: "https://gpu-box.tailnet.ts.net/v1", localGpuVramGb: 24 })).toBe(true);
    expect(ok({ localBaseUrl: null })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ localGpuVramGb: -1 })).toBe(false);
    expect(ok({ localBaseUrl: "192.168.1.20:11434" })).toBe(false);
    expect(ok({ localBaseUrl: "ftp://box/v1" })).toBe(false);
    expect(ok({ localBaseUrl: "http://user:pw@box:11434/v1" })).toBe(false);
    expect(ok({ localBaseUrl: "http://box:11434/v1?x=1" })).toBe(false);
    expect(ok({ localGpuVramGb: 12, other: 1 })).toBe(false);
  });
});
