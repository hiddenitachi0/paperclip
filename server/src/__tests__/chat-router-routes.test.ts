import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

// DUR-220: one endpoint the chat surface calls, classifying cheap-question vs
// real-work traffic and dispatching to Lane A (DUR-217) or Lane B (DUR-219)
// without the caller needing to know which lane handled it.

const companyId = "11111111-1111-4111-8111-111111111112";
const otherCompanyId = "22222222-2222-4222-8222-222222222223";
const targetAgentId = "11111111-1111-4111-8111-111111111111";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockLaneAService = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

const mockSecretaryClassifierService = vi.hoisted(() => ({
  classify: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  laneAService: () => mockLaneAService,
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: vi.fn(async () => undefined),
  secretaryClassifierService: () => mockSecretaryClassifierService,
}));

function makeAgent(overrides: Partial<{ id: string; companyId: string; name: string; laneAEnabled: boolean }> = {}) {
  return {
    id: targetAgentId,
    companyId,
    name: "Agent",
    laneAEnabled: true,
    ...overrides,
  };
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "board-user-1",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ chatRouterRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/chat-router.js")>("../routes/chat-router.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", chatRouterRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("chat router routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "tasks:assign", explanation: "ok" });
  });

  it("404s when the target agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "how many agents are on the team right now?" });

    expect(res.status).toBe(404);
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to a different company than the request body claims", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ companyId: otherCompanyId }));
    const app = await createApp(boardActor({ companyIds: [companyId, otherCompanyId] }));

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "how many agents are on the team right now?" });

    expect(res.status).toBe(404);
  });

  it("routes a short question to Lane A", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.sendMessage.mockResolvedValue({
      conversationId: "conv-1",
      response: "All green.",
      turnCount: 1,
      stopReason: "end_turn",
    });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "how many agents are on the team right now?" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lane: "a",
      result: { conversationId: "conv-1", response: "All green.", turnCount: 1, stopReason: "end_turn" },
      taskRef: null,
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("routes a long message describing real work to Lane B", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      identifier: "PAP-42",
      status: "todo",
      assigneeAgentId: targetAgentId,
    });
    const app = await createApp(boardActor());
    const longText = "Please rewrite the onboarding email copy end to end. ".repeat(10);

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: longText });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      lane: "b",
      result: null,
      taskRef: { issueId: "issue-1", identifier: "PAP-42", status: "todo" },
    });
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ assigneeAgentId: targetAgentId, status: "todo" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      targetAgentId,
      expect.objectContaining({ payload: expect.objectContaining({ issueId: "issue-1" }) }),
    );
  });

  it("routes a short message with a work keyword to Lane B", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockIssueService.create.mockResolvedValue({
      id: "issue-2",
      identifier: "PAP-43",
      status: "todo",
      assigneeAgentId: targetAgentId,
    });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "please fix the broken build" });

    expect(res.status).toBe(201);
    expect(res.body.lane).toBe("b");
  });

  it("honors an explicit laneHint over the heuristic", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.sendMessage.mockResolvedValue({
      conversationId: "conv-2",
      response: "ok",
      turnCount: 1,
      stopReason: "end_turn",
    });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "please fix the broken build", laneHint: "a" });

    expect(res.status).toBe(200);
    expect(res.body.lane).toBe("a");
    expect(mockLaneAService.sendMessage).toHaveBeenCalled();
  });

  it("falls back to Lane B when an 'a' hint exceeds Lane A's message cap", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockIssueService.create.mockResolvedValue({
      id: "issue-3",
      identifier: "PAP-44",
      status: "todo",
      assigneeAgentId: targetAgentId,
    });
    const app = await createApp(boardActor());
    const overLong = "x".repeat(8_001);

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: overLong, laneHint: "a" });

    expect(res.status).toBe(201);
    expect(res.body.lane).toBe("b");
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "   " });

    expect(res.status).toBe(400);
  });

  it("rejects a Lane B dispatch the actor is not authorized to assign", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAccessService.decide.mockResolvedValue({ allowed: false, action: "tasks:assign", explanation: "nope" });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/chat/${targetAgentId}/messages`)
      .send({ companyId, message: "please build the new dashboard widget" });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});

// DUR-251/DUR-335: the secretary classifier step Simple Mode calls before
// send. The route's job is just to build the roster from companyId and hand
// off to the service — the service's own classification logic is covered by
// secretary-classifier-service.test.ts.
describe("POST /chat/classify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "tasks:assign", explanation: "ok" });
  });

  it("builds the roster from active company agents and returns the classification", async () => {
    mockAgentService.list.mockResolvedValue([
      { id: "agent-1", name: "CEO", role: "ceo", status: "idle" },
      { id: "agent-2", name: "Backend Engineer", role: "engineer", status: "running" },
      { id: "agent-3", name: "Retired Agent", role: "engineer", status: "terminated" },
      { id: "agent-4", name: "Paused Agent", role: "engineer", status: "paused" },
    ]);
    mockSecretaryClassifierService.classify.mockResolvedValue({
      lane: "b",
      targetAgentId: "agent-2",
      reasoning: "This is a build task, so it goes to the engineer.",
    });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post("/api/chat/classify")
      .send({ companyId, message: "please fix the broken build" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lane: "b",
      targetAgentId: "agent-2",
      reasoning: "This is a build task, so it goes to the engineer.",
    });
    expect(mockSecretaryClassifierService.classify).toHaveBeenCalledWith({
      message: "please fix the broken build",
      roster: [
        { id: "agent-1", name: "CEO", role: "ceo" },
        { id: "agent-2", name: "Backend Engineer", role: "engineer" },
      ],
    });
  });

  it("propagates a classifier failure as an error response rather than a fabricated pick", async () => {
    mockAgentService.list.mockResolvedValue([{ id: "agent-1", name: "CEO", role: "ceo", status: "idle" }]);
    mockSecretaryClassifierService.classify.mockRejectedValue(
      new HttpError(503, "Secretary classifier is not configured on this instance"),
    );
    const app = await createApp(boardActor());

    const res = await request(app)
      .post("/api/chat/classify")
      .send({ companyId, message: "please fix the broken build" });

    expect(res.status).toBe(503);
  });

  it("rejects an empty message", async () => {
    const app = await createApp(boardActor());

    const res = await request(app).post("/api/chat/classify").send({ companyId, message: "   " });

    expect(res.status).toBe(400);
    expect(mockSecretaryClassifierService.classify).not.toHaveBeenCalled();
  });
});
