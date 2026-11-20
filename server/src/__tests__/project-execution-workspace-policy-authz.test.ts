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
    expect(carryForwardProtectedProjectPolicyFields({ enabled: true, defaultMode: "isolated_workspace" }, stored)).toEqual({
      policy: { enabled: true, defaultMode: "isolated_workspace", ...protectedOnly },
      changedPaths: [],
    });
  });

  // DUR-5246: `enabled: false` leaves the stored fields in place but makes runs ignore them.
  it("refuses { enabled: false } and a defaultMode change while a protected field is stored", () => {
    expect(carryForwardProtectedProjectPolicyFields({ enabled: false }, stored).changedPaths).toEqual([
      "executionWorkspacePolicy.enabled",
    ]);
    expect(
      carryForwardProtectedProjectPolicyFields({ enabled: true, defaultMode: "adapter_default" }, stored).changedPaths,
    ).toEqual(["executionWorkspacePolicy.defaultMode"]);
  });

  it("for null, carries the stored switches forward too so the policy is not paused", () => {
    expect(carryForwardProtectedProjectPolicyFields(null, stored)).toEqual({
      policy: { enabled: true, defaultMode: "isolated_workspace", ...protectedOnly },
      changedPaths: [],
    });
  });

  it("does not guard enabled/defaultMode when no protected field is stored", () => {
    expect(
      carryForwardProtectedProjectPolicyFields(
        { enabled: false, defaultMode: "adapter_default" },
        { enabled: true, defaultMode: "isolated_workspace" },
      ),
    ).toEqual({ policy: { enabled: false, defaultMode: "adapter_default" }, changedPaths: [] });
  });

  it("accepts the stored values sent back unchanged", () => {
    expect(carryForwardProtectedProjectPolicyFields({ ...stored }, stored)).toEqual({
      policy: { ...stored },
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

  it("keeps it when omitted or null (and refuses {enabled:false}, which would pause it)", () => {
    for (const sent of [{ enabled: true }, null]) {
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

// DUR-5258: the stored commands only run for a typed strategy, so an agent must not drop the type.
describe("workspaceStrategy type carry-forward", () => {
  const stored = {
    enabled: true,
    workspaceStrategy: { type: "git_worktree", provisionCommand: "p" },
  };
  const typePath = "executionWorkspacePolicy.workspaceStrategy.type";

  it("keeps the stored type when the agent sends a strategy without one", () => {
    const { policy, changedPaths } = carryForwardProtectedProjectPolicyFields(
      { enabled: true, workspaceStrategy: { baseRef: "main" } },
      stored,
    );
    expect(changedPaths).toEqual([]);
    expect((policy as any).workspaceStrategy).toEqual({ baseRef: "main", type: "git_worktree", provisionCommand: "p" });
  });

  it("keeps the type when the agent sends a strategy with only its own commands left out", () => {
    const { policy } = carryForwardProtectedProjectPolicyFields(
      { enabled: true, workspaceStrategy: { provisionCommand: "p" } },
      stored,
    );
    expect((policy as any).workspaceStrategy).toEqual({ type: "git_worktree", provisionCommand: "p" });
  });

  it("refuses a different type while a command is stored, and accepts the same one", () => {
    expect(
      carryForwardProtectedProjectPolicyFields(
        { enabled: true, workspaceStrategy: { type: "project_primary" } },
        stored,
      ).changedPaths,
    ).toEqual([typePath]);
    expect(
      carryForwardProtectedProjectPolicyFields(
        { enabled: true, workspaceStrategy: { type: "git_worktree" } },
        stored,
      ).changedPaths,
    ).toEqual([]);
  });

  it("leaves the type editable when no command is stored", () => {
    const noCommand = { enabled: true, workspaceStrategy: { type: "git_worktree" } };
    const { policy, changedPaths } = carryForwardProtectedProjectPolicyFields(
      { enabled: true, workspaceStrategy: { type: "project_primary" } },
      noCommand,
    );
    expect(changedPaths).toEqual([]);
    expect((policy as any).workspaceStrategy).toEqual({ type: "project_primary" });
  });
});

// DUR-5258: a top-level trustPreset/reviewPreset is read by the trust resolver, so it is protected.
describe("top-level trustPreset / reviewPreset carry-forward", () => {
  const reviewPreset = { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" };
  const stored = { enabled: true, trustPreset: "low_trust_review", reviewPreset };

  it("keeps them when the agent leaves them out or sends null", () => {
    for (const sent of [{ enabled: true }, null]) {
      const { policy, changedPaths } = carryForwardProtectedProjectPolicyFields(sent, stored);
      expect(changedPaths).toEqual([]);
      expect((policy as any).trustPreset).toBe("low_trust_review");
      expect((policy as any).reviewPreset).toEqual(reviewPreset);
    }
  });

  it("accepts the stored values sent back unchanged", () => {
    expect(carryForwardProtectedProjectPolicyFields({ ...stored }, stored).changedPaths).toEqual([]);
  });

  it("flags a different, nulled or newly set preset", () => {
    expect(
      carryForwardProtectedProjectPolicyFields({ enabled: true, trustPreset: "standard" }, stored).changedPaths,
    ).toEqual(["executionWorkspacePolicy.trustPreset"]);
    expect(
      carryForwardProtectedProjectPolicyFields({ enabled: true, reviewPreset: null }, stored).changedPaths,
    ).toEqual(["executionWorkspacePolicy.reviewPreset"]);
    expect(
      carryForwardProtectedProjectPolicyFields({ enabled: true, trustPreset: "x" }, { enabled: true }).changedPaths,
    ).toEqual(["executionWorkspacePolicy.trustPreset"]);
  });

  it("refuses naming them on create", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths({ enabled: true, trustPreset: "x", reviewPreset: {} })).toEqual([
      "executionWorkspacePolicy.trustPreset",
      "executionWorkspacePolicy.reviewPreset",
    ]);
  });
});
