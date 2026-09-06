// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalConditionLoopCard } from "./GoalConditionLoopCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Ship the feature",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [],
    },
    executionState: null,
    monitorNextCheckAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-11T10:00:00.000Z"),
    updatedAt: new Date("2026-04-11T10:00:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

describe("GoalConditionLoopCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders nothing when the issue has no goal condition monitor", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<GoalConditionLoopCard issue={createIssue()} />);
    });

    expect(container.textContent).toBe("");
    act(() => root.unmount());
  });

  it("uses the unified 'Goal' label and shows the condition, round, and verdict", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <GoalConditionLoopCard
          issue={createIssue({
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: {
                status: "scheduled",
                nextCheckAt: null,
                lastTriggeredAt: null,
                attemptCount: 2,
                maxAttempts: 5,
                notes: null,
                scheduledBy: "board",
                kind: "goal_condition",
                condition: "All tests pass and the PR is merged",
                clearedAt: null,
                clearReason: null,
                lastVerdict: "not_met",
                lastVerdictReason: "The PR is still open.",
                spentCentsAtLastVerdict: 250,
                spendCapCents: 1000,
              },
            },
          })}
        />,
      );
    });

    // Unified naming: "Goal", never the old "Finish line" / "Goal condition" copy.
    expect(container.textContent).toContain("Goal");
    expect(container.textContent).not.toContain("Finish line");
    expect(container.textContent).not.toContain("Goal condition");

    expect(container.textContent).toContain("All tests pass and the PR is merged");
    expect(container.textContent).toContain("Round 2 of 5");
    expect(container.textContent).toContain("Independent check: not met yet");
    expect(container.textContent).toContain("Judge said: The PR is still open.");

    act(() => root.unmount());
  });

  it("shows the judge's reason even when the verdict is 'met'", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <GoalConditionLoopCard
          issue={createIssue({
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: {
                status: "cleared",
                nextCheckAt: null,
                lastTriggeredAt: null,
                attemptCount: 1,
                maxAttempts: null,
                notes: null,
                scheduledBy: "board",
                kind: "goal_condition",
                condition: "All tests pass and the PR is merged",
                clearedAt: "2026-04-11T12:00:00.000Z",
                clearReason: "goal_condition_met",
                lastVerdict: "met",
                lastVerdictReason: "All tests are green and the PR was merged in #42.",
                spentCentsAtLastVerdict: 120,
                spendCapCents: null,
              },
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Independent check: met");
    // The reason should be visible regardless of the verdict value — previously this only
    // rendered when the verdict was "not_met", hiding the judge's reasoning on success too.
    expect(container.textContent).toContain("Judge said: All tests are green and the PR was merged in #42.");

    act(() => root.unmount());
  });
});
