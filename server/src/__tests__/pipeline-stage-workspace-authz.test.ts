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
        { onEnter: { executionWorkspaceSettings: { mode: "isolated_workspace" } } },
        null,
        noPolicy,
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
});
