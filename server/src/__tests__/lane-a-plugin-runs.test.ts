import { describe, expect, it } from "vitest";
import {
  activeLaneAPluginRunCount,
  findLaneAPluginRun,
  laneAPluginRunNamesIssue,
  openLaneAPluginRun,
} from "../services/lane-a-plugin-runs.js";

/**
 * The quick agent's plugin tool run: one host-issued id per tool call, gone
 * once the call is over, and the one place that knows what the PERSON said
 * this turn — so a task reference planted in a file or a lookup the agent
 * read cannot pass as the person's own words.
 */

function open(message = "hello") {
  return openLaneAPluginRun({
    agentId: "agent-1",
    companyId: "company-1",
    conversationId: "conv-1",
    requestedByUserId: "user-1",
    requestedByAgentId: null,
    requesterMessage: message,
  });
}

describe("openLaneAPluginRun / findLaneAPluginRun", () => {
  it("resolves only while the call is open, and closing twice is harmless", () => {
    const before = activeLaneAPluginRunCount();
    const { run, close } = open("make a picture");
    expect(findLaneAPluginRun(run.runId)).toMatchObject({
      agentId: "agent-1",
      companyId: "company-1",
      requestedByUserId: "user-1",
      requesterMessage: "make a picture",
    });
    expect(activeLaneAPluginRunCount()).toBe(before + 1);
    close();
    close();
    expect(findLaneAPluginRun(run.runId)).toBeNull();
    expect(activeLaneAPluginRunCount()).toBe(before);
    expect(findLaneAPluginRun("not-a-run")).toBeNull();
  });
});

describe("laneAPluginRunNamesIssue", () => {
  const issue = { id: "5f1c2a3e-1111-4222-8333-444444444444", identifier: "DUR-12" };

  it("matches the task's reference as a whole word, in any case, and its id", () => {
    expect(laneAPluginRunNamesIssue({ requesterMessage: "a cat picture for DUR-12 please" }, issue)).toBe(true);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "attach to dur-12." }, issue)).toBe(true);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "(DUR-12)" }, issue)).toBe(true);
    expect(laneAPluginRunNamesIssue({ requesterMessage: `task ${issue.id}` }, issue)).toBe(true);
  });

  it("does not match a longer reference, a substring, an empty message, or a task with no reference", () => {
    expect(laneAPluginRunNamesIssue({ requesterMessage: "for DUR-123" }, issue)).toBe(false);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "for DUR-1" }, issue)).toBe(false);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "xDUR-12" }, issue)).toBe(false);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "" }, issue)).toBe(false);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "anything" }, { id: issue.id, identifier: null })).toBe(false);
  });

  it("treats a reference with regex characters literally", () => {
    expect(laneAPluginRunNamesIssue({ requesterMessage: "see A.B-1 now" }, { id: "9a9a9a9a-0000-4000-8000-000000000009", identifier: "A.B-1" })).toBe(true);
    expect(laneAPluginRunNamesIssue({ requesterMessage: "see AxB-1 now" }, { id: "9a9a9a9a-0000-4000-8000-000000000009", identifier: "A.B-1" })).toBe(false);
  });
});
