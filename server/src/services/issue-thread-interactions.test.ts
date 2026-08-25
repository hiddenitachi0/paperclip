import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateChild = vi.fn();
const mockAddComment = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
    addComment: mockAddComment,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn(),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
  });
});

// DUR-162: a card nobody answers must not sit in the operator's live decision
// queue forever. Verifies expireAbandonedPending closes each interaction kind
// with the right per-kind "why", touches the issue, and leaves a comment.
describe("issueThreadInteractionService.expireAbandonedPending (DUR-162)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  function makeFakeExpiryDb(pendingRows: SelectRow[]) {
    const interactionUpdates: SelectRow[] = [];
    const issueTouches: SelectRow[] = [];
    let interactionUpdateIndex = 0;

    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(pendingRows)),
          })),
        })),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => {
            if ("status" in values || "result" in values) {
              const row = pendingRows[interactionUpdateIndex];
              interactionUpdateIndex += 1;
              const updated = { ...row, ...values };
              interactionUpdates.push(updated);
              return { returning: vi.fn(async () => [updated]) };
            }
            issueTouches.push(values);
            return Promise.resolve(undefined);
          }),
        })),
      })),
    };

    return { db, interactionUpdates, issueTouches };
  }

  const baseRow = {
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    continuationPolicy: "wake_assignee",
    sourceCommentId: null,
    sourceRunId: null,
    summary: null,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    result: null,
    resolvedAt: null,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  };

  it("does nothing when there are no pending interactions past the timeout", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const { db } = makeFakeExpiryDb([]);
    const svc = issueThreadInteractionService(db as never);

    const expired = await svc.expireAbandonedPending(new Date("2026-08-25T00:00:00.000Z"));

    expect(expired).toEqual([]);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("closes an abandoned request_confirmation as expired/auto_resolved, touches the issue, and comments why", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-confirm",
      kind: "request_confirmation",
      idempotencyKey: null,
      title: "Deploy now?",
      payload: { version: 1, prompt: "Deploy now?" },
    };
    const { db, interactionUpdates, issueTouches } = makeFakeExpiryDb([row]);
    const svc = issueThreadInteractionService(db as never);

    const expired = await svc.expireAbandonedPending(new Date("2026-08-25T00:00:00.000Z"));

    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("expired");
    expect((expired[0].result as { outcome: string }).outcome).toBe("auto_resolved");
    expect(interactionUpdates).toHaveLength(1);
    expect(issueTouches).toHaveLength(1);
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddComment.mock.calls[0][0]).toBe(row.issueId);
    expect(mockAddComment.mock.calls[0][1]).toContain("Deploy now?");
  });

  it("closes an abandoned ask_user_questions interaction as cancelled with a cancellationReason", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-questions",
      kind: "ask_user_questions",
      idempotencyKey: null,
      title: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Which scope?",
            selectionMode: "single",
            options: [{ id: "a", label: "A" }],
          },
        ],
      },
    };
    const { db } = makeFakeExpiryDb([row]);
    const svc = issueThreadInteractionService(db as never);

    const expired = await svc.expireAbandonedPending(new Date("2026-08-25T00:00:00.000Z"));

    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("cancelled");
    const result = expired[0].result as { cancelled: boolean; cancellationReason: string };
    expect(result.cancelled).toBe(true);
    expect(result.cancellationReason).toMatch(/unanswered|nobody answered/i);
  });

  it("closes an abandoned suggest_tasks interaction as rejected with a rejectionReason", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-tasks",
      kind: "suggest_tasks",
      idempotencyKey: null,
      title: "Break this down",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    };
    const { db } = makeFakeExpiryDb([row]);
    const svc = issueThreadInteractionService(db as never);

    const expired = await svc.expireAbandonedPending(new Date("2026-08-25T00:00:00.000Z"));

    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("rejected");
    expect((expired[0].result as { rejectionReason: string }).rejectionReason).toBeTruthy();
  });
});
