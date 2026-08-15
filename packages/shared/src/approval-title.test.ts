import { describe, expect, it } from "vitest";
import {
  formatApprovalTechnicalReference,
  formatApprovalTitle,
  stripLegacyTitlePrefix,
} from "./approval-title.js";

describe("formatApprovalTitle", () => {
  it("composes '<project> — <what this does>'", () => {
    expect(formatApprovalTitle("Nordstrand dashboard", "put the 2026 look live")).toBe(
      "Nordstrand dashboard — put the 2026 look live",
    );
  });

  it("strips a legacy 'Merge PR #N —' prefix so it never doubles up", () => {
    expect(formatApprovalTitle("Paperclip", "Merge PR #4 — the 2026 dashboard overhaul")).toBe(
      "Paperclip — the 2026 dashboard overhaul",
    );
  });

  it("strips bare '#N —' and 'PR #N:' prefixes", () => {
    expect(formatApprovalTitle("Paperclip", "#7 - fix the login bug")).toBe(
      "Paperclip — fix the login bug",
    );
    expect(formatApprovalTitle("Paperclip", "PR #12: sub-tasks inherit model/effort")).toBe(
      "Paperclip — sub-tasks inherit model/effort",
    );
  });

  it("falls back to just the project label when there is no body text", () => {
    expect(formatApprovalTitle("Paperclip", "")).toBe("Paperclip");
  });

  it("falls back to 'Paperclip' when the project label is blank", () => {
    expect(formatApprovalTitle("  ", "ship the fix")).toBe("Paperclip — ship the fix");
  });
});

describe("stripLegacyTitlePrefix", () => {
  it("is a no-op on already-plain text", () => {
    expect(stripLegacyTitlePrefix("put the 2026 look live")).toBe("put the 2026 look live");
  });
});

describe("formatApprovalTechnicalReference", () => {
  it("builds a secondary line from repo + PR number", () => {
    expect(formatApprovalTechnicalReference({ repo: "fork", prNumber: 12 })).toBe(
      "Technical reference: fork repo, pull request #12",
    );
  });

  it("includes branch, base, and a truncated commit when present", () => {
    expect(
      formatApprovalTechnicalReference({
        repo: "fork",
        prNumber: 4,
        branch: "feat/thing",
        base: "custom",
        commit: "abcdef0123456789",
      }),
    ).toBe(
      "Technical reference: fork repo, pull request #4, branch feat/thing, into custom, commit abcdef012345",
    );
  });

  it("returns null when there is nothing technical to show", () => {
    expect(formatApprovalTechnicalReference({})).toBeNull();
  });
});
