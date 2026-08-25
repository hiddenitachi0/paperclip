import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

// DUR-69/DUR-109: a boss-proposed instructions change is never written to
// disk just because it was proposed -- approving it is the ONLY place it
// actually applies (mirrors how tool_grant/hire_agent approvals work). This
// proves the approve path writes the file, bumps instructionsReviewedAt, and
// records a revision naming BOTH the proposing boss and the approving
// operator (per DUR-69's operator ruling), and that reject/a missing target
// agent never touch anything.

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockInstructionsService = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => mockInstructionsService),
}));

const bossAgentId = "11111111-1111-4111-8111-111111111111";
const reportAgentId = "33333333-3333-4333-8333-333333333333";
const companyId = "22222222-2222-4222-8222-222222222222";

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createInstructionsChangeApproval(
  status: string,
  overrides: Partial<ApprovalRecord["payload"]> = {},
): ApprovalRecord {
  return {
    id: "approval-1",
    companyId,
    type: "request_board_approval",
    status,
    payload: {
      kind: "instructions_change",
      agentId: reportAgentId,
      relativePath: "AGENTS.md",
      beforeContent: "# Old instructions",
      afterContent: "# New instructions",
      reason: "The project moved into beta, the old brief is stale.",
      title: "Update Builder's instructions",
      ...overrides,
    },
    requestedByAgentId: bossAgentId,
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const insertValues = vi.fn(async () => []);
  const insert = vi.fn(() => ({ values: insertValues }));

  return { db: { select, update, insert }, insertValues, insert };
}

describe("approvalService instructions_change approval application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the new instructions, bumps instructionsReviewedAt, and records both proposer and approver on approve", async () => {
    const approved = createInstructionsChangeApproval("approved");
    const dbStub = createDbStub([[createInstructionsChangeApproval("pending")]], [approved]);
    mockAgentService.getById.mockResolvedValue({
      id: reportAgentId,
      companyId,
      adapterConfig: { instructionsBundleMode: "managed" },
    });
    mockInstructionsService.writeFile.mockResolvedValue({
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: "/agents/report/instructions" },
    });
    mockAgentService.update.mockResolvedValue({ id: reportAgentId, companyId });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "filip", "Looks accurate, approved.");

    expect(result.applied).toBe(true);
    expect(mockInstructionsService.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: reportAgentId }),
      "AGENTS.md",
      "# New instructions",
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      reportAgentId,
      expect.objectContaining({
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: "/agents/report/instructions" },
        instructionsReviewedAt: expect.any(Date),
      }),
      { recordRevision: { createdByUserId: "filip", source: "instructions_change_approval" } },
    );
    expect(dbStub.insert).toHaveBeenCalled();
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        agentId: reportAgentId,
        approvalId: "approval-1",
        proposedByAgentId: bossAgentId,
        approvedByUserId: "filip",
        reason: "The project moved into beta, the old brief is stale.",
        relativePath: "AGENTS.md",
        beforeContent: "# Old instructions",
        afterContent: "# New instructions",
      }),
    );
    expect(result.instructionsChange).toEqual({
      agentId: reportAgentId,
      companyId,
      relativePath: "AGENTS.md",
      proposedByAgentId: bossAgentId,
    });
  });

  it("does not write anything when the proposal is rejected", async () => {
    const rejected = createInstructionsChangeApproval("rejected");
    const dbStub = createDbStub([[createInstructionsChangeApproval("pending")]], [rejected]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "filip", "Not accurate enough yet.");

    expect(result.applied).toBe(true);
    expect(mockInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("does not throw and skips applying when the target agent no longer exists", async () => {
    const approved = createInstructionsChangeApproval("approved");
    const dbStub = createDbStub([[createInstructionsChangeApproval("pending")]], [approved]);
    mockAgentService.getById.mockResolvedValue(null);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "filip", null);

    expect(result.applied).toBe(true);
    expect(result.instructionsChange).toBeNull();
    expect(mockInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(dbStub.insert).not.toHaveBeenCalled();
  });
});
