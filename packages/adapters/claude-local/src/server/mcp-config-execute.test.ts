import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess, ensureCommandResolvable };
});

import { execute } from "./execute.js";

describe("claude local execution — per-agent MCP servers", () => {
  const cleanupDirs: string[] = [];
  let originalPaperclipHome: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_HOME = originalPaperclipHome;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocal(rootDir: string, mcpServers?: unknown) {
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    originalPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = path.join(rootDir, "paperclip-home");

    await execute({
      runId: "run-local-mcp",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        ...(mcpServers !== undefined ? { mcpServers } : {}),
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    return runChildProcess.mock.calls[0] as unknown as [string, string, string[]];
  }

  it("passes --mcp-config and --strict-mcp-config pointing at a real file when adapterConfig.mcpServers is set", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-mcp-"));
    cleanupDirs.push(rootDir);

    const call = await runLocal(rootDir, [
      { name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    ]);

    const args = call[2];
    expect(args).toContain("--strict-mcp-config");
    const flagIndex = args.indexOf("--mcp-config");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    const configPath = args[flagIndex + 1];
    expect(configPath.endsWith("mcp-config.json")).toBe(true);
    const contents = JSON.parse(await readFile(configPath, "utf8"));
    expect(contents).toEqual({
      mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } },
    });
  });

  it("omits --mcp-config and --strict-mcp-config when adapterConfig.mcpServers is unset (no behavior change for existing agents)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-no-mcp-"));
    cleanupDirs.push(rootDir);

    const call = await runLocal(rootDir);

    const args = call[2];
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("omits the flags and logs a warning when every configured entry is malformed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-bad-mcp-"));
    cleanupDirs.push(rootDir);

    const call = await runLocal(rootDir, [{ name: "no-target-set" }]);

    const args = call[2];
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });
});
