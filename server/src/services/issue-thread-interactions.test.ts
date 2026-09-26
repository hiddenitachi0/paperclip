import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateChild = vi.fn();
const mockAddComment = vi.fn();
// Instance setting "Close unanswered agent cards after (hours)", read by
// expireAbandonedPending on every tick. Defaults to 24 in these tests.
const mockGetGeneral = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
    addComment: mockAddComment,
  }),
}));

vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: mockGetGeneral,
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
    mockGetGeneral.mockResolvedValue({ agentCardExpiresAfterHours: 24 });
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
    expiresAfterHours: null,
    neverExpires: false,
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

  // Who filed the card decides its default. The operator's own checklist
  // cards (filed from the board CLI as a to-do list: created_by_user_id set,
  // created_by_agent_id null) were swept away by the old flat 24h rule.
  const T0 = new Date("2026-09-24T08:00:00.000Z");
  const hoursLater = (hours: number) => new Date(T0.getTime() + hours * 60 * 60 * 1000);
  const checklistPayload = {
    version: 1,
    prompt: "Tick what you have finished",
    options: [{ id: "a", label: "Call the accountant" }],
  };

  it("leaves a checklist card a board user filed alone after 48 hours: still pending, no comment", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-operator-checklist",
      kind: "request_checkbox_confirmation",
      idempotencyKey: "operator-todo-1-r2",
      title: "Today's to-do list",
      payload: checklistPayload,
      createdByAgentId: null,
      createdByUserId: "user-filip",
      createdAt: T0,
      updatedAt: T0,
    };
    const { db, interactionUpdates, issueTouches } = makeFakeExpiryDb([row]);
    const svc = issueThreadInteractionService(db as never);

    const expired = await svc.expireAbandonedPending(hoursLater(48));

    expect(expired).toEqual([]);
    expect(interactionUpdates).toHaveLength(0);
    expect(issueTouches).toHaveLength(0);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("closes an agent-created card at 24 hours, not at 23, and says nobody needs to act", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-agent-checklist",
      kind: "request_checkbox_confirmation",
      idempotencyKey: null,
      title: "Which files may I delete?",
      payload: checklistPayload,
      createdAt: T0,
      updatedAt: T0,
    };

    const early = makeFakeExpiryDb([row]);
    expect(await issueThreadInteractionService(early.db as never).expireAbandonedPending(hoursLater(23))).toEqual([]);
    expect(early.interactionUpdates).toHaveLength(0);
    expect(mockAddComment).not.toHaveBeenCalled();

    const due = makeFakeExpiryDb([row]);
    const expired = await issueThreadInteractionService(due.db as never).expireAbandonedPending(hoursLater(24));
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("expired");
    expect((expired[0].result as { outcome: string; reason: string }).outcome).toBe("auto_resolved");
    expect((expired[0].result as { reason: string }).reason).toBe(
      "Automatically closed: nobody answered this in the operator queue within 24 hours.",
    );
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddComment.mock.calls[0][1]).toBe(
      'A pending "Which files may I delete?" request to the operator went unanswered for over 24 hours and was closed automatically. Nobody needs to act on it.',
    );
  });

  it("closes a board user's card with its own 2-hour limit at 2 hours, with the 'limit you set' wording", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-operator-timed",
      kind: "request_checkbox_confirmation",
      idempotencyKey: null,
      title: "Before the 10:00 call",
      payload: checklistPayload,
      createdByAgentId: null,
      createdByUserId: "user-filip",
      expiresAfterHours: 2,
      createdAt: T0,
      updatedAt: T0,
    };

    const early = makeFakeExpiryDb([row]);
    expect(await issueThreadInteractionService(early.db as never).expireAbandonedPending(hoursLater(1))).toEqual([]);
    expect(mockAddComment).not.toHaveBeenCalled();

    const due = makeFakeExpiryDb([row]);
    const expired = await issueThreadInteractionService(due.db as never).expireAbandonedPending(hoursLater(2));
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("expired");
    expect((expired[0].result as { reason: string }).reason).toBe(
      "Closed automatically: the time limit you set on this card (2 hours) ran out before it was answered.",
    );
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const comment = mockAddComment.mock.calls[0][1] as string;
    expect(comment).toBe(
      'Your "Before the 10:00 call" card was closed automatically because the time limit you set on it (2 hours) ran out before it was answered. File it again if you still need it.',
    );
    expect(comment).not.toMatch(/nobody needs to act/i);
  });

  it("an agent card with its own limit uses that limit (not the instance default) and says the agent set it", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-agent-timed",
      kind: "request_confirmation",
      idempotencyKey: null,
      title: "Deploy now?",
      payload: { version: 1, prompt: "Deploy now?" },
      expiresAfterHours: 1,
      createdAt: T0,
      updatedAt: T0,
    };
    const { db } = makeFakeExpiryDb([row]);

    const expired = await issueThreadInteractionService(db as never).expireAbandonedPending(hoursLater(1));

    expect(expired).toHaveLength(1);
    expect((expired[0].result as { reason: string }).reason).toBe(
      "Closed automatically: the time limit the agent set on this card (1 hour) ran out before it was answered.",
    );
    expect(mockAddComment.mock.calls[0][1]).toBe(
      'A pending "Deploy now?" request to the operator was closed automatically because the time limit the agent set on it (1 hour) ran out before it was answered. Nobody needs to act on it.',
    );
  });

  it("the instance setting changes the agent default: at 48 hours an agent card is still open at 30 and closes at 48", async () => {
    mockGetGeneral.mockResolvedValue({ agentCardExpiresAfterHours: 48 });
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-agent-48",
      kind: "ask_user_questions",
      idempotencyKey: null,
      title: null,
      payload: {
        version: 1,
        questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "a", label: "A" }] }],
      },
      createdAt: T0,
      updatedAt: T0,
    };

    const early = makeFakeExpiryDb([row]);
    expect(await issueThreadInteractionService(early.db as never).expireAbandonedPending(hoursLater(30))).toEqual([]);

    const due = makeFakeExpiryDb([row]);
    const expired = await issueThreadInteractionService(due.db as never).expireAbandonedPending(hoursLater(48));
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("cancelled");
    expect((expired[0].result as { cancellationReason: string }).cancellationReason).toBe(
      "Automatically closed: nobody answered this in the operator queue within 48 hours.",
    );
    expect(mockAddComment.mock.calls[0][1]).toContain("went unanswered for over 48 hours");
  });

  it("neverExpires keeps a card open however old it is, whoever filed it", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-agent-never",
      kind: "suggest_tasks",
      idempotencyKey: null,
      title: "Break this down",
      payload: { version: 1, tasks: [{ clientKey: "task-1", title: "One" }] },
      neverExpires: true,
      createdAt: T0,
      updatedAt: T0,
    };
    const { db, interactionUpdates } = makeFakeExpiryDb([row]);

    expect(await issueThreadInteractionService(db as never).expireAbandonedPending(hoursLater(1000))).toEqual([]);
    expect(interactionUpdates).toHaveLength(0);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("falls back to 24 hours when the setting is missing from an older settings row", async () => {
    mockGetGeneral.mockResolvedValue({});
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const row = {
      ...baseRow,
      id: "interaction-agent-old-settings",
      kind: "request_confirmation",
      idempotencyKey: null,
      title: "Deploy now?",
      payload: { version: 1, prompt: "Deploy now?" },
      createdAt: T0,
      updatedAt: T0,
    };
    const { db } = makeFakeExpiryDb([row]);

    const expired = await issueThreadInteractionService(db as never).expireAbandonedPending(hoursLater(24));
    expect(expired).toHaveLength(1);
    expect(mockAddComment.mock.calls[0][1]).toContain("over 24 hours");
  });
});

// The rule on its own, and the SQL it turns into, so the scheduler only ever
// loads rows that are actually due instead of one flat cutoff.
describe("resolveInteractionExpiryRule / buildAbandonedPendingWhere", () => {
  it("applies the four rules in order: neverExpires, own limit, board user never, agent default", async () => {
    const { resolveInteractionExpiryRule } = await import("./issue-thread-interactions.js");
    const user = { createdByAgentId: null, createdByUserId: "user-filip" };
    const agent = { createdByAgentId: "agent-1", createdByUserId: null };
    expect(resolveInteractionExpiryRule({ ...user, neverExpires: true, expiresAfterHours: null }, 24)).toEqual({ kind: "never" });
    expect(resolveInteractionExpiryRule({ ...agent, neverExpires: true, expiresAfterHours: null }, 24)).toEqual({ kind: "never" });
    expect(resolveInteractionExpiryRule({ ...user, neverExpires: false, expiresAfterHours: 2 }, 24)).toEqual({ kind: "explicit", hours: 2 });
    expect(resolveInteractionExpiryRule({ ...agent, neverExpires: false, expiresAfterHours: 72 }, 24)).toEqual({ kind: "explicit", hours: 72 });
    expect(resolveInteractionExpiryRule({ ...user, neverExpires: false, expiresAfterHours: null }, 24)).toEqual({ kind: "never" });
    expect(resolveInteractionExpiryRule({ ...agent, neverExpires: false, expiresAfterHours: null }, 24)).toEqual({ kind: "agent_default", hours: 24 });
    expect(resolveInteractionExpiryRule({ ...agent, neverExpires: false, expiresAfterHours: null }, 48)).toEqual({ kind: "agent_default", hours: 48 });
    // A row with no recorded creator is not a board user's card: it gets the agent default.
    expect(resolveInteractionExpiryRule({ createdByAgentId: null, createdByUserId: null }, 24)).toEqual({ kind: "agent_default", hours: 24 });
    // Rows written before migration 0176 carry neither column: same result as NULL/false.
    expect(resolveInteractionExpiryRule(user, 24)).toEqual({ kind: "never" });
    expect(resolveInteractionExpiryRule(agent, 24)).toEqual({ kind: "agent_default", hours: 24 });
  });

  it("renders a per-row cutoff in SQL: own limit via make_interval, agent default only for rows not filed by a board user", async () => {
    const { buildAbandonedPendingWhere } = await import("./issue-thread-interactions.js");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const now = new Date("2026-09-25T08:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildAbandonedPendingWhere(now, 24)!);
    expect(query.sql).toContain('"issue_thread_interactions"."status" = $');
    expect(query.sql).toContain('"issue_thread_interactions"."never_expires" = $');
    expect(query.sql).toContain('make_interval(hours => "issue_thread_interactions"."expires_after_hours")');
    expect(query.sql).toContain('"issue_thread_interactions"."created_by_agent_id" is not null or "issue_thread_interactions"."created_by_user_id" is null');
    expect(query.sql).toContain('"issue_thread_interactions"."expires_after_hours" is null');
    expect(query.params).toContain("pending");
    expect(query.params).toContain(false);
    expect(query.params).toContain(now.toISOString());
    // The agent-default cutoff (now - 24h) is bound as the created_at comparison value.
    const cutoff = new Date("2026-09-24T08:00:00.000Z");
    expect(
      query.params.some((param) =>
        param === cutoff.toISOString() || (param instanceof Date && param.getTime() === cutoff.getTime())),
      JSON.stringify(query.params),
    ).toBe(true);
  });
});
