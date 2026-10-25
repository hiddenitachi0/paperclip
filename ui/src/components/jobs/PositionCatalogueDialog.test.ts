// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { describeAddResult, describeSuggestedSetup } from "./PositionCatalogueDialog";

describe("PositionCatalogueDialog texts", () => {
  it("names the suggested model and effort in plain words", () => {
    expect(describeSuggestedSetup({ suggestedModel: "claude-haiku-5-5", suggestedEffort: "low" })).toBe(
      "Claude Haiku 5.5 (fast and low-cost), low thinking",
    );
    expect(describeSuggestedSetup({ suggestedModel: "some-other-model", suggestedEffort: "xhigh" })).toBe(
      "some-other-model, extra high thinking",
    );
  });

  it("explains what adding a position did", () => {
    expect(
      describeAddResult("Scheduler", {
        createdPosition: true,
        createdJobs: ["Find a meeting time"],
        linkedJobs: [],
        installedSkills: ["a", "b"],
        missingSkillKeys: [],
        warnings: [],
      }),
    ).toBe("Scheduler is ready to hire. 1 one-click job added. 2 skills installed.");
    expect(
      describeAddResult("Scheduler", {
        createdPosition: false,
        createdJobs: [],
        linkedJobs: [],
        installedSkills: [],
        missingSkillKeys: ["x"],
        warnings: ["Could not add the skill x: blocked."],
      }),
    ).toBe("Scheduler was already here; nothing in it was changed. Could not add the skill x: blocked.");
  });
});
