import { describe, expect, it, vi } from "vitest";
import {
  attemptStatusOnlyEscalation,
  buildStatusOnlyEscalationIdempotencyKey,
} from "./status-only-escalation.js";

function fakeDb(existingRows: unknown[] = []) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve(existingRows),
          })),
        })),
      })),
    })),
  } as any;
}

describe("status-only recovery escalation (DUR-45)", () => {
  it("builds a per-issue idempotency key, not per-run", () => {
    expect(buildStatusOnlyEscalationIdempotencyKey({ issueId: "issue-1" })).toBe(
      "status_only_recovery_escalated_to_normal_model:issue-1",
    );
  });

  it("enqueues a normal-model wake and posts a comment the first time an issue hits the wall", async () => {
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: "wake-1" });
    const addComment = vi.fn().mockResolvedValue({ id: "comment-1" });

    const result = await attemptStatusOnlyEscalation(fakeDb([]), enqueueWakeup, addComment, {
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      blockedAction: "create or modify approvals",
    });

    expect(result).toEqual({ escalated: true, reason: "escalation wake queued" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [agentId, opts] = enqueueWakeup.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(opts.idempotencyKey).toBe("status_only_recovery_escalated_to_normal_model:issue-1");
    // withRecoveryModelProfileHint(..., "normal_model") scrubs the cheap/status_only hints
    // rather than setting them -- this wake must NOT itself be status-only, or nothing changes.
    expect(opts.payload.modelProfile).toBeUndefined();
    expect(opts.payload.recoveryIntent).toBeUndefined();
    expect(opts.contextSnapshot.modelProfile).toBeUndefined();
    expect(opts.contextSnapshot.resumeRequiresNormalModel).toBeUndefined();
    expect(opts.contextSnapshot.issueId).toBe("issue-1");

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment.mock.calls[0][0]).toBe("issue-1");
  });

  it("is bounded to one escalation per issue -- skips if a wake already exists", async () => {
    const enqueueWakeup = vi.fn();
    const addComment = vi.fn();

    const result = await attemptStatusOnlyEscalation(
      fakeDb([{ id: "existing-wake", status: "queued" }]),
      enqueueWakeup,
      addComment,
      {
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-2",
        issueId: "issue-1",
        blockedAction: "update issue documents, plans, or deliverable artifacts",
      },
    );

    expect(result).toEqual({ escalated: false, reason: "already escalated once for this issue" });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });
});
