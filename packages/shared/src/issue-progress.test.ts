import { describe, expect, it } from "vitest";
import { computeIssueProgress } from "./issue-progress.js";

const start = new Date("2026-01-01T10:00:00Z");
const at = (h: number) => new Date(start.getTime() + h * 3_600_000);

describe("computeIssueProgress", () => {
  it("weights S/M/L as 1/2/3 and unsized as 1", () => {
    const p = computeIssueProgress({
      children: [
        { status: "done", sizeLabel: "L" },
        { status: "todo", sizeLabel: "M" },
        { status: "todo", sizeLabel: "S" },
        { status: "todo" },
        { status: "cancelled", sizeLabel: "L" },
      ],
      startedAt: start,
      now: at(1),
    });
    expect(p.completedWeight).toBe(3);
    expect(p.totalWeight).toBe(7);
    expect(p.percent).toBe(43);
    expect(p.totalCount).toBe(4);
  });

  it("returns zero percent with no children", () => {
    const p = computeIssueProgress({ children: [], startedAt: start, now: at(1) });
    expect(p.percent).toBe(0);
    expect(p.etaAt).toBeNull();
  });

  it("shows no ETA until 2 sub-tasks are done", () => {
    const one = computeIssueProgress({
      children: [{ status: "done" }, { status: "todo" }, { status: "todo" }],
      startedAt: start,
      now: at(1),
    });
    expect(one.etaAt).toBeNull();
    expect(one.etaLabel).toBeNull();
  });

  it("derives ETA from actual elapsed pace", () => {
    // 2 of 4 weight done in 2h -> 2h remaining
    const p = computeIssueProgress({
      children: [{ status: "done" }, { status: "done" }, { status: "todo" }, { status: "todo" }],
      startedAt: start,
      now: at(2),
    });
    expect(p.etaAt?.getTime()).toBe(at(4).getTime());
    expect(p.etaLabel).toMatch(/^about 2 h left \(≈ \d\d:\d\d\)$/);
  });

  it("uses weights in the pace projection", () => {
    // done weight 3 (S+M) in 3h; remaining weight 3 -> 3h
    const p = computeIssueProgress({
      children: [
        { status: "done", sizeLabel: "S" },
        { status: "done", sizeLabel: "M" },
        { status: "todo", sizeLabel: "L" },
      ],
      startedAt: start,
      now: at(3),
    });
    expect(p.etaAt?.getTime()).toBe(at(6).getTime());
  });

  it("has no ETA when everything is done or startedAt is missing", () => {
    const done = computeIssueProgress({
      children: [{ status: "done" }, { status: "done" }],
      startedAt: start,
      now: at(2),
    });
    expect(done.percent).toBe(100);
    expect(done.etaAt).toBeNull();
    const noStart = computeIssueProgress({
      children: [{ status: "done" }, { status: "done" }, { status: "todo" }],
      startedAt: null,
      now: at(2),
    });
    expect(noStart.etaAt).toBeNull();
  });

  it("detects plan growth and the percent steps back", () => {
    const before = computeIssueProgress({
      children: [
        { status: "done" }, { status: "done" }, { status: "done" },
        { status: "todo" }, { status: "todo" }, { status: "todo" }, { status: "todo" },
      ],
      startedAt: start,
      now: at(3),
    });
    expect(before.planGrew).toBe(false);
    expect(before.percent).toBe(43);
    const after = computeIssueProgress({
      children: [
        { status: "done" }, { status: "done" }, { status: "done" },
        { status: "todo" }, { status: "todo" }, { status: "todo" }, { status: "todo" }, { status: "todo" },
      ],
      startedAt: start,
      now: at(3),
      previous: before.snapshot,
    });
    expect(after.planGrew).toBe(true);
    expect(after.planGrewLabel).toBe("plan grew 7 → 8");
    expect(after.percent).toBeLessThan(before.percent);
  });

  it("detects weight growth with unchanged count and ignores shrinkage", () => {
    const prev = { totalCount: 2, totalWeight: 2 };
    const grew = computeIssueProgress({
      children: [{ status: "todo", sizeLabel: "L" }, { status: "todo" }],
      startedAt: start,
      now: at(1),
      previous: prev,
    });
    expect(grew.planGrew).toBe(true);
    expect(grew.planGrewLabel).toBe("plan grew 2 → 4 (weight)");
    const shrank = computeIssueProgress({
      children: [{ status: "todo" }],
      startedAt: start,
      now: at(1),
      previous: prev,
    });
    expect(shrank.planGrew).toBe(false);
  });
});
