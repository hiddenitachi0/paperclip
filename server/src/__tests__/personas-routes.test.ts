// DUR-133/DUR-185 follow-up: the Personas page (PR #116) called endpoints
// that never existed on the backend (GET /companies/:id/personas,
// GET|PATCH|DELETE /personas/:id) -- every page load 404'd. These tests
// pin the actual route surface the UI (ui/src/api/personas.ts) depends on.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { forbidden } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const personaId = "33333333-3333-4333-8333-333333333333";

const basePersona = {
  id: personaId,
  companyId,
  agentId,
  displayName: "Maja",
  handle: "maja",
  bio: "A photographer.",
  voice: "Warm, direct.",
  avatarAssetId: null,
  status: "active",
  dailyGenerationCap: 5,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPersonaService = vi.hoisted(() => ({
  createPersona: vi.fn(),
  getPersonaByAgentId: vi.fn(),
  getPersonaWithAgentById: vi.fn(),
  listPersonasForCompany: vi.fn(),
  updatePersona: vi.fn(),
  updatePersonaById: vi.fn(),
  deletePersonaById: vi.fn(),
}));

vi.mock("../services/personas.js", () => ({
  personaService: () => mockPersonaService,
}));

const mockAuthz = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../routes/authz.js", () => mockAuthz);

async function buildApp(fakeDb: unknown = {}) {
  const { personaRoutes } = await import("../routes/personas.js");
  const app = express();
  app.use(express.json());
  app.use("/api", personaRoutes(fakeDb as never));
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
    const get = await request(app).get(`/api/personas/${personaId}`);
    const patch = await request(app).patch(`/api/personas/${personaId}`).send({ handle: "x" });
    const del = await request(app).delete(`/api/personas/${personaId}`);

    expect(list.status).toBe(403);
    expect(get.status).toBe(403);
    expect(patch.status).toBe(403);
    expect(del.status).toBe(403);
  });

  it("GET /companies/:id/personas returns the joined list the Personas page renders", async () => {
    mockPersonaService.listPersonasForCompany.mockResolvedValue([basePersona]);
    const app = await buildApp();

    const res = await request(app).get(`/api/companies/${companyId}/personas`);

    expect(res.status).toBe(200);
    expect(mockPersonaService.listPersonasForCompany).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([expect.objectContaining({ id: personaId, displayName: "Maja", dailyGenerationCap: 5 })]);
  });

  it("POST /agents/:agentId/persona creates against the agent-scoped route the create form calls", async () => {
    mockPersonaService.createPersona.mockResolvedValue(basePersona);
    const app = await buildApp(dbWithAgent);

    const res = await request(app)
      .post(`/api/agents/${agentId}/persona`)
      .send({ displayName: "Maja", handle: "maja", status: "active", dailyGenerationCap: 5 });

    expect(res.status).toBe(201);
    expect(mockPersonaService.createPersona).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ displayName: "Maja", dailyGenerationCap: 5 }),
    );
  });

  it("GET /personas/:id returns the persona the detail page loads", async () => {
    mockPersonaService.getPersonaWithAgentById.mockResolvedValue(basePersona);
    const app = await buildApp();

    const res = await request(app).get(`/api/personas/${personaId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: personaId }));
  });

  it("GET /personas/:id 404s when the persona does not exist", async () => {
    mockPersonaService.getPersonaWithAgentById.mockResolvedValue(null);
    const app = await buildApp();

    const res = await request(app).get(`/api/personas/${personaId}`);

    expect(res.status).toBe(404);
  });

  it("PATCH /personas/:id updates via the id-scoped route the edit form calls", async () => {
    mockPersonaService.getPersonaWithAgentById.mockResolvedValue(basePersona);
    mockPersonaService.updatePersonaById.mockResolvedValue({ ...basePersona, dailyGenerationCap: 10 });
    const app = await buildApp();

    const res = await request(app).patch(`/api/personas/${personaId}`).send({ dailyGenerationCap: 10 });

    expect(res.status).toBe(200);
    expect(mockPersonaService.updatePersonaById).toHaveBeenCalledWith(
      personaId,
      expect.objectContaining({ dailyGenerationCap: 10 }),
    );
    expect(res.body.dailyGenerationCap).toBe(10);
  });

  it("DELETE /personas/:id deletes via the id-scoped route the delete dialog calls", async () => {
    mockPersonaService.getPersonaWithAgentById.mockResolvedValue(basePersona);
    mockPersonaService.deletePersonaById.mockResolvedValue(undefined);
    const app = await buildApp();

    const res = await request(app).delete(`/api/personas/${personaId}`);

    expect(res.status).toBe(204);
    expect(mockPersonaService.deletePersonaById).toHaveBeenCalledWith(personaId);
  });

  it("rejects a cap of 0 as invalid (must be a positive integer, per DUR-63)", async () => {
    const app = await buildApp(dbWithAgent);

    const res = await request(app)
      .post(`/api/agents/${agentId}/persona`)
      .send({ displayName: "Maja", dailyGenerationCap: 0 });

    expect(res.status).toBe(400);
    expect(mockPersonaService.createPersona).not.toHaveBeenCalled();
  });
});
