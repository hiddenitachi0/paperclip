import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// DUR-213: nothing stopped a single agent run from making unbounded model
// calls against a large cached context and burning unbounded spend before
// anyone noticed. These pin that when the process runner reports the run
// was killed mid-flight for exceeding `maxTokensPerRun`, `execute()` surfaces
// partial usage/summary and a distinct errorCode instead of a bare failure.
const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  // Mirrors what the real runChildProcess does: feed every stdout chunk
  // through the caller's usageCap.onChunk as it "arrives" (here: the whole
  // canned stream in one chunk), so the caller's live tracker accumulates
  // the same usage a real streaming run would have observed.
  runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], opts: { usageCap?: { onChunk: (chunk: string) => boolean } }) => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: {
          usage: { input_tokens: 900_000, output_tokens: 1_000, cache_read_input_tokens: 9_100_000 },
          content: [{ type: "text", text: "still working" }],
        },
      }),
    ].join("\n") + "\n";
    const usageCapped = opts.usageCap?.onChunk(stdout) ?? false;
    return {
      exitCode: usageCapped ? null : 0,
      signal: usageCapped ? "SIGTERM" : null,
      timedOut: false,
      usageCapped,
      stdout,
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

describe("claude execution — per-run token cap (DUR-213)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("reports partial usage and a token_cap_exceeded errorCode when the process runner kills the run for exceeding maxTokensPerRun", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-usage-cap-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        maxTokensPerRun: 5_000_000,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { usageCap?: { onChunk: (chunk: string) => boolean } }]
      | undefined;
    expect(call?.[3].usageCap).toBeDefined();

    expect(result.errorCode).toBe("token_cap_exceeded");
    expect(result.timedOut).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 900_000,
      cachedInputTokens: 9_100_000,
      outputTokens: 1_000,
    });
    expect(result.summary).toContain("still working");
    expect(result.errorMessage).toContain("5,000,000");
  });

  it("does not pass a usageCap to the process runner when maxTokensPerRun is unset", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-usage-cap-off-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    runChildProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      usageCapped: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-2", model: "claude-sonnet" }),
        JSON.stringify({
          type: "result",
          session_id: "claude-session-2",
          result: "done",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 124,
      startedAt: new Date().toISOString(),
    });

    await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
        },
      },
      onLog: async () => {},
    });

    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { usageCap?: unknown }]
      | undefined;
    expect(call?.[3].usageCap).toBeUndefined();
  });
});
