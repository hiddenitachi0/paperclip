import { describe, expect, it } from "vitest";
import {
  describeModelBoostBossReview,
  describeModelBoostConsequence,
  describeModelBoostRequest,
  formatBoostDuration,
  formatBoostMoney,
  prettyBoostEffort,
  prettyBoostModel,
} from "./model-boost.js";

describe("describeModelBoostRequest", () => {
  it("reads as one plain sentence with model, effort, money cap and time window", () => {
    expect(
      describeModelBoostRequest({
        agentName: "Backend Engineer",
        requestedModel: "opus",
        requestedEffort: "high",
        maxSpendCents: 2000,
        durationMinutes: 240,
      }),
    ).toBe("Backend Engineer asks to use Opus at high effort for this task, up to $20, for the next 4 hours");
  });

  it("handles a model-only and an effort-only ask", () => {
    expect(
      describeModelBoostRequest({ agentName: "Writer", requestedModel: "claude-opus-4-1", maxSpendCents: 1250, durationMinutes: 90 }),
    ).toBe("Writer asks to use Opus for this task, up to $12.50, for the next 1 hour 30 minutes");
    expect(
      describeModelBoostRequest({ agentName: "Writer", requestedEffort: "xhigh", maxSpendCents: 500, durationMinutes: 45 }),
    ).toBe("Writer asks to work at very high effort for this task, up to $5, for the next 45 minutes");
  });

  it("never exposes a raw money/effort token", () => {
    expect(prettyBoostModel("sonnet")).toBe("Sonnet");
    expect(prettyBoostModel("gpt-5")).toBe("gpt-5");
    expect(prettyBoostEffort("max")).toBe("maximum effort");
    expect(prettyBoostEffort("weird")).toBe("weird effort");
    expect(formatBoostMoney(0)).toBe("$0");
    expect(formatBoostDuration(1440)).toBe("24 hours");
  });
});

describe("describeModelBoostConsequence", () => {
  it("tells the operator what approve and deny each do", () => {
    const text = describeModelBoostConsequence({
      agentName: "Backend Engineer",
      requestedModel: "opus",
      maxSpendCents: 2000,
      durationMinutes: 240,
    });
    expect(text).toContain("for this task only");
    expect(text).toContain("after 4 hours or once the task has cost $20");
    expect(text).toContain("If you deny, it keeps working on its normal setting.");
  });
});

describe("describeModelBoostBossReview", () => {
  const base = {
    bossAgentId: "b",
    bossName: "Engineering Lead",
    requestedAt: "2026-09-07T10:00:00.000Z",
    deadlineAt: "2026-09-07T10:30:00.000Z",
  };

  it("says who it is waiting on and when it comes to the operator", () => {
    expect(describeModelBoostBossReview({ ...base, status: "awaiting_boss" })).toMatch(
      /^Waiting for Engineering Lead to weigh in first\. If Engineering Lead has not answered by \d\d:\d\d, it comes to you\.$/,
    );
  });

  it("carries the boss's recommendation, refusal, or silence", () => {
    expect(describeModelBoostBossReview({ ...base, status: "forwarded", note: "Worth it, the task is stuck." })).toBe(
      "Engineering Lead passed this on to you: Worth it, the task is stuck.",
    );
    expect(describeModelBoostBossReview({ ...base, status: "declined" })).toBe("Engineering Lead said no.");
    expect(describeModelBoostBossReview({ ...base, status: "timed_out" })).toBe(
      "Engineering Lead did not answer in time, so this came to you.",
    );
    expect(describeModelBoostBossReview(null)).toBeNull();
  });
});
