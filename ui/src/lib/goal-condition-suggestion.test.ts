import { describe, expect, it } from "vitest";
import { extractSuggestedGoalCondition } from "./goal-condition-suggestion";

describe("extractSuggestedGoalCondition", () => {
  it("returns null for empty or whitespace-only descriptions", () => {
    expect(extractSuggestedGoalCondition("")).toBeNull();
    expect(extractSuggestedGoalCondition("   \n  ")).toBeNull();
    expect(extractSuggestedGoalCondition(null)).toBeNull();
    expect(extractSuggestedGoalCondition(undefined)).toBeNull();
  });

  it("returns null when there is no acceptance section or bullet list", () => {
    expect(extractSuggestedGoalCondition("Just a plain paragraph of prose with no lists.")).toBeNull();
  });

  it("extracts bullets from a markdown acceptance criteria heading", () => {
    const description = [
      "Some context about the task.",
      "",
      "## Acceptance Criteria",
      "- All tests pass",
      "- The PR is merged",
      "",
      "## Notes",
      "- Not part of acceptance",
    ].join("\n");

    expect(extractSuggestedGoalCondition(description)).toBe("All tests pass; The PR is merged");
  });

  it("recognizes a bare 'Acceptance:' line without a markdown heading marker", () => {
    const description = [
      "Acceptance:",
      "1. Ship the button",
      "2. Add a test",
    ].join("\n");

    expect(extractSuggestedGoalCondition(description)).toBe("Ship the button; Add a test");
  });

  it("recognizes 'Definition of done' sections", () => {
    const description = ["Definition of Done", "- Deployed to prod"].join("\n");
    expect(extractSuggestedGoalCondition(description)).toBe("Deployed to prod");
  });

  it("falls back to the last bullet list when there is no acceptance section", () => {
    const description = [
      "## Background",
      "- old context bullet",
      "",
      "Some prose in between.",
      "",
      "## Plan",
      "- Do the first thing",
      "- Do the second thing",
    ].join("\n");

    expect(extractSuggestedGoalCondition(description)).toBe("Do the first thing; Do the second thing");
  });

  it("falls back to non-bullet section text when the acceptance section has no bullets", () => {
    const description = ["## Acceptance", "Everything works end to end."].join("\n");
    expect(extractSuggestedGoalCondition(description)).toBe("Everything works end to end.");
  });

  it("truncates very long suggestions", () => {
    const longBullet = "x".repeat(500);
    const description = `## Acceptance Criteria\n- ${longBullet}`;
    const result = extractSuggestedGoalCondition(description);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(400);
    expect(result!.endsWith("…")).toBe(true);
  });
});
