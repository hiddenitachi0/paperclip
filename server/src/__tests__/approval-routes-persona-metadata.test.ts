import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-177 items 16/17: GET /approvals* tags an approval's payload with
// `isPersonaRequest`/`personaDisplayName` when (and only when) the
// requesting agent has a real `personas` row (see withPersonaMetadata in
// ../routes/approvals.ts). This suite covers both the happy path and the
// security-relevant negative case: `payload` is fully agent-controlled at
// approval-creation time (`createApprovalSchema` accepts
// `payload: z.record(z.string(), z.unknown())`), so a non-persona agent
// could try to self-set `isPersonaRequest: true` to get ApprovalDetail.tsx
// to hide that approval's UUID/raw-JSON disclosure by default. The route
// must strip any such client-supplied value and only trust its own
// `personaService.getPersonaDisplayNamesByAgentIds` lookup.

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
}));

const mockPersonaService = vi.hoisted(() => ({
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map<string, string>()),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => ({ getById: vi.fn() }),
    approvalService: () => mockApprovalService,
    escalationGrantService: () => ({
      assertRequestAllowed: vi.fn(),
      createFromApproval: vi.fn(),
      resolveActiveGrantForDispatch: vi.fn(),
      evaluateCostEvent: vi.fn(),
      getForIssue: vi.fn(),
    }),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => ({ listIssuesForApproval: vi.fn(), linkManyForApproval: vi.fn() }),
    issueThreadInteractionService: () => ({ resolveInteractionsLinkedToApproval: vi.fn() }),
    logActivity: vi.fn(),
    personaService: () => mockPersonaService,
    secretService: () => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }),
  }));
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes persona metadata (DUR-177 items 16/17)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.getById.mockReset();
    mockPersonaService.getPersonaDisplayNamesByAgentIds.mockReset();
    mockPersonaService.getPersonaDisplayNamesByAgentIds.mockResolvedValue(new Map());
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  it("tags a persona-linked agent's approval with isPersonaRequest + personaDisplayName from the server-side lookup", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "credential_request",
      status: "pending",
      requestedByAgentId: "agent-persona",
      payload: { envKey: "META_IG_TOKEN", name: "Instagram access token" },
    });
    mockPersonaService.getPersonaDisplayNamesByAgentIds.mockResolvedValue(
      new Map([["agent-persona", "Maja"]]),
    );

    const res = await request(await createApp()).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(res.body.payload.isPersonaRequest).toBe(true);
    expect(res.body.payload.personaDisplayName).toBe("Maja");
  });

  it("does NOT trust a client-supplied isPersonaRequest/personaDisplayName on a non-persona agent's approval", async () => {
    // The requesting agent has no `personas` row (lookup map stays empty),
    // but the payload it submitted at creation time already contains a
    // spoofed persona tag -- exactly what an agent could do today since
    // approval payloads accept arbitrary keys.
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-1",
      type: "credential_request",
      status: "pending",
      requestedByAgentId: "agent-plain",
      payload: {
        envKey: "SOME_TOKEN",
        isPersonaRequest: true,
        personaDisplayName: "Not A Real Persona",
      },
    });
    mockPersonaService.getPersonaDisplayNamesByAgentIds.mockResolvedValue(new Map());

    const res = await request(await createApp()).get("/api/approvals/approval-2");

    expect(res.status).toBe(200);
    expect(res.body.payload.isPersonaRequest).toBeUndefined();
    expect(res.body.payload.personaDisplayName).toBeUndefined();
  });

  it("leaves a plain agent's ordinary approval untouched (no persona keys at all)", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: "agent-plain",
      payload: { kind: "merge_pr", prNumber: 42 },
    });

    const res = await request(await createApp()).get("/api/approvals/approval-3");

    expect(res.status).toBe(200);
    expect(res.body.payload.isPersonaRequest).toBeUndefined();
    expect(res.body.payload.personaDisplayName).toBeUndefined();
    expect(res.body.payload.prNumber).toBe(42);
  });
});
