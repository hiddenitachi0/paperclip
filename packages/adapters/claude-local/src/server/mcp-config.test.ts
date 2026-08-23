import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeMcpConfigFileContents,
  claudeMcpServersCarryCredentials,
  parseClaudeMcpServersConfig,
  prepareClaudeMcpConfigSeed,
  UnresolvedMcpCredentialError,
} from "./mcp-config.js";

describe("parseClaudeMcpServersConfig", () => {
  it("returns an empty result for non-array input", () => {
    expect(parseClaudeMcpServersConfig(undefined)).toEqual({ servers: [], skippedCount: 0 });
    expect(parseClaudeMcpServersConfig(null)).toEqual({ servers: [], skippedCount: 0 });
    expect(parseClaudeMcpServersConfig({ foo: "bar" })).toEqual({ servers: [], skippedCount: 0 });
  });

  it("parses a stdio entry with args and env", () => {
    const { servers, skippedCount } = parseClaudeMcpServersConfig([
      { name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { FOO: "bar" } },
    ]);
    expect(skippedCount).toBe(0);
    expect(servers).toEqual([
      { name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { FOO: "bar" } },
    ]);
  });

  it("parses an http entry with headers", () => {
    const { servers, skippedCount } = parseClaudeMcpServersConfig([
      { name: "higgsfield", url: "https://mcp.higgsfield.ai", headers: { Authorization: "Bearer x" } },
    ]);
    expect(skippedCount).toBe(0);
    expect(servers).toEqual([
      { name: "higgsfield", url: "https://mcp.higgsfield.ai", headers: { Authorization: "Bearer x" } },
    ]);
  });

  it("skips entries missing a name or both command and url", () => {
    const { servers, skippedCount } = parseClaudeMcpServersConfig([
      { command: "npx" },
      { name: "no-target" },
      { name: "ok", command: "npx" },
      "not-an-object",
      null,
    ]);
    expect(skippedCount).toBe(4);
    expect(servers).toEqual([{ name: "ok", command: "npx" }]);
  });

  it("drops non-string entries from args rather than failing the whole server", () => {
    const { servers } = parseClaudeMcpServersConfig([
      { name: "fs", command: "npx", args: ["-y", 5, null], env: { FOO: "bar" } },
    ]);
    expect(servers).toEqual([{ name: "fs", command: "npx", args: ["-y"], env: { FOO: "bar" } }]);
  });

  // DUR-132 item 2: a non-string env/headers value reaching this parser means
  // secret resolution failed or was skipped upstream -- that must be a hard
  // failure, not a silently-dropped credential.
  it("throws naming the server and key when env holds an unresolved (non-string) value", () => {
    expect(() =>
      parseClaudeMcpServersConfig([
        { name: "fs", command: "npx", env: { FOO: "bar", BAD: { type: "secret_ref", secretId: "s1" } } },
      ]),
    ).toThrow(UnresolvedMcpCredentialError);
  });

  it("throws naming the server and key when headers holds an unresolved (non-string) value", () => {
    expect(() =>
      parseClaudeMcpServersConfig([
        { name: "higgsfield", url: "https://mcp.higgsfield.ai", headers: { Authorization: { type: "secret_ref", secretId: "s1" } } },
      ]),
    ).toThrow(UnresolvedMcpCredentialError);
  });
});

describe("claudeMcpServersCarryCredentials", () => {
  it("is false when no server has env or headers", () => {
    expect(claudeMcpServersCarryCredentials([{ name: "fs", command: "npx" }])).toBe(false);
  });

  it("is true when any server has a non-empty env", () => {
    expect(
      claudeMcpServersCarryCredentials([{ name: "fs", command: "npx", env: { FOO: "bar" } }]),
    ).toBe(true);
  });

  it("is true when any server has non-empty headers", () => {
    expect(
      claudeMcpServersCarryCredentials([
        { name: "higgsfield", url: "https://mcp.higgsfield.ai", headers: { Authorization: "Bearer x" } },
      ]),
    ).toBe(true);
  });
});

describe("buildClaudeMcpConfigFileContents", () => {
  it("emits stdio servers with command/args/env", () => {
    const contents = buildClaudeMcpConfigFileContents([
      { name: "fs", command: "npx", args: ["-y", "server"], env: { FOO: "bar" } },
    ]);
    expect(JSON.parse(contents)).toEqual({
      mcpServers: { fs: { command: "npx", args: ["-y", "server"], env: { FOO: "bar" } } },
    });
  });

  it("emits http servers with type: http and optional headers", () => {
    const contents = buildClaudeMcpConfigFileContents([
      { name: "higgsfield", url: "https://mcp.higgsfield.ai", headers: { Authorization: "Bearer x" } },
    ]);
    expect(JSON.parse(contents)).toEqual({
      mcpServers: { higgsfield: { type: "http", url: "https://mcp.higgsfield.ai", headers: { Authorization: "Bearer x" } } },
    });
  });

  it("omits empty args/env/headers rather than emitting empty collections", () => {
    const contents = buildClaudeMcpConfigFileContents([{ name: "fs", command: "npx" }]);
    expect(JSON.parse(contents)).toEqual({ mcpServers: { fs: { command: "npx" } } });
  });
});

describe("prepareClaudeMcpConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function withInstanceRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-mcp-config-"));
    cleanupDirs.push(root);
    return root;
  }

  it("returns null when there are no servers", async () => {
    const onLog = vi.fn(async () => {});
    const result = await prepareClaudeMcpConfigSeed({
      companyId: "company-1",
      agentId: "agent-1",
      servers: [],
      onLog,
    });
    expect(result).toBeNull();
    expect(onLog).not.toHaveBeenCalled();
  });

  it("writes a content-addressed mcp-config.json and logs once", async () => {
    const root = await withInstanceRoot();
    const onLog = vi.fn(async () => {});
    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    try {
      const servers = [{ name: "fs", command: "npx", args: ["-y", "server"] }];
      const first = await prepareClaudeMcpConfigSeed({ companyId: "company-1", agentId: "agent-1", servers, onLog });
      expect(first).not.toBeNull();
      expect(first!.filePath.endsWith("mcp-config.json")).toBe(true);
      const contents = await fs.readFile(first!.filePath, "utf8");
      expect(JSON.parse(contents)).toEqual({ mcpServers: { fs: { command: "npx", args: ["-y", "server"] } } });
      expect(onLog).toHaveBeenCalledTimes(1);

      // Re-running with the same servers reuses the same content-addressed path
      // and does not log again.
      const second = await prepareClaudeMcpConfigSeed({ companyId: "company-1", agentId: "agent-1", servers, onLog });
      expect(second!.filePath).toBe(first!.filePath);
      expect(onLog).toHaveBeenCalledTimes(1);

      // Different servers produce a different path (content-addressed).
      const third = await prepareClaudeMcpConfigSeed({
        companyId: "company-1",
        agentId: "agent-1",
        servers: [{ name: "fs", command: "npx", args: ["-y", "other"] }],
        onLog,
      });
      expect(third!.filePath).not.toBe(first!.filePath);
    } finally {
      process.env.PAPERCLIP_HOME = originalHome;
      process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    }
  });
});
