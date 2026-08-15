import { describe, expect, it } from "vitest";
import { describeRunLiveness, STALL_THRESHOLD_MINUTES } from "./runLiveness";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("describeRunLiveness", () => {
  it("returns null when there is no run", () => {
    expect(describeRunLiveness(null)).toBeNull();
    expect(describeRunLiveness(undefined)).toBeNull();
  });

  it("reports recent activity in plain language when well under the stall threshold", () => {
    const info = describeRunLiveness({ lastOutputAt: minutesAgo(3) });
    expect(info).not.toBeNull();
    expect(info!.stalled).toBe(false);
    expect(info!.text).toMatch(/^working — last activity/);
    expect(info!.text).not.toMatch(/lastOutputAt|run/i);
  });

  it("prefers the most recent of last output and last useful action", () => {
    const info = describeRunLiveness({
      lastOutputAt: minutesAgo(10),
      lastUsefulActionAt: minutesAgo(2),
    });
    expect(info!.stalled).toBe(false);
  });

  it("falls back to startedAt when no activity timestamps are set", () => {
    const info = describeRunLiveness({ startedAt: minutesAgo(1) });
    expect(info!.stalled).toBe(false);
    expect(info!.text).toMatch(/last activity/);
  });

  it("flags a stall once quiet for at least the threshold", () => {
    const info = describeRunLiveness({ lastOutputAt: minutesAgo(STALL_THRESHOLD_MINUTES) });
    expect(info!.stalled).toBe(true);
    expect(info!.text).toBe("has been quiet for 15 minutes — might be stuck");
  });

  it("formats long stalls in hours", () => {
    const info = describeRunLiveness({ lastOutputAt: minutesAgo(125) });
    expect(info!.stalled).toBe(true);
    expect(info!.text).toBe("has been quiet for 2 hours 5 min — might be stuck");
  });

  it("stays under the threshold just before it", () => {
    const info = describeRunLiveness({ lastOutputAt: minutesAgo(STALL_THRESHOLD_MINUTES - 1) });
    expect(info!.stalled).toBe(false);
  });
});
