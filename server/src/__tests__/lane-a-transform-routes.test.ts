import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DUR-3977 route wiring for POST /api/lane-a/:agentId/transform.
 *
 * The service layer is mocked (same shape as lane-a-routes.test.ts) — what is
 * under test here is who is allowed in and which company they end up acting
 * for, because that is where a cross-company leak would live.
 */

const COMPANY_A = "11111111-1111-4111-8111-111111111112";
const COMPANY_B = "22222222-2222-4222-8222-222222222223";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLaneAService = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  transform: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  laneAService: () => mockLaneAService,
}));

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: COMPANY_A,
    name: "Produkttekster",
    role: "general",
    laneAEnabled: true,
    laneAInstructions: "Skriv om produktteksten på norsk.",
    laneAModel: null,
    laneAMaxOutputTokens: null,
    laneATransformDailyCallCap: null,
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

const serviceActor = (companyId: string) => ({
  type: "service",
  companyId,
  serviceTokenId: "aaaaaaaa-0000-4000-8000-000000000001",
  serviceTokenName: "Nordstrand dashboard",
  source: "company_service_token",
});

const boardActor = (companyIds: string[]) => ({
  type: "board",
  userId: "local-board",
  companyIds,
  memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
  source: "session",
  isInstanceAdmin: false,
});

function transformResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "Ny produkttekst.",
    model: "claude-sonnet-5",
    inputTokens: 120,
    outputTokens: 40,
    costCents: 1,
    truncated: false,
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("POST /api/lane-a/:agentId/transform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLaneAService.transform.mockResolvedValue(transformResult());
  });

  it("transforms one text for a service token of the agent's own company", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform`)
      .send({ input: "Stol i eik.", variables: { vendor: "Møbler AS" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ text: "Ny produkttekst.", model: "claude-sonnet-5", costCents: 1 });
    expect(mockLaneAService.transform).toHaveBeenCalledTimes(1);
    expect(mockLaneAService.transform.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_A,
      input: "Stol i eik.",
      variables: { vendor: "Møbler AS" },
    });
  });

  // The isolation test this endpoint exists to not fail. A token for company A
  // naming an agent of company B must learn nothing — not a 403 that confirms
  // the agent exists, a 404.
  it("cannot reach an agent of another company, and says only 'not found'", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ companyId: COMPANY_B }));
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform`)
      .send({ input: "Stol i eik." });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(COMPANY_B);
    expect(mockLaneAService.transform).not.toHaveBeenCalled();
  });

  it("ignores a companyId the caller tries to smuggle in the body", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform`)
      .send({ input: "Stol i eik.", companyId: COMPANY_B });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLaneAService.transform.mock.calls[0][0].companyId).toBe(COMPANY_A);
  });

  it("ignores a companyId query parameter a service token tries to override with", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform?companyId=${COMPANY_B}`)
      .send({ input: "Stol i eik." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLaneAService.transform.mock.calls[0][0].companyId).toBe(COMPANY_A);
  });

  it("refuses an agent-authenticated caller outright", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_A,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform`)
      .send({ input: "Stol i eik." });

    expect(res.status).toBe(403);
    expect(mockLaneAService.transform).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform`)
      .send({ input: "Stol i eik." });

    expect(res.status).toBe(403);
    expect(mockLaneAService.transform).not.toHaveBeenCalled();
  });

  it("lets a board user call it for one of their own companies", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(boardActor([COMPANY_A]));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform?companyId=${COMPANY_A}`)
      .send({ input: "Stol i eik." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLaneAService.transform.mock.calls[0][0].companyId).toBe(COMPANY_A);
  });

  it("refuses a board user reaching for a company they are not in", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ companyId: COMPANY_B }));
    const app = await createApp(boardActor([COMPANY_A]));

    const res = await request(app)
      .post(`/api/lane-a/${AGENT_ID}/transform?companyId=${COMPANY_B}`)
      .send({ input: "Stol i eik." });

    expect(res.status).toBe(403);
    expect(mockLaneAService.transform).not.toHaveBeenCalled();
  });

  it("rejects an empty input before anything is spent", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app).post(`/api/lane-a/${AGENT_ID}/transform`).send({ input: "   " });

    expect(res.status).toBe(400);
    expect(mockLaneAService.transform).not.toHaveBeenCalled();
  });

  it("passes the per-agent settings through to the service", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ laneAModel: "claude-haiku-4-5", laneAMaxOutputTokens: 400, laneATransformDailyCallCap: 50 }),
    );
    const app = await createApp(serviceActor(COMPANY_A));

    await request(app).post(`/api/lane-a/${AGENT_ID}/transform`).send({ input: "Stol i eik." });

    expect(mockLaneAService.transform.mock.calls[0][0].targetAgent).toMatchObject({
      laneAModel: "claude-haiku-4-5",
      laneAMaxOutputTokens: 400,
      laneATransformDailyCallCap: 50,
    });
  });

  it("surfaces a limit refusal as a 429 with a machine-readable reason", async () => {
    const { tooManyRequests } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockLaneAService.transform.mockRejectedValue(
      tooManyRequests("Daily limit reached.", { reason: "daily_call_cap", limit: 2000, used: 2000 }),
    );
    const app = await createApp(serviceActor(COMPANY_A));

    const res = await request(app).post(`/api/lane-a/${AGENT_ID}/transform`).send({ input: "Stol i eik." });

    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).toContain("daily_call_cap");
  });
});
