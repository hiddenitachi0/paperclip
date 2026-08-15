import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "11111111-1111-4111-8111-111111111111";
const ceoAgentId = "ceo-agent-a";

const mockCompanyInstructionsService = vi.hoisted(() => ({
  getFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => ({ upsertPolicy: vi.fn() }),
    companyArtifactsService: () => ({ list: vi.fn() }),
    companyInstructionsService: () => mockCompanyInstructionsService,
    companyPortabilityService: () => ({
      exportBundle: vi.fn(),
      previewExport: vi.fn(),
      previewImport: vi.fn(),
      importBundle: vi.fn(),
    }),
    companyService: () => mockCompanyService,
    feedbackService: () => ({ listFeedbackTraces: vi.fn() }),
    logActivity: mockLogActivity,
  }));
}

let appImportCounter = 0;

async function createApp(actor: Record<string, unknown>) {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?company-instructions-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?company-instructions-routes-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user-1",
    userName: "Board User",
    userEmail: "board@example.com",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  };
}

function ceoAgentActor() {
  return {
    type: "agent",
    agentId: ceoAgentId,
    companyId,
    source: "agent_key",
    runId: "run-1",
  };
}

function nonCeoAgentActor() {
  return {
    type: "agent",
    agentId: "engineer-agent",
    companyId,
    source: "agent_key",
    runId: "run-2",
  };
}

describe("company instructions routes (DUR-33)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, explanation: "allowed" });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ceoAgentId) return { id, companyId, role: "ceo" };
      if (id === "engineer-agent") return { id, companyId, role: "engineer" };
      return null;
    });
    mockCompanyInstructionsService.getFile.mockResolvedValue({
      path: "COMPANY.md",
      content: "1. Rule one.",
      exists: true,
      size: 12,
    });
    mockCompanyInstructionsService.writeFile.mockImplementation(async (_companyId: string, content: string) => ({
      path: "COMPANY.md",
      content,
      exists: true,
      size: content.length,
    }));
    mockCompanyInstructionsService.deleteFile.mockResolvedValue(undefined);
  });

  it("lets a board actor read COMPANY.md", async () => {
    const app = await createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/instructions`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("1. Rule one.");
  });

  it("lets a board actor write COMPANY.md", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .put(`/api/companies/${companyId}/instructions`)
      .send({ content: "1. New rule." });
    expect(res.status).toBe(200);
    expect(mockCompanyInstructionsService.writeFile).toHaveBeenCalledWith(companyId, "1. New rule.");
  });

  it("blocks an agent-authenticated request from writing COMPANY.md, even a CEO agent", async () => {
    const app = await createApp(ceoAgentActor());
    const res = await request(app)
      .put(`/api/companies/${companyId}/instructions`)
      .send({ content: "1. Sneaky rule change." });
    expect(res.status).toBe(403);
    expect(mockCompanyInstructionsService.writeFile).not.toHaveBeenCalled();
  });

  it("blocks a non-CEO agent-authenticated request from writing COMPANY.md", async () => {
    const app = await createApp(nonCeoAgentActor());
    const res = await request(app)
      .put(`/api/companies/${companyId}/instructions`)
      .send({ content: "1. Sneaky rule change." });
    expect(res.status).toBe(403);
    expect(mockCompanyInstructionsService.writeFile).not.toHaveBeenCalled();
  });

  it("blocks an agent-authenticated request from deleting COMPANY.md", async () => {
    const app = await createApp(ceoAgentActor());
    const res = await request(app).delete(`/api/companies/${companyId}/instructions`);
    expect(res.status).toBe(403);
    expect(mockCompanyInstructionsService.deleteFile).not.toHaveBeenCalled();
  });

  it("lets a board actor delete COMPANY.md", async () => {
    const app = await createApp(boardActor());
    const res = await request(app).delete(`/api/companies/${companyId}/instructions`);
    expect(res.status).toBe(204);
    expect(mockCompanyInstructionsService.deleteFile).toHaveBeenCalledWith(companyId);
  });

  it("still lets an agent read COMPANY.md for its own company", async () => {
    const app = await createApp(ceoAgentActor());
    const res = await request(app).get(`/api/companies/${companyId}/instructions`);
    expect(res.status).toBe(200);
  });
});
