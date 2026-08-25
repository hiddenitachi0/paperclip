import { describe, expect, it } from "vitest";
import { isPlaceholderPromptText } from "./placeholder-prompt.js";

describe("isPlaceholderPromptText", () => {
  it("flags known placeholder tokens regardless of case or trailing punctuation", () => {
    expect(isPlaceholderPromptText("test")).toBe(true);
    expect(isPlaceholderPromptText("Test")).toBe(true);
    expect(isPlaceholderPromptText("TEST?")).toBe(true);
    expect(isPlaceholderPromptText("x")).toBe(true);
    expect(isPlaceholderPromptText("  foo  ")).toBe(true);
    expect(isPlaceholderPromptText("asdf")).toBe(true);
  });

  it("flags empty or whitespace-only text", () => {
    expect(isPlaceholderPromptText("")).toBe(true);
    expect(isPlaceholderPromptText("   ")).toBe(true);
  });

  it("flags very short text even if not on the blocklist", () => {
    expect(isPlaceholderPromptText("ab")).toBe(true);
  });

  it("does not flag real, if short, questions", () => {
    expect(isPlaceholderPromptText("Scope?")).toBe(false);
    expect(isPlaceholderPromptText("Ready?")).toBe(false);
    expect(isPlaceholderPromptText("Deploy now?")).toBe(false);
    expect(isPlaceholderPromptText("Approve the migration to prod?")).toBe(false);
  });
});
