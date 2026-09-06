import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLaneAService = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  laneAService: () => mockLaneAService,
}));

function makeAgent(overrides: Partial<{ id: string; companyId: string; name: string; laneAEnabled: boolean }> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "11111111-1111-4111-8111-111111111112",
    name: "Agent",
    laneAEnabled: true,
    ...overrides,
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

describe("lane A routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s when the target agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["11111111-1111-4111-8111-111111111112"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/lane-a/11111111-1111-4111-8111-111111111111/messages")
      .send({ companyId: "11111111-1111-4111-8111-111111111112", message: "hi" });

    expect(res.status).toBe(404);
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to a different company than the request body claims", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ companyId: "22222222-2222-4222-8222-222222222223" }));
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/lane-a/11111111-1111-4111-8111-111111111111/messages")
      .send({ companyId: "11111111-1111-4111-8111-111111111112", message: "hi" });

    expect(res.status).toBe(404);
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an agent-authenticated caller scoped to a different company", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp({
      type: "agent",
      agentId: "caller-agent",
      companyId: "22222222-2222-4222-8222-222222222223",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/lane-a/11111111-1111-4111-8111-111111111111/messages")
      .send({ companyId: "11111111-1111-4111-8111-111111111112", message: "hi" });

    expect(res.status).toBe(403);
    expect(mockLaneAService.sendMessage).not.toHaveBeenCalled();
  });

  it("forwards a board-authenticated request as a user requester", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.sendMessage.mockResolvedValue({
      conversationId: "conv-1",
      response: "hello",
      turnCount: 1,
      stopReason: "end_turn",
    });
    const app = await createApp({
      type: "board",
      userId: "board-user-1",
      companyIds: ["11111111-1111-4111-8111-111111111112"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/lane-a/11111111-1111-4111-8111-111111111111/messages")
      .send({ companyId: "11111111-1111-4111-8111-111111111112", message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversationId: "conv-1", response: "hello" });
    expect(mockLaneAService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: { userId: "board-user-1", agentId: null },
      }),
    );
  });

  it("forwards an agent-authenticated request as an agent requester", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.sendMessage.mockResolvedValue({
      conversationId: "conv-2",
      response: "hello",
      turnCount: 1,
      stopReason: "end_turn",
    });
    const app = await createApp({
      type: "agent",
      agentId: "caller-agent",
      companyId: "11111111-1111-4111-8111-111111111112",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/lane-a/11111111-1111-4111-8111-111111111111/messages")
      .send({ companyId: "11111111-1111-4111-8111-111111111112", message: "hi" });

    expect(res.status).toBe(200);
    expect(mockLaneAService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: { userId: null, agentId: "caller-agent" },
      }),
    );
  });
});
