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

  // DUR-3969 acceptance test: employment must never produce an agent that
  // cannot run. A just-employed agent's adapter config is exactly this — no
  // env, no bindings, nobody wired a CLAUDE_CODE_OAUTH_TOKEN secret_ref onto
  // it — and it must still resolve a credential and report where it came from.
  it("a freshly employed agent with no wiring at all inherits the instance sign-in", async () => {
    const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "brand-new-agent",
      adapterType: "claude_local",
      executionRunConfig: {},
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken },
      processEnv: {},
    });
    expect(result.claudeCredentialSource).toBe("instance");
    expect(result.resolvedConfig.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: INSTANCE_TOKEN });
    expect(result.usedInstanceClaudeAuth).toBe(true);
  });

  // DUR-3969 no-regression gate. This is the exact production shape of the 22
  // agents that already work: adapter_config.env.CLAUDE_CODE_OAUTH_TOKEN bound
  // as {type:"secret_ref", secretId}, resolved to a real token by the secrets
  // service. Their behaviour must be identical after inheritance exists.
  it("an agent with an explicit per-agent secret binding is untouched", async () => {
    const AGENT_BOUND_TOKEN = "sk-ant-oat01-this-agents-own-client-subscription";
    const resolveFallbackToken = vi.fn().mockResolvedValue(INSTANCE_TOKEN);
    const secretsSvc = fakeSecretsSvc({ CLAUDE_CODE_OAUTH_TOKEN: AGENT_BOUND_TOKEN });
    secretsSvc.resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { CLAUDE_CODE_OAUTH_TOKEN: AGENT_BOUND_TOKEN }, model: "claude-sonnet-5" },
      secretKeys: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
      manifest: [{ envKey: "CLAUDE_CODE_OAUTH_TOKEN", secretId: "secret-1" }],
    });
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-with-binding",
      adapterType: "claude_local",
      executionRunConfig: {
        env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
      },
      projectEnv: null,
      secretsSvc,
      instanceClaudeAuth: { resolveFallbackToken },
      processEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-server-process" },
    });
    // The instance sign-in is never even read for this agent.
    expect(resolveFallbackToken).not.toHaveBeenCalled();
    expect(result.claudeCredentialSource).toBe("agent");
    expect(result.usedInstanceClaudeAuth).toBe(false);
    expect(result.resolvedConfig.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: AGENT_BOUND_TOKEN });
    expect(result.secretKeys.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(result.secretManifest).toEqual([{ envKey: "CLAUDE_CODE_OAUTH_TOKEN", secretId: "secret-1" }]);
    expect(result.secretValues.has(INSTANCE_TOKEN)).toBe(false);
  });

  it("reports the resolved source for each tier of the order", async () => {
    const own = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-with-own-token",
      adapterType: "claude_local",
      executionRunConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-agents-own" } },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-agents-own" }),
      instanceClaudeAuth: { resolveFallbackToken: vi.fn().mockResolvedValue(INSTANCE_TOKEN) },
      processEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-server-process" },
    });
    expect(own.claudeCredentialSource).toBe("agent");
    // Unchanged: the agent's own token is what runs, nothing is injected.
    expect(own.resolvedConfig.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-agents-own" });

    const processFallback = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-2",
      adapterType: "claude_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken: vi.fn().mockResolvedValue(null) },
      processEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-server-process" },
    });
    expect(processFallback.claudeCredentialSource).toBe("process_env");
    // The process env is already inherited by the spawned CLI; nothing is copied in.
    expect(processFallback.resolvedConfig.env).toEqual({});

    const nothing = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-3",
      adapterType: "claude_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken: vi.fn().mockResolvedValue(null) },
      processEnv: {},
    });
    expect(nothing.claudeCredentialSource).toBe("none");

    // Every non-Claude adapter keeps reporting "agent": it brings its own
    // credentials and the Claude sign-in never applies to it.
    const codex = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      adapterType: "codex_local",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: fakeSecretsSvc({}),
      instanceClaudeAuth: { resolveFallbackToken: vi.fn().mockResolvedValue(INSTANCE_TOKEN) },
      processEnv: {},
    });
    expect(codex.claudeCredentialSource).toBe("agent");
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
