import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.4",
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

describe("buildCodexLocalConfig", () => {
  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });

  it("parses mcpServersJson into adapterConfig.mcpServers", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        mcpServersJson: JSON.stringify([{ name: "fs", command: "npx", args: ["-y", "server"] }]),
      }),
    );

    expect(config.mcpServers).toEqual([{ name: "fs", command: "npx", args: ["-y", "server"] }]);
  });

  it("omits mcpServers when mcpServersJson is blank, empty, or not an array", () => {
    expect(buildCodexLocalConfig(makeValues({ mcpServersJson: "" }))).not.toHaveProperty("mcpServers");
    expect(buildCodexLocalConfig(makeValues({ mcpServersJson: "[]" }))).not.toHaveProperty("mcpServers");
    expect(buildCodexLocalConfig(makeValues({ mcpServersJson: '{"name":"fs"}' }))).not.toHaveProperty("mcpServers");
    expect(buildCodexLocalConfig(makeValues({ mcpServersJson: "not json" }))).not.toHaveProperty("mcpServers");
  });
});
