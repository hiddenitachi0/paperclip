import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two routes behind Telegram's /cont and /looks: board users only, the
 * company from the request checked against the caller and the agent, and the
 * spec passed through as data.
 */

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLaneAService = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  continueConversation: vi.fn(),
  listLooks: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  laneAService: () => mockLaneAService,
}));

const AGENT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "11111111-1111-4111-8111-111111111112";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222223";

function makeAgent(companyId = COMPANY) {
  return { id: AGENT, companyId, name: "Maja", role: "general", laneAEnabled: true };
}

const boardActor = {
  type: "board",
  userId: "filip",
  companyIds: [COMPANY],
  source: "session",
  isInstanceAdmin: false,
};

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

describe("continue and looks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continue forwards the board user, the company and the spec", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.continueConversation.mockResolvedValue({
      conversationId: "conv-2",
      mode: "time",
      recap: "the last 45 minutes (2 messages).",
      matchedMessages: 2,
      consideredMessages: 2,
      fromConversations: 1,
      window: null,
    });
    const app = await createApp(boardActor);

    const res = await request(app)
      .post(`/api/lane-a/${AGENT}/continue`)
      .send({ companyId: COMPANY, spec: "last 45 minutes" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversationId: "conv-2", recap: "the last 45 minutes (2 messages)." });
    expect(mockLaneAService.continueConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY,
        requester: { userId: "filip", agentId: null },
        spec: "last 45 minutes",
        targetAgent: expect.objectContaining({ id: AGENT, laneAEnabled: true }),
      }),
    );
  });

  it("continue refuses an agent key, a service token and a delegate before anything is read", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    for (const actor of [
      { type: "agent", agentId: "caller", companyId: COMPANY, source: "agent_key" },
      { type: "service", companyId: COMPANY, source: "service_token" },
      { type: "board_delegate", userId: "filip", companyIds: [COMPANY], delegateScopes: [] },
    ]) {
      const res = await request(await createApp(actor))
        .post(`/api/lane-a/${AGENT}/continue`)
        .send({ companyId: COMPANY });
      expect(res.status, actor.type).toBe(403);
    }
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockLaneAService.continueConversation).not.toHaveBeenCalled();
  });

  it("continue 404s for another company's agent and 403s for a company the caller cannot see", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(OTHER_COMPANY));
    const app = await createApp(boardActor);
    const res = await request(app).post(`/api/lane-a/${AGENT}/continue`).send({ companyId: COMPANY });
    expect(res.status).toBe(404);

    const blocked = await request(app).post(`/api/lane-a/${AGENT}/continue`).send({ companyId: OTHER_COMPANY });
    expect(blocked.status).toBe(403);
    expect(mockLaneAService.continueConversation).not.toHaveBeenCalled();
  });

  it("continue rejects a spec over 200 characters and unknown fields", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(boardActor);
    const long = await request(app)
      .post(`/api/lane-a/${AGENT}/continue`)
      .send({ companyId: COMPANY, spec: "x".repeat(201) });
    expect(long.status).toBe(400);
    const extra = await request(app)
      .post(`/api/lane-a/${AGENT}/continue`)
      .send({ companyId: COMPANY, requesterUserId: "someone-else" });
    expect(extra.status).toBe(400);
    expect(mockLaneAService.continueConversation).not.toHaveBeenCalled();
  });

  it("looks is board-only and scoped to the agent's company", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.listLooks.mockResolvedValue({ available: true, text: "Saved looks:\n- Nordic" });
    const ok = await request(await createApp(boardActor)).get(`/api/lane-a/${AGENT}/looks?companyId=${COMPANY}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ available: true, text: "Saved looks:\n- Nordic" });

    const agentCaller = await request(
      await createApp({ type: "agent", agentId: "caller", companyId: COMPANY, source: "agent_key" }),
    ).get(`/api/lane-a/${AGENT}/looks?companyId=${COMPANY}`);
    expect(agentCaller.status).toBe(403);

    mockAgentService.getById.mockResolvedValue(makeAgent(OTHER_COMPANY));
    const foreign = await request(await createApp(boardActor)).get(`/api/lane-a/${AGENT}/looks?companyId=${COMPANY}`);
    expect(foreign.status).toBe(404);
    expect(mockLaneAService.listLooks).toHaveBeenCalledTimes(1);
  });
});
