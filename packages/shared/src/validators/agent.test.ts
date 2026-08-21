import { describe, expect, it } from "vitest";
import { createAgentSchema, mcpServerConfigSchema } from "./agent.js";

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
