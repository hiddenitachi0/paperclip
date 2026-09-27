import { describe, expect, it } from "vitest";
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "@paperclipai/adapter-utils/server-utils";
import { buildClaudePromptForAttempt } from "./execute.js";

/**
 * DUR-4004: a full agent learns about its "API with a key" tools from one
 * prompt section the heartbeat put in context.paperclipApiToolsMarkdown. It
 * sits after the task context and before the standing template, is sent on
 * a fresh session and on a resume alike (the agent's tools do not change
 * with the wake), and costs nothing when the agent has none.
 */

const NOTE = [
  "## Tools with a key (API tools)",
  "",
  "### Fal.ai (toolId 33333333-3333-4333-8333-333333333333) - Makes images",
  "- make_image: POST /fal-ai/flux/dev - Make an image. Inputs: prompt (string, required).",
].join("\n");

function build(overrides: Partial<Parameters<typeof buildClaudePromptForAttempt>[0]> = {}) {
  return buildClaudePromptForAttempt({
    resumeSessionId: null,
    bootstrapPromptTemplate: "",
    promptTemplate: DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
    templateData: { agent: { id: "a1", name: "Builder" } },
    wakePayload: undefined,
    sessionHandoffNote: "",
    taskContextNote: "## Task\n\nBuild the thing.",
    taskContextResumeNote: "",
    taskContextFingerprint: null,
    sessionTaskContextFingerprint: "",
    personaChars: 0,
    ...overrides,
  });
}

describe("claude-local prompt: the API tools section", () => {
  it("is absent, and counted as zero, when the agent has no API tools", () => {
    const { prompt, promptMetrics } = build();
    expect(prompt).not.toContain("Tools with a key");
    expect(promptMetrics.apiToolsChars).toBe(0);
    expect(prompt).toBe(build({ apiToolsNote: "   " }).prompt);
  });

  it("sits between the task context and the standing template on a fresh session", () => {
    const { prompt, promptMetrics } = build({ apiToolsNote: NOTE });
    const task = prompt.indexOf("Build the thing.");
    const note = prompt.indexOf("## Tools with a key");
    const template = prompt.indexOf("You are agent a1 (Builder)");
    expect(task).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(task);
    expect(template).toBeGreaterThan(note);
    expect(prompt).toContain("make_image: POST /fal-ai/flux/dev");
    expect(promptMetrics.apiToolsChars).toBe(NOTE.length);
  });

  it("is still sent on a resumed session with a wake delta", () => {
    const { prompt } = build({
      resumeSessionId: "11111111-2222-4333-8444-555555555555",
      apiToolsNote: NOTE,
      wakePayload: { reason: "comment", issue: { id: "i1", identifier: "T-1", title: "Thing" }, comments: [], includedCount: 0, requestedCount: 0, latestCommentId: null, fallbackFetchNeeded: false },
    });
    expect(prompt).toContain("## Tools with a key");
  });
});
