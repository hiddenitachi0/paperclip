import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

// DUR-58 style feature (kept nameless in code/comments/PR per convention): an
// agent's only path to a new tool connection is filing a `tool_grant`
// request_board_approval and having an operator explicitly approve it --
// nothing is granted just because the agent asked. This proves the approve
// path is what actually applies the mcpServers change (mirrors how
// hire_agent above only activates an agent once approved), and that a
// reject or a still-pending approval never touches the agent's config.

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createToolGrantApproval(status: string, overrides: Partial<ApprovalRecord["payload"]> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    companyId,
    type: "request_board_approval",
    status,
    payload: {
      kind: "tool_grant",
      agentId,
      server: { name: "search", url: "https://search.example.com/mcp" },
      reason: "Needs to look up docs.",
      title: "Grant Builder access to search",
      summary: "Connects to the web address...",
      ...overrides,
    },
    requestedByAgentId: agentId,
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

  return { db: { select, update } };
}

describe("approvalService tool_grant approval application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the tool connection to the target agent's adapterConfig on approve", async () => {
    const approved = createToolGrantApproval("approved");
    const dbStub = createDbStub([[createToolGrantApproval("pending")]], [approved]);
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      adapterConfig: {},
    });
    mockAgentService.update.mockResolvedValue({ id: agentId, companyId, adapterConfig: {} });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board-user", "looks safe");

    expect(result.applied).toBe(true);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      {
        adapterConfig: {
          mcpServers: [{ name: "search", url: "https://search.example.com/mcp" }],
        },
      },
      { recordRevision: { createdByUserId: "board-user", source: "tool_grant_approval" } },
    );
    expect(result.toolGrant).toEqual({
      agentId,
      companyId,
      serverName: "search",
      capability: expect.stringContaining("https://search.example.com/mcp"),
    });
  });

  it("replaces an existing server with the same name instead of duplicating it", async () => {
    const approved = createToolGrantApproval("approved", {
      server: { name: "search", url: "https://search.example.com/v2" },
    });
    const dbStub = createDbStub(
      [[createToolGrantApproval("pending", { server: { name: "search", url: "https://search.example.com/v2" } })]],
      [approved],
    );
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      adapterConfig: { mcpServers: [{ name: "search", url: "https://search.example.com/v1" }] },
    });
    mockAgentService.update.mockResolvedValue({ id: agentId, companyId, adapterConfig: {} });

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board-user", null);

    const [, patch] = mockAgentService.update.mock.calls[0]!;
    expect(patch.adapterConfig.mcpServers).toEqual([{ name: "search", url: "https://search.example.com/v2" }]);
  });

  it("does not apply anything when the approval is rejected", async () => {
    const rejected = { ...createToolGrantApproval("rejected") };
    const dbStub = createDbStub([[createToolGrantApproval("pending")]], [rejected]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board-user", "not now");

    expect(result.applied).toBe(true);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("does not throw and skips applying when the target agent no longer exists", async () => {
    const approved = createToolGrantApproval("approved");
    const dbStub = createDbStub([[createToolGrantApproval("pending")]], [approved]);
    mockAgentService.getById.mockResolvedValue(null);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board-user", null);

    expect(result.applied).toBe(true);
    expect(result.toolGrant).toBeNull();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
