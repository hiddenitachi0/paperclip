/**
 * DUR-4182: a Job's `requiresApproval` flag ("needs Filip's approval before done").
 * Mirrors feature-launch-gate.test.ts's mocking shape for the approvals lookup, and
 * origin-commit-gate-routes.test.ts's hand-rolled select/from/where/then chain for the
 * one `jobs` table lookup this gate makes -- no embedded Postgres needed for either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
}));
vi.mock("./issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));

function fakeDb(jobRow: Record<string, unknown> | null) {
  const rows = jobRow ? [jobRow] : [];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected),
        })),
      })),
    })),
  };
}

const AGENT_ACTOR = { actorType: "agent", agentId: "agent-1", runId: "run-1" };
const BOARD_ACTOR = { actorType: "board", agentId: null, runId: null };
const JOB_ISSUE = { id: "issue-1", companyId: "company-1", originKind: "job_execution", originId: "job-1" };

const jobApproval = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "approval-1",
  type: "request_board_approval",
  status: "approved",
  payload: { kind: "job_approval", jobId: "job-1" },
  ...overrides,
});

describe("evaluateJobApprovalDoneGate (DUR-4182)", () => {
  beforeEach(() => {
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
  });

  it("blocks done for a requiresApproval job with no linked approval", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("Revise contract");
    expect(result?.message).toContain("job_approval");
  });

  it("blocks done when a job_approval approval was filed but is still pending", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([jobApproval({ status: "pending" })]);

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).not.toBeNull();
  });

  it("allows done once an approved job_approval is linked", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([jobApproval()]);

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
  });

  it("never fires for a job that does not require approval", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Draft new contract", requiresApproval: false }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("never fires for an issue that wasn't created by a job run", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb(null) as any,
      issue: { id: "issue-2", companyId: "company-1", originKind: "manual", originId: null },
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("never fires for a board actor -- a human can always override, same split as the other done-gates", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: BOARD_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("never fires for a transition that isn't into done", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "in_review",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
  });

  it("never fires when the issue is already done", async () => {
    const { evaluateJobApprovalDoneGate } = await import("./job-approval-gate.js");

    const result = await evaluateJobApprovalDoneGate({
      db: fakeDb({ id: "job-1", title: "Revise contract", requiresApproval: true }) as any,
      issue: JOB_ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "done",
    });

    expect(result).toBeNull();
  });
});
