import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "claude-opus-5",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildClaudeLocalConfig", () => {
  it("parses mcpServersJson into adapterConfig.mcpServers", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        mcpServersJson: JSON.stringify([{ name: "higgsfield", url: "https://mcp.higgsfield.ai" }]),
      }),
    );

    expect(config.mcpServers).toEqual([{ name: "higgsfield", url: "https://mcp.higgsfield.ai" }]);
  });

  it("omits mcpServers when mcpServersJson is blank, empty, or not an array", () => {
    expect(buildClaudeLocalConfig(makeValues({ mcpServersJson: "" }))).not.toHaveProperty("mcpServers");
    expect(buildClaudeLocalConfig(makeValues({ mcpServersJson: "[]" }))).not.toHaveProperty("mcpServers");
    expect(buildClaudeLocalConfig(makeValues({ mcpServersJson: '{"name":"fs"}' }))).not.toHaveProperty("mcpServers");
    expect(buildClaudeLocalConfig(makeValues({ mcpServersJson: "not json" }))).not.toHaveProperty("mcpServers");
  });
});
