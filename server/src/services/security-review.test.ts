/**
 * DUR-4566: the security-review state of a merge card, computed fresh per
 * head commit (never cached), the single-flight "Request security review"
 * action, and who may record a verdict.
 *
 * Mirrors job-approval-gate.test.ts's hand-rolled db mocking shape -- no
 * embedded Postgres needed, since every call this service makes is a single
 * select/insert/update against one of a handful of tables, matched here by
 * table identity rather than by compiling real SQL.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { agents, approvals, companySecurityReviewSettings, issues, mergeSecurityReviews } from "@paperclipai/db";

const mockIssueService = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./issues.js", () => ({ issueService: () => mockIssueService }));

const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
vi.mock("./issue-approvals.js", () => ({ issueApprovalService: () => mockIssueApprovalService }));

type RowsByTable = Map<unknown, unknown[]>;

function rowsChain(rows: unknown[]) {
  const chain = {
    then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    orderBy: () => chain,
    limit: () => chain,
  };
  return chain;
}

/**
 * Insert/update on `mergeSecurityReviews` mutate the row list in place (there
 * is at most one row across these tests), so a write made mid-call is visible
 * to the `latestReviewRow()` select `requestReview`/`recordVerdict` make right
 * after -- the same thing a real DB round-trip would show.
 */
function makeFakeDb(options: {
  rowsByTable: RowsByTable;
  onInsert?: (table: unknown, values: Record<string, unknown>) => void;
}) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => rowsChain(options.rowsByTable.get(table) ?? []),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (options.onInsert) {
          options.onInsert(table, values);
          return;
        }
        const rows = options.rowsByTable.get(table) ?? [];
        rows.push({ id: `generated-${rows.length + 1}`, ...values });
        options.rowsByTable.set(table, rows);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const rows = options.rowsByTable.get(table) ?? [];
          if (rows.length > 0) Object.assign(rows[0] as Record<string, unknown>, values);
        },
      }),
    }),
  } as any;
}

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const APPROVAL_ID = "approval-1";
const REVIEWER_AGENT_ID = "reviewer-agent";
const REQUESTER_AGENT_ID = "requester-agent";

function mergeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    companyId: COMPANY_A,
    requestedByAgentId: REQUESTER_AGENT_ID,
    payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 1, commit: "head-a", title: "Ship it" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("securityReviewService.computeState (DUR-4566)", () => {
  it("reads as not_requested with no review history, when a reviewer is configured", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([[companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]]]),
    });
    const state = await securityReviewService(db).computeState(mergeApproval());
    expect(state.state).toBe("not_requested");
    expect(state.headCommit).toBe("head-a");
  });

  it("reads as no_reviewer_configured with no review history and no reviewer set", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({ rowsByTable: new Map<unknown, unknown[]>([[companySecurityReviewSettings, []]]) });
    const state = await securityReviewService(db).computeState(mergeApproval());
    expect(state.state).toBe("no_reviewer_configured");
  });

  it("reads as passed when the newest review row matches the approval's current head commit", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [
          mergeSecurityReviews,
          [{ id: "review-1", status: "passed", headCommit: "head-a", reviewIssueId: null, verdictNote: "ok", verdictCommentUrl: null, decidedAt: new Date("2026-01-01") }],
        ],
      ]),
    });
    const state = await securityReviewService(db).computeState(mergeApproval());
    expect(state.state).toBe("passed");
  });

  it("a later push (new head commit) turns a prior pass out_of_date, without losing the old verdict", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [
          mergeSecurityReviews,
          [{ id: "review-1", status: "passed", headCommit: "head-a", reviewIssueId: null, verdictNote: "ok", verdictCommentUrl: null, decidedAt: new Date("2026-01-01") }],
        ],
      ]),
    });
    // Same stored review row, but the approval's payload.commit has since moved on.
    const state = await securityReviewService(db).computeState(mergeApproval({ payload: { kind: "merge_pr", commit: "head-b" } }));
    expect(state.state).toBe("out_of_date");
    expect(state.priorState).toBe("passed");
    expect(state.verdictNote).toBe("ok");
  });

  it("an open (in-progress) review targeting a now-stale head still reads as in_progress, not out_of_date", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([[mergeSecurityReviews, [{ id: "review-1", status: "requested", headCommit: "head-a", reviewIssueId: null }]]]),
    });
    const state = await securityReviewService(db).computeState(mergeApproval({ payload: { kind: "merge_pr", commit: "head-b" } }));
    expect(state.state).toBe("in_progress");
  });

  it("every non-merge_pr approval reads as not_requested with no head commit", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({ rowsByTable: new Map<unknown, unknown[]>() });
    const state = await securityReviewService(db).computeState(mergeApproval({ payload: { kind: "hire_agent" } }));
    expect(state).toEqual(
      expect.objectContaining({ state: "not_requested", headCommit: null }),
    );
  });
});

describe("securityReviewService.requestReview (DUR-4566 item 2, single-flight)", () => {
  it("creates a review task assigned to the configured reviewer and links it to the approval", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval()]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, []],
      ]),
    });
    mockIssueService.create.mockResolvedValue({ id: "review-issue-1", identifier: "DUR-9001" });

    const state = await securityReviewService(db).requestReview(APPROVAL_ID, { agentId: REQUESTER_AGENT_ID, userId: null });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      COMPANY_A,
      expect.objectContaining({ assigneeAgentId: REVIEWER_AGENT_ID }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(APPROVAL_ID, ["review-issue-1"], {
      agentId: REQUESTER_AGENT_ID,
      userId: null,
    });
    expect(state.state).toBe("in_progress");
  });

  it("refuses when no reviewer agent is configured for the company", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval()]],
        [companySecurityReviewSettings, []],
      ]),
    });
    await expect(
      securityReviewService(db).requestReview(APPROVAL_ID, { agentId: REQUESTER_AGENT_ID, userId: null }),
    ).rejects.toThrow(/no security reviewer agent is set/i);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("is single-flight: a second request for the same open head commit does not create a second task", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval()]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, [{ id: "review-1", status: "requested", headCommit: "head-a", reviewIssueId: "review-issue-1" }]],
      ]),
    });

    const state = await securityReviewService(db).requestReview(APPROVAL_ID, { agentId: REQUESTER_AGENT_ID, userId: null });

    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(state.state).toBe("in_progress");
  });

  it("treats a unique-constraint race on insert the same as an already-open request", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval()]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, []],
      ]),
      onInsert: () => {
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      },
    });
    mockIssueService.create.mockResolvedValue({ id: "review-issue-1", identifier: "DUR-9001" });

    await expect(
      securityReviewService(db).requestReview(APPROVAL_ID, { agentId: REQUESTER_AGENT_ID, userId: null }),
    ).resolves.toEqual(expect.objectContaining({ state: "not_requested" }));
  });
});

describe("securityReviewService.recordVerdict (DUR-4566 item 3, authorization)", () => {
  function settingsDb(extra: Partial<Record<string, unknown[]>> = {}) {
    return makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval()]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, []],
        [agents, [{ companyId: COMPANY_A }]],
        ...(Object.entries(extra) as [unknown, unknown[]][]),
      ]),
    });
  }

  it("lets the configured reviewer agent record a verdict", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = settingsDb();
    const state = await securityReviewService(db).recordVerdict(
      APPROVAL_ID,
      { agentId: REVIEWER_AGENT_ID, userId: null },
      { verdict: "passed", note: "Looks safe" },
    );
    expect(state.state).toBe("passed");
  });

  it("lets a board user record a verdict", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = settingsDb();
    const state = await securityReviewService(db).recordVerdict(
      APPROVAL_ID,
      { agentId: null, userId: "board-user" },
      { verdict: "failed", note: "Found a problem" },
    );
    expect(state.state).toBe("failed");
  });

  it("refuses an agent that is not this company's configured reviewer", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = settingsDb();
    await expect(
      securityReviewService(db).recordVerdict(
        APPROVAL_ID,
        { agentId: "some-other-agent", userId: null },
        { verdict: "passed", note: "trust me" },
      ),
    ).rejects.toThrow(/designated security reviewer/i);
  });

  it("refuses the approval's own requester, even if it is the configured reviewer agent", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval({ requestedByAgentId: REVIEWER_AGENT_ID })]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, []],
        [agents, [{ companyId: COMPANY_A }]],
      ]),
    });
    await expect(
      securityReviewService(db).recordVerdict(
        APPROVAL_ID,
        { agentId: REVIEWER_AGENT_ID, userId: null },
        { verdict: "passed", note: "self-approved" },
      ),
    ).rejects.toThrow(/cannot record a security review verdict on its own merge card/i);
  });

  it("refuses a reviewer agent that belongs to a different company (cross-company refused)", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = makeFakeDb({
      rowsByTable: new Map<unknown, unknown[]>([
        [approvals, [mergeApproval({ companyId: COMPANY_A })]],
        [companySecurityReviewSettings, [{ securityReviewerAgentId: REVIEWER_AGENT_ID }]],
        [mergeSecurityReviews, []],
        // The agent calling in is the configured reviewer id, but belongs to company B.
        [agents, [{ companyId: COMPANY_B }]],
      ]),
    });
    await expect(
      securityReviewService(db).recordVerdict(
        APPROVAL_ID,
        { agentId: REVIEWER_AGENT_ID, userId: null },
        { verdict: "passed", note: "cross-company" },
      ),
    ).rejects.toThrow(/own company/i);
  });

  it("refuses an anonymous caller (neither an agent nor a board user)", async () => {
    const { securityReviewService } = await import("./security-review.js");
    const db = settingsDb();
    await expect(
      securityReviewService(db).recordVerdict(APPROVAL_ID, { agentId: null, userId: null }, { verdict: "passed", note: "?" }),
    ).rejects.toThrow(/security reviewer agent or a board user/i);
  });
});
