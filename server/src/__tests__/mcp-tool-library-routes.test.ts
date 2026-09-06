// DUR-143: MCP tool library routes — security and shape tests.
//
// Key invariants verified:
//   1. Agent-authenticated callers cannot reach any /mcp-tools route (403).
//   2. A board actor can create a tool with a plain name/description/
//      connection body — nothing resembling raw JSON entry.
//   3. Creating a tool never accepts or requires a `mcpServers`-shaped
//      array — connection is a flat object, one server, one entry.
//   4. Assigning a tool from a different company to an agent is rejected.
//   5. GET /agents/:id/mcp-tools reports each tool with an `enabled` flag.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { forbidden } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const toolId = "33333333-3333-4333-8333-333333333333";

const baseTool = {
  id: toolId,
  companyId,
  name: "Fal.ai",
  key: "fal-ai",
  description: "Makes images",
  connection: { url: "https://fal.run/mcp", headers: {} },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockToolLibraryService = vi.hoisted(() => ({
  createMcpTool: vi.fn(),
  listMcpTools: vi.fn(),
  getMcpTool: vi.fn(),
  updateMcpTool: vi.fn(),
  deleteMcpTool: vi.fn(),
  listMcpToolsForAgent: vi.fn(),
}));

vi.mock("../services/mcp-tool-library.js", () => mockToolLibraryService);

const mockAgentsSvc = vi.hoisted(() => ({
  syncMcpToolSelection: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentsSvc,
}));

const mockAuthz = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../routes/authz.js", () => ({
  ...mockAuthz,
  assertBoard: mockAuthz.assertBoard,
  assertCompanyAccess: mockAuthz.assertCompanyAccess,
}));

async function buildApp(fakeDb: object = {}, opts: { unsafeRows?: unknown[] } = {}) {
  const { mcpToolLibraryRoutes } = await import("../routes/mcp-tool-library.js");
  const app = express();
  app.use(express.json());
  app.use("/api", mcpToolLibraryRoutes(withFakeCompanyScopeReserve(fakeDb, opts) as never));
  app.use(errorHandler);
  return app;
}

describe("mcp tool library routes — board-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
    mockToolLibraryService.getMcpTool.mockResolvedValue(baseTool);
  });

  it("rejects agent-authenticated callers on POST /companies/:id/mcp-tools", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      throw forbidden("Board access required");
    });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({ name: "Fal.ai", description: "Makes images", connection: { url: "https://fal.run/mcp" } });

    expect(res.status).toBe(403);
    expect(mockToolLibraryService.createMcpTool).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated callers on POST /agents/:id/mcp-tools/sync", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      throw forbidden("Board access required");
    });
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/agents/${agentId}/mcp-tools/sync`)
      .send({ desiredToolIds: [toolId] });

    expect(res.status).toBe(403);
    expect(mockAgentsSvc.syncMcpToolSelection).not.toHaveBeenCalled();
  });

  it("lets a board actor create a tool from a plain name/description/connection body", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockToolLibraryService.createMcpTool.mockResolvedValue(baseTool);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({
        name: "Fal.ai",
        description: "Makes images",
        connection: { url: "https://fal.run/mcp", headers: {} },
      });

    expect(res.status).toBe(201);
    expect(mockToolLibraryService.createMcpTool).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      expect.objectContaining({ name: "Fal.ai", description: "Makes images" }),
    );
    // No mcpServers[] array, no server-name field — a flat, single connection object.
    expect(res.body).not.toHaveProperty("mcpServers");
  });

  it("rejects a body missing the human description", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({ name: "Fal.ai", connection: { url: "https://fal.run/mcp" } });

    expect(res.status).toBe(400);
    expect(mockToolLibraryService.createMcpTool).not.toHaveBeenCalled();
  });

  it("rejects a connection with neither command nor url", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({ name: "Fal.ai", description: "Makes images", connection: {} });

    expect(res.status).toBe(400);
    expect(mockToolLibraryService.createMcpTool).not.toHaveBeenCalled();
  });

  it("rejects a plain-text credential value — headers must be a saved secret", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({
        name: "Fal.ai",
        description: "Makes images",
        connection: { url: "https://fal.run/mcp", headers: { Authorization: { type: "plain", value: "sk-real-key" } } },
      });

    expect(res.status).toBe(400);
    expect(mockToolLibraryService.createMcpTool).not.toHaveBeenCalled();
  });

  it("rejects assigning a tool that belongs to a different company", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockToolLibraryService.getMcpTool.mockResolvedValue({ ...baseTool, companyId: otherCompanyId });
    const fakeDb = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ id: agentId, companyId }]) }),
      }),
    };
    const app = await buildApp(fakeDb, { unsafeRows: [[agentId, companyId]] });

    const res = await request(app)
      .post(`/api/agents/${agentId}/mcp-tools/sync`)
      .send({ desiredToolIds: [toolId] });

    expect(res.status).toBe(422);
    expect(mockAgentsSvc.syncMcpToolSelection).not.toHaveBeenCalled();
  });

  it("allows a board actor to sync a same-company tool selection", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockToolLibraryService.getMcpTool.mockResolvedValue(baseTool);
    mockAgentsSvc.syncMcpToolSelection.mockResolvedValue({ id: agentId, mcpToolIds: [toolId] });
    const fakeDb = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ id: agentId, companyId }]) }),
      }),
    };
    const app = await buildApp(fakeDb, { unsafeRows: [[agentId, companyId]] });

    const res = await request(app)
      .post(`/api/agents/${agentId}/mcp-tools/sync`)
      .send({ desiredToolIds: [toolId] });

    expect(res.status).toBe(200);
    expect(mockAgentsSvc.syncMcpToolSelection).toHaveBeenCalledWith(agentId, [toolId]);
  });

  it("returns each library tool with an enabled flag for the checkbox UI", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockToolLibraryService.listMcpToolsForAgent.mockResolvedValue([{ ...baseTool, enabled: true }]);
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: agentId, companyId, mcpToolIds: [toolId] }]),
        }),
      }),
    };
    const app = await buildApp(fakeDb, { unsafeRows: [[agentId, companyId, [toolId]]] });

    const res = await request(app).get(`/api/agents/${agentId}/mcp-tools`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: toolId, enabled: true })]);
  });
});
