import { describe, expect, it } from "vitest";
import { createAgentSchema, mcpServerConfigSchema, updateAgentSchema } from "./agent.js";

function baseAgent(adapterConfig: Record<string, unknown>) {
  return {
    name: "Test Agent",
    adapterType: "claude_local",
    adapterConfig,
  };
}

describe("mcpServerConfigSchema", () => {
  it("accepts a stdio entry", () => {
    expect(
      mcpServerConfigSchema.safeParse({ name: "fs", command: "npx", args: ["-y", "server"], env: { FOO: "bar" } })
        .success,
    ).toBe(true);
  });

  it("accepts an http entry", () => {
    expect(
      mcpServerConfigSchema.safeParse({
        name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai",
        headers: { Authorization: "Bearer x" },
      }).success,
    ).toBe(true);
  });

  it("rejects an entry with neither command nor url", () => {
    expect(mcpServerConfigSchema.safeParse({ name: "nothing" }).success).toBe(false);
  });

  it("rejects an entry with both command and url", () => {
    expect(
      mcpServerConfigSchema.safeParse({ name: "both", command: "npx", url: "https://example.com" }).success,
    ).toBe(false);
  });

  it("rejects an entry with an empty name", () => {
    expect(mcpServerConfigSchema.safeParse({ name: "", command: "npx" }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(mcpServerConfigSchema.safeParse({ name: "fs", command: "npx", extra: true }).success).toBe(false);
  });
});

describe("createAgentSchema adapterConfig.mcpServers", () => {
  it("accepts an agent with no mcpServers key at all (default, unaffected agents)", () => {
    const result = createAgentSchema.safeParse(baseAgent({ model: "claude-opus" }));
    expect(result.success).toBe(true);
  });

  it("accepts a valid mcpServers list", () => {
    const result = createAgentSchema.safeParse(
      baseAgent({ mcpServers: [{ name: "fs", command: "npx", args: ["-y", "server"] }] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a malformed mcpServers list", () => {
    const result = createAgentSchema.safeParse(baseAgent({ mcpServers: [{ name: "no-target" }] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".").includes("mcpServers"))).toBe(true);
    }
  });

  it("rejects mcpServers that is not an array", () => {
    const result = createAgentSchema.safeParse(baseAgent({ mcpServers: { name: "fs", command: "npx" } }));
    expect(result.success).toBe(false);
  });

  it("still validates adapterConfig.env alongside mcpServers", () => {
    const result = createAgentSchema.safeParse(
      baseAgent({
        mcpServers: [{ name: "fs", command: "npx" }],
        env: { GOOD: { type: "plain", value: "x" }, BAD: { type: "nonsense" } },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("updateAgentSchema avatarAssetId", () => {
  it("rejects a patch that sets avatarAssetId", () => {
    const result = updateAgentSchema.safeParse({ avatarAssetId: "11111111-1111-4111-8111-111111111111" });
    expect(result.success).toBe(false);
  });

  it("still accepts an otherwise-ordinary patch", () => {
    const result = updateAgentSchema.safeParse({ name: "x" });
    expect(result.success).toBe(true);
  });
});

// DUR-61 addendum: tone (short, how this agent speaks) and personality (long,
// who this agent is) are two separate fields, not one field with a length
// slider — each has its own cap sized to what it actually needs to hold.
describe("createAgentSchema tone/personality", () => {
  it("accepts a short tone and stores it trimmed", () => {
    const result = createAgentSchema.safeParse(baseAgent({}) as never);
    expect(result.success).toBe(true);
  });

  it("rejects a tone over 600 characters", () => {
    const result = createAgentSchema.safeParse({ ...baseAgent({}), tone: "a".repeat(601) });
    expect(result.success).toBe(false);
  });

  it("accepts a personality well past 1200 characters (it is the long field now)", () => {
    const result = createAgentSchema.safeParse({ ...baseAgent({}), personality: "a".repeat(5000) });
    expect(result.success).toBe(true);
  });

  it("rejects a personality over 20000 characters", () => {
    const result = createAgentSchema.safeParse({ ...baseAgent({}), personality: "a".repeat(20001) });
    expect(result.success).toBe(false);
  });

  it("transforms an empty or whitespace-only tone to null rather than storing \"\"", () => {
    const result = createAgentSchema.safeParse({ ...baseAgent({}), tone: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tone).toBeNull();
  });

  it("transforms an empty or whitespace-only personality to null rather than storing \"\"", () => {
    const result = createAgentSchema.safeParse({ ...baseAgent({}), personality: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.personality).toBeNull();
  });
});
