import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { buildExecutionPolicy, buildGoalConditionMonitor } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });

  it("attaches an explicit monitor override, leaving stages untouched", () => {
    const monitor = buildGoalConditionMonitor({ condition: "All tests pass" });
    expect(monitor).not.toBeNull();

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [],
      approverValues: [],
      monitor,
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(0);
    expect(policy?.monitor?.kind).toBe("goal_condition");
    expect(policy?.monitor?.condition).toBe("All tests pass");
  });

  it("keeps the existing monitor untouched when no monitor key is passed", () => {
    const existingMonitor = buildGoalConditionMonitor({ condition: "Ship it" });
    const policy = buildExecutionPolicy({
      existingPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: existingMonitor },
      reviewerValues: [],
      approverValues: [],
    });

    expect(policy?.monitor?.condition).toBe("Ship it");
  });

  it("clears the monitor when explicitly passed null", () => {
    const existingMonitor = buildGoalConditionMonitor({ condition: "Ship it" });
    const policy = buildExecutionPolicy({
      existingPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: existingMonitor },
      reviewerValues: [],
      approverValues: [],
      monitor: null,
    });

    expect(policy).toBeNull();
  });
});

describe("buildGoalConditionMonitor", () => {
  it("returns null when the condition is blank", () => {
    expect(buildGoalConditionMonitor({ condition: "   " })).toBeNull();
  });

  it("builds a schema-valid goal_condition monitor with optional bounds", () => {
    const monitor = buildGoalConditionMonitor({
      condition: "All tests pass and the PR is merged",
      evaluatorModelProfile: "cheap",
      spendCapCents: 500,
      maxAttempts: 5,
    });

    expect(monitor).not.toBeNull();
    expect(monitor?.kind).toBe("goal_condition");
    expect(monitor?.condition).toBe("All tests pass and the PR is merged");
    expect(monitor?.evaluatorModelProfile).toBe("cheap");
    expect(monitor?.spendCapCents).toBe(500);
    expect(monitor?.maxAttempts).toBe(5);
    expect(issueExecutionPolicySchema.shape.monitor.safeParse(monitor).success).toBe(true);
  });
});
