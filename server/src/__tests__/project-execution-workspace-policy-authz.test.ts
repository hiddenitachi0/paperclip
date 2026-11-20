import { describe, expect, it } from "vitest";
import { collectProjectExecutionWorkspaceCommandPaths } from "../routes/workspace-command-authz.js";

// DUR-5228: agent keys must not set host-run service commands or the operator's
// isolation setting through a project write.
describe("collectProjectExecutionWorkspaceCommandPaths", () => {
  it("refuses workspaceRuntime and requireIsolation (even requireIsolation: false)", () => {
    expect(
      collectProjectExecutionWorkspaceCommandPaths({
        enabled: false,
        requireIsolation: false,
        workspaceRuntime: { services: [{ name: "x", command: "id" }] },
      }),
    ).toEqual([
      "executionWorkspacePolicy.workspaceRuntime",
      "executionWorkspacePolicy.requireIsolation",
    ]);
  });

  it("still refuses strategy commands and allows ordinary fields", () => {
    expect(
      collectProjectExecutionWorkspaceCommandPaths({
        workspaceStrategy: { provisionCommand: "x", teardownCommand: "y" },
      }),
    ).toEqual([
      "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
      "executionWorkspacePolicy.workspaceStrategy.teardownCommand",
    ]);
    expect(collectProjectExecutionWorkspaceCommandPaths({ enabled: true, defaultMode: "shared_workspace" })).toEqual([]);
    expect(collectProjectExecutionWorkspaceCommandPaths(null)).toEqual([]);
  });
});
