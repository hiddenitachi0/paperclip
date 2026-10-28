import type { Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { selectAssignedToYou } from "./assigned-to-you";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    status: "todo",
    assigneeUserId: "user-1",
    assigneeAgentId: null,
    hiddenAt: null,
    updatedAt: new Date("2026-10-28T08:00:00.000Z"),
    ...overrides,
  } as Issue;
}

describe("selectAssignedToYou", () => {
  it("keeps open tasks assigned to the user", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked"] as const) {
      expect(selectAssignedToYou([issue({ status })], "user-1", new Set())).toHaveLength(1);
    }
  });

  it("drops backlog, finished, hidden, agent-owned and other people's tasks", () => {
    const result = selectAssignedToYou(
      [
        issue({ id: "a", status: "backlog" }),
        issue({ id: "b", status: "done" }),
        issue({ id: "c", status: "cancelled" }),
        issue({ id: "d", hiddenAt: new Date() }),
        issue({ id: "e", assigneeUserId: null, assigneeAgentId: "agent-1" }),
        issue({ id: "f", assigneeUserId: "user-2" }),
      ],
      "user-1",
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("drops tasks another source already shows", () => {
    const result = selectAssignedToYou([issue({ id: "a" }), issue({ id: "b" })], "user-1", new Set(["a"]));
    expect(result.map((i) => i.id)).toEqual(["b"]);
  });

  it("puts the most recently changed task first", () => {
    const result = selectAssignedToYou(
      [
        issue({ id: "old", updatedAt: new Date("2026-10-01T00:00:00.000Z") }),
        issue({ id: "new", updatedAt: new Date("2026-10-28T00:00:00.000Z") }),
      ],
      "user-1",
      new Set(),
    );
    expect(result.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("trusts the server's narrowing when the user id is not known yet", () => {
    expect(selectAssignedToYou([issue()], null, new Set())).toHaveLength(1);
  });
});
