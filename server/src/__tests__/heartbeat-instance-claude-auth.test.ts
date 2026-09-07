// One-click Claude sign-in: the instance-wide token is injected into a
// claude_local run only when nothing else gives the run a Claude credential,
// and it is then treated like any bound secret for redaction.
import { describe, expect, it, vi } from "vitest";
import { claudeEnvHasOwnCredential, resolveExecutionRunAdapterConfig } from "../services/heartbeat.ts";

const INSTANCE_TOKEN = `sk-ant-oat01-${"instance0".repeat(8)}`;

function fakeSecretsSvc(agentEnv: Record<string, unknown>) {
  return {
    resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
      config: { env: agentEnv, model: "claude-sonnet-5" },
      secretKeys: new Set<string>(),
      manifest: [],
    }),
    resolveEnvBindings: vi.fn().mockResolvedValue({ env: {}, secretKeys: new Set<string>(), manifest: [] }),
  } as any;
}

describe("instance-wide Claude sign-in fallback in resolveExecutionRunAdapterConfig", () => {
  it("injects the instance token for a claude_local agent with no Claude credential of its own", async () => {
    const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: { env: { GITHUB_TOKEN: "ghp_x" } },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({ GITHUB_TOKEN: "ghp_x" }),
      instanceClaudeAuth: { resolveFallbackToken },
    });
    expect(resolveFallbackToken).toHaveBeenCalledTimes(1);
    expect(result.usedInstanceClaudeAuth).toBe(true);
    expect(result.resolvedConfig).toMatchObject({
      model: "claude-sonnet-5",
      env: { GITHUB_TOKEN: "ghp_x", CLAUDE_CODE_OAUTH_TOKEN: INSTANCE_TOKEN },
    });
    expect(result.secretKeys.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(result.secretValues.has(INSTANCE_TOKEN)).toBe(true);
    // The fallback is not a bound secret, so it must not fabricate a manifest entry.
    expect(result.secretManifest).toEqual([]);
  });

  it("leaves an agent that already has its own token, API key or Bedrock setup alone", async () => {
    for (const ownEnv of [
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-agents-own-token" },
      { ANTHROPIC_API_KEY: "sk-ant-api03-own" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
    ]) {
      const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "claude_local",
        executionRunConfig: { env: ownEnv },
        projectEnv: null,
        secretsSvc: fakeSecretsSvc(ownEnv),
        instanceClaudeAuth: { resolveFallbackToken },
      });
      expect(resolveFallbackToken).not.toHaveBeenCalled();
      expect(result.usedInstanceClaudeAuth).toBe(false);
      expect(result.resolvedConfig.env).toEqual(ownEnv);
      expect(result.secretValues.has(INSTANCE_TOKEN)).toBe(false);
    }
  });

  it("does nothing for other adapters, when no token is saved, or when no resolver is wired", async () => {
    const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
    const codex = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      adapterType: "codex_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken },
    });
    expect(resolveFallbackToken).not.toHaveBeenCalled();
    expect(codex.usedInstanceClaudeAuth).toBe(false);
    expect(codex.resolvedConfig.env).toEqual({});

    const noToken = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      adapterType: "claude_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken: vi.fn().mockResolvedValue(null) },
    });
    expect(noToken.usedInstanceClaudeAuth).toBe(false);
    expect(noToken.resolvedConfig.env).toEqual({});

    const unwired = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      adapterType: "claude_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
    });
    expect(unwired.usedInstanceClaudeAuth).toBe(false);
    expect(unwired.resolvedConfig.env).toEqual({});
  });

  it("a project-level token also counts as the agent's own credential", async () => {
    const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
    const secretsSvc = fakeSecretsSvc({});
    secretsSvc.resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-project-level-token" },
      secretKeys: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
      manifest: [],
    });
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: { env: {} },
      projectId: "project-1",
      projectEnv: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } },
      secretsSvc,
      instanceClaudeAuth: { resolveFallbackToken },
    });
    expect(resolveFallbackToken).not.toHaveBeenCalled();
    expect(result.resolvedConfig.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-project-level-token" });
  });

  it("claudeEnvHasOwnCredential mirrors the adapter's auth detection", () => {
    expect(claudeEnvHasOwnCredential({})).toBe(false);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_OAUTH_TOKEN: "   " })).toBe(false);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_OAUTH_TOKEN: "x" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ ANTHROPIC_API_KEY: "x" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ CLAUDE_CODE_USE_BEDROCK: "true" })).toBe(true);
    expect(claudeEnvHasOwnCredential({ ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock" })).toBe(true);
  });
});
