import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import { describeRunActivity } from "./run-activity";

const ts = "2026-07-05T00:00:00.000Z";

describe("describeRunActivity", () => {
  it("returns null for empty/undefined transcripts", () => {
    expect(describeRunActivity(undefined)).toBeNull();
    expect(describeRunActivity([])).toBeNull();
  });

  it("describes the most recent tool call by intent", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts, text: "Let me look at the plugin." },
      { kind: "tool_call", ts, name: "Read", input: { file_path: "packages/plugins/telegram/worker.ts" } },
    ];
    expect(describeRunActivity(entries)).toBe("Reading worker.ts");
  });

  it("summarizes a Bash command", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts, name: "Bash", input: { command: "pnpm --filter ui build" } },
    ];
    expect(describeRunActivity(entries)).toBe("Running `pnpm --filter ui build`");
  });

  it("falls back to the last assistant text when no later tool call", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts, name: "Read", input: { file_path: "a.ts" } },
      { kind: "tool_result", ts, toolUseId: "1", content: "...", isError: false },
      { kind: "assistant", ts, text: "The importer maps a single-task project to one agent." },
    ];
    expect(describeRunActivity(entries)).toBe("The importer maps a single-task project to one agent.");
  });

  it("scans past a result entry to the prior action", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts, name: "Edit", input: { file_path: "src/manifest.ts" } },
      { kind: "result", ts, text: "done", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, subtype: "success", isError: false, errors: [] },
    ];
    expect(describeRunActivity(entries)).toBe("Editing manifest.ts");
  });

  it("labels subagent delegation", () => {
    expect(describeRunActivity([{ kind: "tool_call", ts, name: "Task", input: {} }])).toBe(
      "Delegating to a subagent",
    );
  });
});
