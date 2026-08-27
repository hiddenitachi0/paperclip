import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("DUR-257: adapter_failed is off the transient-infra auto-retry list", () => {
  it("adapter_failed classifies as default (1 attempt, no backoff), not transient_infra", () => {
    // adapter_failed is the catch-all for "we don't know what happened" (see
    // heartbeat-stop-metadata.ts buildFallbackErrorCode). Retrying it 3x on a 60s
    // backoff, per case, per agent, is what turned a full-disk incident into a
    // platform-wide outage on 2026-08-25: one root cause surfaced as several error
    // codes across many runs/agents in minutes, and each was retried three times,
    // multiplying log writes onto a disk that was already full.
    const c = classifyContinuationFailure(run("adapter_failed"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBe(1);
    expect(c.baseBackoffMs).toBe(0);
  });

  it("known transient-upstream codes still get the transient_infra retry budget", () => {
    for (const code of ["codex_transient_upstream", "claude_transient_upstream", "timeout"]) {
      const c = classifyContinuationFailure(run(code));
      expect(c.kind).toBe("transient_infra");
      expect(c.maxAttempts).toBeGreaterThan(1);
      expect(c.baseBackoffMs).toBeGreaterThan(0);
    }
  });
});
