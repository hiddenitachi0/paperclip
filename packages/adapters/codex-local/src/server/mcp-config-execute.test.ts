import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// This suite only needs to prove the one-line wiring in execute.ts
// (`mcpServers: config.mcpServers`) actually reaches prepareCodexRuntimeConfig
// unchanged -- the merge/backup/TOML logic itself is covered exhaustively in
// runtime-config.test.ts. Routing a full local run through the real
// credential + managed-CODEX_HOME machinery just to observe this one
// passthrough would be a lot of unrelated setup for the same guarantee, so
// prepareCodexRuntimeConfig is mocked here instead of exercised for real.
const { prepareCodexRuntimeConfig } = vi.hoisted(() => ({
  prepareCodexRuntimeConfig: vi.fn(async (_input: { env: Record<string, string>; codexHome: string | null; mcpServers?: unknown }) => ({
    notes: [] as string[],
    cleanup: async () => {},
  })),
}));

vi.mock("./runtime-config.js", () => ({ prepareCodexRuntimeConfig }));

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return { ...actual, codexHomeHasUsableAuth: vi.fn(async () => true) };
});

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "session_meta", session_id: "codex-session-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

import { execute } from "./execute.js";

describe("codex local execution — per-agent MCP servers wiring", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocal(mcpServers?: unknown) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-mcp-wiring-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");

    await execute({
      runId: "run-local-mcp-wiring",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        cwd: workspaceDir,
        ...(mcpServers !== undefined ? { mcpServers } : {}),
      },
      context: {},
      onLog: async () => {},
    });
  }

  it("passes config.mcpServers straight through to prepareCodexRuntimeConfig", async () => {
    const servers = [{ name: "fs", command: "npx", args: ["-y", "server"] }];
    await runLocal(servers);

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexRuntimeConfig.mock.calls[0][0]).toMatchObject({ mcpServers: servers });
  });

  it("passes mcpServers: undefined through when adapterConfig.mcpServers is unset", async () => {
    await runLocal();

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexRuntimeConfig.mock.calls[0][0]).toMatchObject({ mcpServers: undefined });
  });
});
