// DUR-133/DUR-185 follow-up, revised for DUR-4000: these tests pin the route
// surface the persona screens (ui/src/api/personas.ts) depend on. A persona
// is a person with its own fields; the routes never touch an agent's name.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { forbidden } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const personaId = "33333333-3333-4333-8333-333333333333";

const basePersona = {
  id: personaId,
  companyId,
  displayName: "Maja",
  pronouns: "she/her",
  traits: "curious",
  backstory: "A photographer.",
  bio: "A photographer.",
  voice: "Warm, direct.",
  avatarAssetId: null,
  handle: "maja",
  status: "active",
  publishingPaused: false,
  agentIds: [agentId],
  agentId,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPersonaService = vi.hoisted(() => ({
  createPersona: vi.fn(),
  createPersonaForCompany: vi.fn(),
  getPersonaViewByAgentId: vi.fn(),
  getPersonaById: vi.fn(),
  listPersonasForCompany: vi.fn(),
  listAgentsForPersona: vi.fn(),
  updatePersona: vi.fn(),
  updatePersonaById: vi.fn(),
  deletePersonaById: vi.fn(),
  attachPersonaToAgent: vi.fn(),
}));

vi.mock("../services/personas.js", () => ({
  personaService: () => mockPersonaService,
}));

const mockAuthz = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../routes/authz.js", () => mockAuthz);

async function buildApp(fakeDb: object = {}) {
  const { personaRoutes } = await import("../routes/personas.js");
  const app = express();
  app.use(express.json());
  app.use("/api", personaRoutes(withFakeCompanyScopeReserve(fakeDb) as never));
  app.use(errorHandler);
  return app;
}

const dbWithAgent = {
  select: () => ({
    from: () => ({ where: () => Promise.resolve([{ id: agentId, companyId }]) }),
  }),
};

describe("persona routes — board-only, match the UI's api client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
  });

  it("rejects agent-authenticated callers on every route", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      throw forbidden("Board access required");
    });
    const app = await buildApp();

    const list = await request(app).get(`/api/companies/${companyId}/personas`);
    const create = await request(app).post(`/api/companies/${companyId}/personas`).send({ displayName: "Maja" });
    const get = await request(app).get(`/api/personas/${personaId}`);
    const patch = await request(app).patch(`/api/personas/${personaId}`).send({ handle: "x" });
    const del = await request(app).delete(`/api/personas/${personaId}`);
    const attach = await request(app).put(`/api/agents/${agentId}/persona`).send({ personaId });
    const jobs = await request(app).get(`/api/companies/${companyId}/personas/${personaId}/agents`);

    for (const res of [list, create, get, patch, del, attach, jobs]) {
      expect(res.status).toBe(403);
    }
  });

  it("GET /companies/:id/personas returns the list the Personas page renders", async () => {
    mockPersonaService.listPersonasForCompany.mockResolvedValue([basePersona]);
    const app = await buildApp();

    const res = await request(app).get(`/api/companies/${companyId}/personas`);

    expect(res.status).toBe(200);
    expect(mockPersonaService.listPersonasForCompany).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([expect.objectContaining({ id: personaId, displayName: "Maja", pronouns: "she/her", agentIds: [agentId] })]);
  });

  it("POST /agents/:agentId/persona creates a person and attaches it to that job (the create form's route)", async () => {
    mockPersonaService.createPersona.mockResolvedValue(basePersona);
    const app = await buildApp(dbWithAgent);

    const res = await request(app)
      .post(`/api/agents/${agentId}/persona`)
      .send({ displayName: "Maja", pronouns: "she/her", handle: "maja", status: "active", traits: "curious" });

    expect(res.status).toBe(201);
    expect(mockPersonaService.createPersona).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ displayName: "Maja", pronouns: "she/her", traits: "curious" }),
    );
  });

  it("POST /companies/:id/personas creates a person without a job", async () => {
    mockPersonaService.createPersonaForCompany.mockResolvedValue({ ...basePersona, agentIds: [], agentId: null });
    const app = await buildApp();

    const res = await request(app).post(`/api/companies/${companyId}/personas`).send({ displayName: "Maja" });

    expect(res.status).toBe(201);
    expect(mockPersonaService.createPersonaForCompany).toHaveBeenCalledWith(companyId, expect.objectContaining({ displayName: "Maja" }));
    expect(res.body.agentIds).toEqual([]);
  });

  it("requires a name to create a person", async () => {
    const app = await buildApp(dbWithAgent);

    const res = await request(app).post(`/api/agents/${agentId}/persona`).send({ handle: "maja" });

    expect(res.status).toBe(400);
    expect(mockPersonaService.createPersona).not.toHaveBeenCalled();
  });

  it("still accepts the old `bio` field name and folds it into `backstory`", async () => {
    mockPersonaService.createPersona.mockResolvedValue(basePersona);
    const app = await buildApp(dbWithAgent);

    const res = await request(app).post(`/api/agents/${agentId}/persona`).send({ displayName: "Maja", bio: "A photographer." });

    expect(res.status).toBe(201);
    const input = mockPersonaService.createPersona.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.backstory).toBe("A photographer.");
    expect(input).not.toHaveProperty("bio");
  });

  it("silently drops the retired dailyGenerationCap field instead of failing the old form", async () => {
    mockPersonaService.createPersona.mockResolvedValue(basePersona);
    const app = await buildApp(dbWithAgent);

    const res = await request(app).post(`/api/agents/${agentId}/persona`).send({ displayName: "Maja", dailyGenerationCap: 5 });

    expect(res.status).toBe(201);
    const input = mockPersonaService.createPersona.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).not.toHaveProperty("dailyGenerationCap");
  });

  it("GET /personas/:id returns the persona the detail page loads", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(basePersona);
    const app = await buildApp();

    const res = await request(app).get(`/api/personas/${personaId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: personaId, backstory: "A photographer.", bio: "A photographer." }));
  });

  it("GET /personas/:id 404s when the persona does not exist", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(null);
    const app = await buildApp();

    const res = await request(app).get(`/api/personas/${personaId}`);

    expect(res.status).toBe(404);
  });

  it("PATCH /personas/:id updates the person's own fields via the id-scoped route", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(basePersona);
    mockPersonaService.updatePersonaById.mockResolvedValue({ ...basePersona, voice: "Playful" });
    const app = await buildApp();

    const res = await request(app).patch(`/api/personas/${personaId}`).send({ voice: "Playful" });

    expect(res.status).toBe(200);
    expect(mockPersonaService.updatePersonaById).toHaveBeenCalledWith(personaId, expect.objectContaining({ voice: "Playful" }));
    expect(res.body.voice).toBe("Playful");
  });

  it("refuses a voice longer than an agent's tone (600 characters): it fills the same prompt slot", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(basePersona);
    const app = await buildApp();

    const res = await request(app).patch(`/api/personas/${personaId}`).send({ voice: "x".repeat(601) });

    expect(res.status).toBe(400);
    expect(mockPersonaService.updatePersonaById).not.toHaveBeenCalled();
  });

  it("DELETE /personas/:id deletes via the id-scoped route the delete dialog calls", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(basePersona);
    mockPersonaService.deletePersonaById.mockResolvedValue(undefined);
    const app = await buildApp();

    const res = await request(app).delete(`/api/personas/${personaId}`);

    expect(res.status).toBe(204);
    expect(mockPersonaService.deletePersonaById).toHaveBeenCalledWith(personaId);
  });

  it("PUT /agents/:agentId/persona attaches an existing person to a job, and detaches with null", async () => {
    mockPersonaService.attachPersonaToAgent.mockResolvedValueOnce(basePersona).mockResolvedValueOnce(null);
    const app = await buildApp(dbWithAgent);

    const attach = await request(app).put(`/api/agents/${agentId}/persona`).send({ personaId });
    expect(attach.status).toBe(200);
    expect(mockPersonaService.attachPersonaToAgent).toHaveBeenCalledWith(agentId, personaId);
    expect(attach.body.id).toBe(personaId);

    const detach = await request(app).put(`/api/agents/${agentId}/persona`).send({ personaId: null });
    expect(detach.status).toBe(204);
    expect(mockPersonaService.attachPersonaToAgent).toHaveBeenLastCalledWith(agentId, null);
  });

  it("GET /companies/:id/personas/:personaId/agents lists the jobs the person holds", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue(basePersona);
    mockPersonaService.listAgentsForPersona.mockResolvedValue([
      { id: agentId, name: "Sales agent 1", role: "sales", title: null, status: "idle", laneAEnabled: false },
    ]);
    const app = await buildApp();

    const res = await request(app).get(`/api/companies/${companyId}/personas/${personaId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: agentId, name: "Sales agent 1" })]);
  });

  it("GET /companies/:id/personas/:personaId/agents 404s for a persona of another company", async () => {
    mockPersonaService.getPersonaById.mockResolvedValue({ ...basePersona, companyId: "44444444-4444-4444-8444-444444444444" });
    const app = await buildApp();

    const res = await request(app).get(`/api/companies/${companyId}/personas/${personaId}/agents`);

    expect(res.status).toBe(404);
    expect(mockPersonaService.listAgentsForPersona).not.toHaveBeenCalled();
  });
});
