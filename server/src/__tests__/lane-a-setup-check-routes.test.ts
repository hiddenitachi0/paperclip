import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/agents/:agentId/lane-a/check: board only, the company's owner or
// admin only, company-scoped, one per agent every ten seconds. The service is
// a stub: no model is called here.

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLaneAService = vi.hoisted(() => ({ checkSetup: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  laneAService: () => mockLaneAService,
  secretService: () => ({}),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

vi.setConfig({ testTimeout: 20_000 });

const companyId = "11111111-1111-4111-8111-111111111112";
const otherCompanyId = "22222222-2222-4222-8222-222222222223";
const agentId = "11111111-1111-4111-8111-111111111111";

function owner(role: "owner" | "admin" | "member" = "owner", company = companyId) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [company],
    memberships: [{ companyId: company, membershipRole: role, status: "active" }],
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ laneARoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/lane-a.js")>("../routes/lane-a.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", laneARoutes({} as any));
  app.use(errorHandler);
  return app;
}

const okResult = {
  target: "main",
  provider: "local",
  model: "qwen3:8b",
  ok: true,
  summary: "Everything works: it answered in 0.4 s and tool calling works.",
  steps: [],
  answerMs: 400,
  toolCalling: "works",
  thinkingAccepted: null,
  costCents: 0,
  costMicroUsd: 0,
  checkedAt: "2026-10-09T10:00:00.000Z",
};

describe("POST /api/agents/:agentId/lane-a/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({ id: agentId, companyId, name: "Maja" });
    mockLaneAService.checkSetup.mockResolvedValue(okResult);
  });

  it("runs the check for the owner, passes the target through, and logs it", async () => {
    const app = await createApp(owner());
    const res = await request(app)
      .post(`/api/agents/${agentId}/lane-a/check`)
      .send({ companyId, target: { backupId: "bk_1" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, toolCalling: "works" });
    expect(mockLaneAService.checkSetup).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId, target: { backupId: "bk_1" } }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.lane_a_setup_checked", entityId: agentId, details: expect.objectContaining({ target: "backup:bk_1", ok: true }) }),
    );
  });

  it("an admin may run it; a plain member may not", async () => {
    const admin = await createApp(owner("admin"));
    expect((await request(admin).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" })).status).toBe(200);
    const member = await createApp(owner("member"));
    const res = await request(member).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner or admin can check a quick agent's model/);
  });

  it("an agent can never run it", async () => {
    const app = await createApp({ type: "agent", agentId: "a-1", companyId, source: "agent_key" });
    const res = await request(app).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" });
    expect(res.status).toBe(403);
    expect(mockLaneAService.checkSetup).not.toHaveBeenCalled();
  });

  it("is company-scoped: another company's owner is refused, and an agent of another company is not found", async () => {
    const outsider = await createApp(owner("owner", otherCompanyId));
    expect((await request(outsider).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" })).status).toBe(403);

    mockAgentService.getById.mockResolvedValue({ id: agentId, companyId: otherCompanyId, name: "Elsewhere" });
    const app = await createApp(owner());
    const res = await request(app).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" });
    expect(res.status).toBe(404);
    expect(mockLaneAService.checkSetup).not.toHaveBeenCalled();
  });

  it("allows one check per agent every ten seconds", async () => {
    const app = await createApp(owner());
    const first = await request(app).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "main" });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/Please wait \d+ seconds? before checking this agent again/);
    expect(mockLaneAService.checkSetup).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed target", async () => {
    const app = await createApp(owner());
    const res = await request(app).post(`/api/agents/${agentId}/lane-a/check`).send({ companyId, target: "everything" });
    expect(res.status).toBe(400);
  });
});
