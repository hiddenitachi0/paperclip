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
  return { ...actual, runChildProcess, ensureCommandResolvable: vi.fn(async () => {}) };
});

import { execute } from "./execute.js";
import { resolveManagedCodexHomeDir } from "./codex-home.js";

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

  // DUR-132 item 9: an explicit env.CODEX_HOME that still lives under the
  // Paperclip-managed company tree (e.g. the per-agent home set by the
  // server-side isolation guard for an agent with mcpServers) must still get
  // its MCP servers merged into config.toml. Before this fix, execute.ts
  // treated ANY explicit env.CODEX_HOME as a user-managed override and passed
  // `codexHome: null` to prepareCodexRuntimeConfig, which skips the merge
  // entirely -- so an isolated agent's own MCP servers were silently dropped.
  it("still passes a non-null codexHome to prepareCodexRuntimeConfig when env.CODEX_HOME is an explicit but Paperclip-managed path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-mcp-wiring-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const paperclipHome = path.join(rootDir, "paperclip-home");
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    const managedHome = path.join(
      resolveManagedCodexHomeDir({ ...process.env, PAPERCLIP_HOME: paperclipHome, PAPERCLIP_INSTANCE_ID: "default" }, "company-1"),
      "..",
      "agents",
      "agent-1",
      "codex-home",
    );
    const servers = [{ name: "fs", command: "npx", env: { TOKEN: "secret" } }];

    await execute({
      runId: "run-local-mcp-wiring-managed-home",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: { env: { CODEX_HOME: managedHome }, mcpServers: servers },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        cwd: workspaceDir,
        env: { CODEX_HOME: managedHome },
        mcpServers: servers,
      },
      context: {},
      onLog: async () => {},
    });

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexRuntimeConfig.mock.calls[0][0]).toMatchObject({
      codexHome: managedHome,
      mcpServers: servers,
    });
  });

  // DUR-132 item 8: an MCP server credential must never be synced onto a
  // remote execution target's CODEX_HOME.
  it("refuses to run with credential-bearing mcpServers on a remote execution target", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-mcp-wiring-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    const servers = [{ name: "fs", command: "npx", env: { TOKEN: "secret" } }];

    await expect(
      execute({
        runId: "run-remote-mcp-refusal",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "codex", cwd: workspaceDir, mcpServers: servers },
        context: {},
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow(/credential/i);

    expect(prepareCodexRuntimeConfig).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("allows credential-bearing mcpServers on a local execution target (no remote target configured)", async () => {
    const servers = [{ name: "fs", command: "npx", env: { TOKEN: "secret" } }];
    await runLocal(servers);

    expect(prepareCodexRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
  });
});
