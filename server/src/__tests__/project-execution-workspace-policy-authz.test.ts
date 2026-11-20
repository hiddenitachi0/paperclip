import { describe, expect, it } from "vitest";
import {
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectExecutionWorkspacePolicyDropPaths,
} from "../routes/workspace-command-authz.js";

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

// DUR-5231: leaving a protected field out of a replacing write drops it.
describe("collectProjectExecutionWorkspacePolicyDropPaths", () => {
  const stored = {
    enabled: true,
    requireIsolation: true,
    workspaceRuntime: { services: [{ name: "x", command: "id" }] },
    workspaceStrategy: { type: "git_worktree", provisionCommand: "p", teardownCommand: "t" },
  };
  const all = [
    "executionWorkspacePolicy.workspaceRuntime",
    "executionWorkspacePolicy.requireIsolation",
    "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
    "executionWorkspacePolicy.workspaceStrategy.teardownCommand",
  ];

  it("treats { enabled: false } as dropping every protected field", () => {
    expect(collectProjectExecutionWorkspacePolicyDropPaths({ enabled: false }, stored)).toEqual(all);
  });

  it("treats null as dropping every protected field", () => {
    expect(collectProjectExecutionWorkspacePolicyDropPaths(null, stored)).toEqual(all);
  });

  it("flags only the field that changed", () => {
    expect(
      collectProjectExecutionWorkspacePolicyDropPaths({ ...stored, requireIsolation: false }, stored),
    ).toEqual(["executionWorkspacePolicy.requireIsolation"]);
  });

  it("allows a write that keeps the protected fields, and a project with none stored", () => {
    expect(collectProjectExecutionWorkspacePolicyDropPaths({ ...stored, enabled: false }, stored)).toEqual([]);
    expect(collectProjectExecutionWorkspacePolicyDropPaths(null, { enabled: true })).toEqual([]);
    expect(collectProjectExecutionWorkspacePolicyDropPaths(null, null)).toEqual([]);
  });
});
