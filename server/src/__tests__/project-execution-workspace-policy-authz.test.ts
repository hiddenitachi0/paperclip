import { describe, expect, it } from "vitest";
import {
  collectProjectExecutionWorkspaceCommandPaths,
  carryForwardProtectedProjectPolicyFields,
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

  // DUR-5242
  it("refuses authorizationPolicy whatever its value", () => {
    for (const value of [{ protectedAgent: { requiresApproval: true } }, {}, null]) {
      expect(collectProjectExecutionWorkspaceCommandPaths({ authorizationPolicy: value })).toEqual([
        "executionWorkspacePolicy.authorizationPolicy",
      ]);
    }
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

// DUR-5231: for agent writes the stored protected fields are carried forward; only a
// different value is a change.
describe("carryForwardProtectedProjectPolicyFields", () => {
  const stored = {
    enabled: true,
    defaultMode: "isolated_workspace",
    requireIsolation: true,
    workspaceRuntime: { services: [{ name: "x", command: "id" }] },
    workspaceStrategy: { type: "git_worktree", provisionCommand: "p", teardownCommand: "t" },
  };
  const protectedOnly = {
    requireIsolation: true,
    workspaceRuntime: stored.workspaceRuntime,
    workspaceStrategy: stored.workspaceStrategy,
  };

  it("keeps every stored protected field when the agent leaves them out", () => {
    expect(carryForwardProtectedProjectPolicyFields({ enabled: true, defaultMode: "shared_workspace" }, stored)).toEqual({
      policy: { enabled: true, defaultMode: "shared_workspace", ...protectedOnly },
      changedPaths: [],
    });
  });

  it("keeps them for { enabled: false } and for null (nothing else survives null)", () => {
    expect(carryForwardProtectedProjectPolicyFields({ enabled: false }, stored)).toEqual({
      policy: { enabled: false, ...protectedOnly },
      changedPaths: [],
    });
    expect(carryForwardProtectedProjectPolicyFields(null, stored)).toEqual({
      policy: { enabled: false, ...protectedOnly },
      changedPaths: [],
    });
  });

  it("accepts the stored values sent back unchanged", () => {
    expect(carryForwardProtectedProjectPolicyFields({ ...stored, defaultMode: "shared_workspace" }, stored)).toEqual({
      policy: { ...stored, defaultMode: "shared_workspace" },
      changedPaths: [],
    });
  });

  it("adds back only the strategy command the agent left out", () => {
    const { policy, changedPaths } = carryForwardProtectedProjectPolicyFields(
      { enabled: true, workspaceStrategy: { type: "git_worktree", baseRef: "main", provisionCommand: "p" } },
      stored,
    );
    expect(changedPaths).toEqual([]);
    expect((policy as any).workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "main",
      provisionCommand: "p",
      teardownCommand: "t",
    });
  });

  it("lists each protected field the agent sets to a different value", () => {
    expect(
      carryForwardProtectedProjectPolicyFields(
        {
          enabled: true,
          requireIsolation: false,
          workspaceRuntime: { services: [] },
          workspaceStrategy: { provisionCommand: "other", teardownCommand: null },
        },
        stored,
      ).changedPaths,
    ).toEqual([
      "executionWorkspacePolicy.requireIsolation",
      "executionWorkspacePolicy.workspaceRuntime",
      "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
      "executionWorkspacePolicy.workspaceStrategy.teardownCommand",
    ]);
  });

  it("refuses an agent setting a protected field the project does not have yet", () => {
    expect(
      carryForwardProtectedProjectPolicyFields({ enabled: true, requireIsolation: true, workspaceRuntime: { services: [] } }, { enabled: true })
        .changedPaths,
    ).toEqual(["executionWorkspacePolicy.requireIsolation", "executionWorkspacePolicy.workspaceRuntime"]);
  });

  it("leaves the policy alone when nothing protected is stored", () => {
    expect(carryForwardProtectedProjectPolicyFields(null, { enabled: true })).toEqual({ policy: null, changedPaths: [] });
    expect(carryForwardProtectedProjectPolicyFields({ enabled: false }, null)).toEqual({
      policy: { enabled: false },
      changedPaths: [],
    });
  });
});

// DUR-5242: a stored authorizationPolicy is carried forward for agents; only a different value is refused.
describe("authorizationPolicy carry-forward", () => {
  const policy = { protectedAgent: { requiresApproval: true } };
  const stored = { enabled: true, authorizationPolicy: policy };
  const path = ["executionWorkspacePolicy.authorizationPolicy"];

  it("keeps it when omitted, null, or {enabled:false}", () => {
    for (const sent of [{ enabled: true }, null, { enabled: false }]) {
      const { policy: written, changedPaths } = carryForwardProtectedProjectPolicyFields(sent, stored);
      expect(changedPaths).toEqual([]);
      expect((written as any).authorizationPolicy).toEqual(policy);
    }
  });

  it("accepts the stored value sent back unchanged", () => {
    expect(carryForwardProtectedProjectPolicyFields({ ...stored }, stored).changedPaths).toEqual([]);
  });

  it("flags a rewritten, emptied or nulled policy, and one set where none is stored", () => {
    for (const sent of [{ protectedAgent: { requiresApproval: false } }, {}, null]) {
      expect(carryForwardProtectedProjectPolicyFields({ enabled: true, authorizationPolicy: sent }, stored).changedPaths).toEqual(path);
    }
    expect(carryForwardProtectedProjectPolicyFields({ enabled: true, authorizationPolicy: policy }, { enabled: true }).changedPaths).toEqual(path);
  });
});
