import { describe, expect, it } from "vitest";
import {
  findLatestSimpleModeReply,
  isSimpleModeSettled,
  sanitizeSimpleModeText,
  selectSimpleModeAssignee,
} from "./simple-mode";

describe("isSimpleModeSettled", () => {
  it("treats done, cancelled, blocked, and in_review as settled", () => {
    expect(isSimpleModeSettled("done")).toBe(true);
    expect(isSimpleModeSettled("cancelled")).toBe(true);
    expect(isSimpleModeSettled("blocked")).toBe(true);
    expect(isSimpleModeSettled("in_review")).toBe(true);
  });

  it("treats backlog, todo, and in_progress as still working", () => {
    expect(isSimpleModeSettled("backlog")).toBe(false);
    expect(isSimpleModeSettled("todo")).toBe(false);
    expect(isSimpleModeSettled("in_progress")).toBe(false);
  });
});

describe("selectSimpleModeAssignee", () => {
  it("prefers an available CEO", () => {
    const agents = [
      { id: "1", role: "engineer", status: "active" },
      { id: "2", role: "ceo", status: "active" },
    ];
    expect(selectSimpleModeAssignee(agents)?.id).toBe("2");
  });

  it("falls back to any available agent when the CEO is unavailable", () => {
    const agents = [
      { id: "1", role: "ceo", status: "terminated" },
      { id: "2", role: "engineer", status: "active" },
    ];
    expect(selectSimpleModeAssignee(agents)?.id).toBe("2");
  });

  it("returns null with no agents", () => {
    expect(selectSimpleModeAssignee([])).toBeNull();
    expect(selectSimpleModeAssignee(null)).toBeNull();
  });

  it("falls back to the first agent when everyone is unavailable", () => {
    const agents = [
      { id: "1", role: "engineer", status: "paused" },
      { id: "2", role: "engineer", status: "terminated" },
    ];
    expect(selectSimpleModeAssignee(agents)?.id).toBe("1");
  });
});

describe("sanitizeSimpleModeText", () => {
  it("strips ticket ids, PR references, and commit hashes", () => {
    const input = "Fixed in DUR-212 via PR #118, see commit 9c3101d9be7ac0 for details (#42).";
    const sanitized = sanitizeSimpleModeText(input);
    expect(sanitized).not.toMatch(/DUR-212/);
    expect(sanitized).not.toMatch(/PR #118/);
    expect(sanitized).not.toMatch(/#42/);
    expect(sanitized).not.toMatch(/9c3101d9be7ac0/);
  });

  it("leaves plain language untouched", () => {
    const input = "Here is the friendlier product description you asked for.";
    expect(sanitizeSimpleModeText(input)).toBe(input);
  });

  it("collapses leftover whitespace from stripped tokens", () => {
    const sanitized = sanitizeSimpleModeText("Done, see PR #118 for the change.");
    expect(sanitized).toBe("Done, see for the change.");
  });
});

describe("findLatestSimpleModeReply", () => {
  it("returns the newest non-deleted agent comment", () => {
    const comments = [
      { authorType: "user" as const, body: "request", createdAt: "2026-01-01T00:00:00Z", deletedAt: null },
      { authorType: "agent" as const, body: "old reply", createdAt: "2026-01-01T00:01:00Z", deletedAt: null },
      { authorType: "agent" as const, body: "new reply", createdAt: "2026-01-01T00:02:00Z", deletedAt: null },
      { authorType: "agent" as const, body: "deleted reply", createdAt: "2026-01-01T00:03:00Z", deletedAt: "2026-01-01T00:04:00Z" },
    ];
    expect(findLatestSimpleModeReply(comments)?.body).toBe("new reply");
  });

  it("returns null when there are no agent replies", () => {
    expect(findLatestSimpleModeReply([{ authorType: "user" as const, body: "x", createdAt: "2026-01-01", deletedAt: null }])).toBeNull();
    expect(findLatestSimpleModeReply([])).toBeNull();
    expect(findLatestSimpleModeReply(null)).toBeNull();
  });
});
