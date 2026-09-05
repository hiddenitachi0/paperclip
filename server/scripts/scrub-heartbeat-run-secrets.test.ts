import { describe, expect, it } from "vitest";
import { computeScrub } from "./scrub-heartbeat-run-secrets.js";

describe("computeScrub", () => {
  it("flags and redacts a row with a leaked github_pat in stdoutExcerpt", () => {
    const row = {
      id: "39f285c4-955f-41a8-a2a7-4b26919b24bc",
      error: null,
      stdoutExcerpt:
        "remote: fatal: could not read Username for 'https://x-access-token:github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com'",
      stderrExcerpt: null,
      resultJson: null,
    };

    const result = computeScrub(row);

    expect(result.changed).toBe(true);
    expect(result.patch.stdoutExcerpt).toContain("[REDACTED:github_pat]");
    expect(result.patch.stdoutExcerpt).not.toContain("github_pat_11AAAAAAA0");
    expect(result.patch.error).toBeUndefined();
    expect(result.patch.stderrExcerpt).toBeUndefined();
    expect(result.patch.resultJson).toBeUndefined();
  });

  it("is a no-op (byte-for-byte, empty patch) for a row with no matching secret pattern", () => {
    const row = {
      id: "healthy-row",
      error: "agent exited cleanly",
      stdoutExcerpt: "build succeeded",
      stderrExcerpt: null,
      resultJson: { summary: "ok", cost_usd: 0.12 },
    };

    const result = computeScrub(row);

    expect(result.changed).toBe(false);
    expect(result.patch).toEqual({});
  });

  it("redacts a nested secret inside resultJson", () => {
    const row = {
      id: "nested-row",
      error: null,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      resultJson: {
        summary: "done",
        nested: { detail: "slack token xoxb-test-fixture-not-a-real-token-000000 leaked" },
      },
    };

    const result = computeScrub(row);

    expect(result.changed).toBe(true);
    expect(result.patch.resultJson).toEqual({
      summary: "done",
      nested: { detail: "slack token [REDACTED:slack_bot_token] leaked" },
    });
  });

  it("is idempotent: re-running computeScrub against an already-scrubbed row is a no-op", () => {
    const row = {
      id: "already-scrubbed",
      error: "push failed: [REDACTED:github_token]",
      stdoutExcerpt: null,
      stderrExcerpt: null,
      resultJson: null,
    };

    expect(computeScrub(row).changed).toBe(false);
  });
});
