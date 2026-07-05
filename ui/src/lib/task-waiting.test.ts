import { describe, expect, it } from "vitest";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { classifyTaskWaiting } from "./task-waiting";

function issue(partial: Partial<Issue>): Issue {
  return partial as Issue;
}

function attention(over: Partial<IssueBlockedInboxAttention>): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "blocked",
    reason: "pending_user_decision",
    severity: "high",
    stoppedSinceAt: null,
    owner: { type: "user", agentId: null, userId: "u1", label: "You" },
    action: { label: "Needs decision", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    ...over,
  } as IssueBlockedInboxAttention;
}

describe("classifyTaskWaiting", () => {
  it("owner=user → waiting on you", () => {
    const r = classifyTaskWaiting(issue({ blockedInboxAttention: attention({}) }));
    expect(r.waitingOn).toBe("you");
    expect(r.label).toBe("Needs decision");
  });

  it("owner=agent → waiting on that agent (with name)", () => {
    const r = classifyTaskWaiting(
      issue({
        blockedInboxAttention: attention({
          owner: { type: "agent", agentId: "a1", userId: null, label: "Copywriter" },
          action: { label: "Parked blocker", detail: null },
        }),
      }),
    );
    expect(r.waitingOn).toBe("agent");
    expect(r.ownerLabel).toBe("Copywriter");
  });

  it("owner=external → external", () => {
    const r = classifyTaskWaiting(
      issue({ blockedInboxAttention: attention({ owner: { type: "external", agentId: null, userId: null, label: null } }) }),
    );
    expect(r.waitingOn).toBe("external");
  });

  it("owner=unknown stalled chain → parked, not you (unattributed ≠ human action)", () => {
    const r = classifyTaskWaiting(
      issue({
        blockedInboxAttention: attention({
          reason: "blocked_chain_stalled",
          owner: { type: "unknown", agentId: null, userId: null, label: null },
          action: { label: "Inspect blocker chain", detail: null },
        }),
      }),
    );
    expect(r.waitingOn).toBe("unknown");
    expect(r.label).toBe("Inspect blocker chain");
  });

  it("owner=unknown but parked behind a backlog task → another agent", () => {
    const r = classifyTaskWaiting(
      issue({
        blockedInboxAttention: attention({
          reason: "blocked_by_assigned_backlog_issue",
          owner: { type: "unknown", agentId: null, userId: null, label: null },
        }),
      }),
    );
    expect(r.waitingOn).toBe("agent");
  });

  it("manual block with a blocker → waiting on another agent", () => {
    const r = classifyTaskWaiting(issue({ blockedInboxAttention: null, blockedBy: [{ id: "x" }] as Issue["blockedBy"] }));
    expect(r.waitingOn).toBe("agent");
  });

  it("manual block, no blocker, no attention → parked, not you (the DUR-3/DUR-4 case)", () => {
    const r = classifyTaskWaiting(issue({ blockedInboxAttention: null, blockedBy: [] as Issue["blockedBy"] }));
    expect(r.waitingOn).toBe("unknown");
    expect(r.label).toBe("Parked");
  });
});
