import { describe, expect, it, vi } from "vitest";
import { assertAgentStageConfigWorkspaceSettingsAllowed } from "../routes/pipeline-stage-workspace-authz.js";

const agent = { actor: { type: "agent", agentId: "a", companyId: "c" } } as any;
const delegate = { actor: { type: "board_delegate", userId: "u" } } as any;
const board = { actor: { type: "board", userId: "u", isInstanceAdmin: true } } as any;
const runtime = { workspaceRuntime: { services: [{ name: "x", command: "id" }] } };
const noPolicy = vi.fn(async () => null);

describe("pipeline stage workspace settings authorization (DUR-5246)", () => {
  it("refuses an agent or delegate that puts workspaceRuntime or commands in onEnter/automation", async () => {
    for (const req of [agent, delegate]) {
      for (const section of ["onEnter", "automation"]) {
        await expect(
          assertAgentStageConfigWorkspaceSettingsAllowed(req, { [section]: { executionWorkspaceSettings: runtime } }, null, noPolicy),
        ).rejects.toMatchObject({ status: 403 });
      }
    }
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { executionWorkspaceSettings: { workspaceStrategy: { provisionCommand: "id" } } } },
        null,
        noPolicy,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a board user set them", async () => {
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(board, { onEnter: { executionWorkspaceSettings: runtime } }, null, noPolicy),
    ).resolves.toBeUndefined();
  });

  it("lets an agent resend the stored value and write plain settings or none", async () => {
    const stored = { automation: { executionWorkspaceSettings: runtime } };
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(agent, { automation: { executionWorkspaceSettings: runtime } }, stored, noPolicy),
    ).resolves.toBeUndefined();
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(agent, { automation: { instructionsBody: "x" } }, stored, noPolicy),
    ).resolves.toBeUndefined();
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "p", executionWorkspaceSettings: { mode: "isolated_workspace" } } },
        null,
        noPolicy,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses an agent's settings when no project is named on the step (routine's own project applies at dispatch)", async () => {
    const loader = vi.fn(async () => null);
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { type: "run_routine", routineId: "r", executionWorkspaceSettings: { mode: "agent_default" } } },
        null,
        loader,
      ),
    ).rejects.toMatchObject({ status: 403 });
    // A board user, and an agent resending the board's stored value, are fine.
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        board,
        { onEnter: { routineId: "r", executionWorkspaceSettings: { mode: "agent_default" } } },
        null,
        loader,
      ),
    ).resolves.toBeUndefined();
    const stored = { onEnter: { routineId: "r", executionWorkspaceSettings: { mode: "agent_default" } } };
    await expect(assertAgentStageConfigWorkspaceSettingsAllowed(agent, stored, stored, loader)).resolves.toBeUndefined();
  });

  it("does not treat a changed project or routine as a round-trip", async () => {
    const protectedPolicy = {
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", provisionCommand: "pnpm i" },
    };
    const loader = vi.fn(async (id: string) => (id === "B" ? protectedPolicy : null));
    const settings = { mode: "agent_default" };
    const stored = { onEnter: { projectId: "A", routineId: "r", executionWorkspaceSettings: settings } };
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "B", routineId: "r", executionWorkspaceSettings: settings } },
        stored,
        loader,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(loader).toHaveBeenCalledWith("B");
    // Same project, new routine: re-checked against the project, which does not protect anything for A.
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "A", routineId: "r2", executionWorkspaceSettings: settings } },
        stored,
        loader,
      ),
    ).resolves.toBeUndefined();
  });

  it("reads the old mode names the way the run does", async () => {
    const loader = vi.fn(async () => ({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", provisionCommand: "pnpm i" },
    }));
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "B", executionWorkspaceSettings: { mode: "project_primary" } } },
        null,
        loader,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "B", executionWorkspaceSettings: { mode: "isolated" } } },
        null,
        loader,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses an agent's settings when the stage's project sets allowIssueOverride=false", async () => {
    const loader = vi.fn(async () => ({ enabled: true, allowIssueOverride: false }));
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { onEnter: { projectId: "p", executionWorkspaceSettings: { mode: "isolated_workspace" } } },
        null,
        loader,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(loader).toHaveBeenCalledWith("p");
  });

  it("refuses an agent's mode that would switch off the project's stored commands", async () => {
    const loader = vi.fn(async () => ({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", provisionCommand: "pnpm i" },
    }));
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { automation: { projectId: "p", executionWorkspaceSettings: { mode: "agent_default" } } },
        null,
        loader,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("refuses an agent's workspaceStrategy.type that skips the project's provision/teardown commands", async () => {
    const loader = vi.fn(async () => ({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", provisionCommand: "pnpm i" },
    }));
    for (const type of ["project_primary", "adapter_managed", "cloud_sandbox"]) {
      for (const mode of [undefined, "inherit", "reuse_existing"]) {
        await expect(
          assertAgentStageConfigWorkspaceSettingsAllowed(
            agent,
            { automation: { projectId: "p", executionWorkspaceSettings: { ...(mode ? { mode } : {}), workspaceStrategy: { type } } } },
            null,
            loader,
          ),
        ).rejects.toMatchObject({ status: 403 });
      }
    }
    // git_worktree is what the project already uses, and a board user is not bound.
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        agent,
        { automation: { projectId: "p", executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree" } } } },
        null,
        loader,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAgentStageConfigWorkspaceSettingsAllowed(
        board,
        { automation: { projectId: "p", executionWorkspaceSettings: { workspaceStrategy: { type: "project_primary" } } } },
        null,
        loader,
      ),
    ).resolves.toBeUndefined();
  });
});
