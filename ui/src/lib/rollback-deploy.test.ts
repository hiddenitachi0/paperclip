import { describe, expect, it } from "vitest";
import {
  buildOlderReleaseRollbackApproval,
  buildRollbackDeployApproval,
  olderReleaseRollbackConfirmText,
  rollbackConfirmText,
  rollbackDeployNote,
  shortSha,
} from "./rollback-deploy";

const current = { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z" };
const previous = { commit: "aaaaaaaaaaaa", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z" };
const older = { commit: "cccccccccccc", approvalId: "a0", deployedAt: "2026-08-20T10:00:00Z" };

describe("buildRollbackDeployApproval", () => {
  it("files an ordinary deploy card for the previous commit with the rollback flag set", () => {
    const input = buildRollbackDeployApproval({ projectId: "proj-1", workspaceId: "ws-1", current, previous });
    expect(input.type).toBe("request_board_approval");
    expect(input.payload).toMatchObject({
      kind: "deploy",
      projectId: "proj-1",
      workspaceId: "ws-1",
      commit: "aaaaaaaaaaaa",
      allowBackwardDeploy: true,
    });
    expect(input.payload.title).toBe("Roll production back to aaaaaaaa");
  });

  it("says in plain words what approving does, naming both versions", () => {
    const note = rollbackDeployNote(previous, current);
    expect(note).toContain("Approving moves production back to aaaaaaaa, the version that was live before bbbbbbbb");
    expect(note).not.toMatch(/allowBackwardDeploy|payload|DUR-/);
  });

  it("asks before filing and makes clear nothing changes until the card is approved", () => {
    const text = rollbackConfirmText(previous, current);
    expect(text).toContain("Nothing changes yet");
    expect(text).toContain("aaaaaaaa");
    expect(text).toContain("bbbbbbbb");
  });

  it("shortens shas to eight characters", () => {
    expect(shortSha(" 0123456789abcdef ")).toBe("01234567");
  });
});

describe("buildOlderReleaseRollbackApproval", () => {
  it("files an ordinary deploy card for an older release with the rollback flag set", () => {
    const input = buildOlderReleaseRollbackApproval({ projectId: "proj-1", workspaceId: "ws-1", current, target: older });
    expect(input.type).toBe("request_board_approval");
    expect(input.payload).toMatchObject({
      kind: "deploy",
      projectId: "proj-1",
      workspaceId: "ws-1",
      commit: "cccccccccccc",
      allowBackwardDeploy: true,
    });
    expect(input.payload.title).toBe("Roll production back to cccccccc");
    // An older release isn't literally "live right before" current -- the note must not
    // overclaim that, unlike the one-step-back rollbackDeployNote above.
    expect(input.payload.note).not.toContain("the version that was live before");
  });

  it("asks before filing and makes clear nothing changes until the card is approved", () => {
    const text = olderReleaseRollbackConfirmText(older, current);
    expect(text).toContain("Nothing changes yet");
    expect(text).toContain("cccccccc");
    expect(text).toContain("bbbbbbbb");
  });
});
