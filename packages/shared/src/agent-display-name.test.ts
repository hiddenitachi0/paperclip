import { describe, expect, it } from "vitest";
import { formatAgentDisplayName } from "./agent-display-name.js";

describe("formatAgentDisplayName (DUR-4000)", () => {
  it("shows the job name with the person in brackets", () => {
    expect(formatAgentDisplayName({ name: "Sales agent 1" }, { displayName: "Maja" })).toBe("Sales agent 1 (Maja)");
  });

  it("shows only the job name when there is no persona", () => {
    expect(formatAgentDisplayName({ name: "Sales agent 1" }, null)).toBe("Sales agent 1");
    expect(formatAgentDisplayName({ name: "Sales agent 1" }, undefined)).toBe("Sales agent 1");
    expect(formatAgentDisplayName({ name: "Sales agent 1" }, { displayName: null })).toBe("Sales agent 1");
    expect(formatAgentDisplayName({ name: "Sales agent 1" }, { displayName: "   " })).toBe("Sales agent 1");
  });

  it("never renders 'Maja (Maja)' for an agent that was renamed to its persona before DUR-4000", () => {
    expect(formatAgentDisplayName({ name: "Maja" }, { displayName: "Maja" })).toBe("Maja");
    expect(formatAgentDisplayName({ name: "maja " }, { displayName: "Maja" })).toBe("maja ");
  });
});
