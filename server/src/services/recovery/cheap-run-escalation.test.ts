import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
  buildCheapRunEscalationIdempotencyKey,
  decideCheapRunEscalation,
  recordCheapRunEscalation,
} from "./cheap-run-escalation.js";

describe("decideCheapRunEscalation", () => {
  it("enqueues a normal-model wake when nothing is pending and the cap is not reached", () => {
    const decision = decideCheapRunEscalation({
      issueId: "issue-1",
      sourceRunId: "run-1",
      blockedAction: "file an approval",
      priorEscalationCount: 0,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") throw new Error("unreachable");
    expect(decision.idempotencyKey).toBe(
      buildCheapRunEscalationIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" }),
    );
    // The escalated wake must never carry the cheap/status-only guard shape --
    // that would just reproduce the wall it exists to get past.
    expect(decision.contextSnapshot.modelProfile).toBeUndefined();
    expect(decision.contextSnapshot.resumeRequiresNormalModel).toBeUndefined();
    expect(decision.payload.issueId).toBe("issue-1");
    expect(decision.payload.blockedAction).toBe("file an approval");
  });

  it("is idempotent per (issue, source run): a repeat attempt from the same run never re-enqueues", () => {
    const decision = decideCheapRunEscalation({
      issueId: "issue-1",
      sourceRunId: "run-1",
      blockedAction: "file an approval",
      priorEscalationCount: 0,
      idempotentWakeExists: true,
    });
    expect(decision).toEqual({
      kind: "already_pending",
      idempotencyKey: buildCheapRunEscalationIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" }),
    });
  });

  it("caps escalation once the per-issue lifetime limit is reached, even for a brand-new source run", () => {
    const decision = decideCheapRunEscalation({
      issueId: "issue-1",
      sourceRunId: "run-99",
      blockedAction: "file an approval",
      priorEscalationCount: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
      idempotentWakeExists: false,
    });
    expect(decision).toEqual({
      kind: "capped",
      count: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
      maxCount: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
    });
  });

  it("honors a custom maxEscalations override", () => {
    const decision = decideCheapRunEscalation({
      issueId: "issue-1",
      sourceRunId: "run-2",
      blockedAction: "file an approval",
      priorEscalationCount: 1,
      idempotentWakeExists: false,
      maxEscalations: 1,
    });
    expect(decision.kind).toBe("capped");
  });
});

function fakeDb(input: { existingWakeRows: unknown[]; countRows: unknown[] }) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const keys = Object.keys(selection);
          const rows = keys.includes("status") ? input.existingWakeRows : input.countRows;
          const resolvable = {
            then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
            limit: vi.fn(() => resolvable),
          };
          return resolvable;
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push(row);
      }),
    })),
  };
  return { db: db as any, inserted };
}

describe("recordCheapRunEscalation", () => {
  it("enqueues a wake and leaves a plain-language comment recording the escalation and its count", async () => {
    const { db, inserted } = fakeDb({ existingWakeRows: [], countRows: [] });
    const wakeup = vi.fn(async (_agentId: string, _opts: Record<string, unknown>) => ({ id: "wake-run-1" }));

    const outcome = await recordCheapRunEscalation(db, wakeup, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-1",
      blockedAction: "file a merge_pr approval",
    });

    expect(outcome).toEqual({
      escalated: true,
      alreadyPending: false,
      capped: false,
      failed: false,
      escalationRunId: "wake-run-1",
      count: 1,
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][0]).toBe("agent-1");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].body).toContain("Escalation 1 of");
    expect(inserted[0].body).toContain("file a merge_pr approval");
  });

  it("does not enqueue a second wake when one is already in flight for this run", async () => {
    const { db, inserted } = fakeDb({
      existingWakeRows: [{ id: "already-queued", status: "queued" }],
      countRows: [],
    });
    const wakeup = vi.fn(async (_agentId: string, _opts: Record<string, unknown>) => ({ id: "wake-run-1" }));

    const outcome = await recordCheapRunEscalation(db, wakeup, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-1",
      blockedAction: "file a merge_pr approval",
    });

    expect(outcome).toEqual({
      escalated: true,
      alreadyPending: true,
      capped: false,
      failed: false,
      escalationRunId: "already-queued",
      count: 0,
    });
    expect(wakeup).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("stops escalating once the issue hits its lifetime cap, and tells the operator a human is needed", async () => {
    const { db, inserted } = fakeDb({
      existingWakeRows: [],
      countRows: Array.from({ length: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE }, (_, i) => ({ id: `wake-${i}` })),
    });
    const wakeup = vi.fn(async (_agentId: string, _opts: Record<string, unknown>) => ({ id: "should-not-be-called" }));

    const outcome = await recordCheapRunEscalation(db, wakeup, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-100",
      blockedAction: "file a merge_pr approval",
    });

    expect(outcome).toEqual({
      escalated: false,
      alreadyPending: false,
      capped: true,
      failed: false,
      count: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
      maxCount: DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
    });
    expect(wakeup).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].body).toContain("operator needs to look at this issue directly");
  });

  it("reports failure instead of throwing when scheduling the wake fails, and leaves no partial state behind", async () => {
    const { db, inserted } = fakeDb({ existingWakeRows: [], countRows: [] });
    const wakeup = vi.fn(async () => {
      throw new Error("company is over budget");
    });

    const outcome = await recordCheapRunEscalation(db, wakeup, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-1",
      blockedAction: "file a merge_pr approval",
    });

    expect(outcome).toEqual({ escalated: false, alreadyPending: false, capped: false, failed: true });
    // Nothing was persisted, so a retry is free to try again from scratch.
    expect(inserted).toHaveLength(0);
  });
});
