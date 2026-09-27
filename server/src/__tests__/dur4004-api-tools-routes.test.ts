import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { notFound, tooManyRequests } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * DUR-4004: "API with a key" routes -- who may do what, with the service
 * mocked so only the route layer is under test.
 *
 *   1. Every board route is board-only: an agent gets 403 and the service is
 *      never called, so an agent can never add a tool or grant itself one.
 *   2. Any active member can read; only an owner or admin can write (an
 *      operator gets 403 with a plain sentence, an instance admin and the
 *      local single-user board pass).
 *   3. The run route: an agent may run an action of a tool ticked on for it,
 *      in its own company only; an un-granted tool is 403; a viewer is
 *      refused; a board user runs as channel "board".
 *   4. No response carries anything but the secret's id; the create body
 *      names the key by `secretId`, never by a value field.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const toolId = "33333333-3333-4333-8333-333333333333";
const secretId = "44444444-4444-4444-8444-444444444444";

const baseTool = {
  id: toolId,
  companyId,
  name: "Fal.ai",
  key: "fal-ai",
  description: "Makes images",
  baseUrl: "https://fal.run",
  auth: { kind: "header", name: "Authorization", prefix: "Key ", secretId },
  actions: [{ name: "flux", method: "POST", path: "/fal-ai/flux/dev", description: "Make an image", inputs: [{ name: "prompt", type: "string", required: true }] }],
  openapiUrl: null,
  dailyCap: 300,
  status: "active",
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: null,
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
};

const runResult = { ok: true, status: 200, contentType: "application/json", body: '{\n  "ok": true\n}', truncated: false, urls: [], error: null, durationMs: 12 };

const mockSvc = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  listForAgent: vi.fn(),
  listGranted: vi.fn(),
  agentToolIds: vi.fn(),
  runAction: vi.fn(),
  test: vi.fn(),
  toSummary: vi.fn(),
}));
vi.mock("../services/api-tools.js", () => ({ apiToolService: () => mockSvc }));

const mockImport = vi.hoisted(() => vi.fn());
vi.mock("../services/api-tools-openapi.js", () => ({ importOpenApiActions: mockImport }));

const mockAgentsSvc = vi.hoisted(() => ({ syncApiToolSelection: vi.fn() }));
vi.mock("../services/index.js", () => ({ agentService: () => mockAgentsSvc }));

// The agent lookups the route does before the company scope is known go
// through rawDb.select(); a fake that answers one row.
type AgentRow = { id: string; companyId: string; apiToolIds: string[] } | null;
const agentRow = vi.hoisted(() => ({ current: null as AgentRow }));

function fakeRawDb() {
  const query = {
    from: () => query,
    where: async () => (agentRow.current ? [agentRow.current] : []),
  };
  return { select: () => query };
}

type Actor = Record<string, unknown>;

const owner = (companyIds = [companyId], role = "owner"): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const admin = () => owner([companyId], "admin");
const operator = () => owner([companyId], "operator");
const viewer = () => owner([companyId], "viewer");
const instanceAdmin = (): Actor => ({ ...owner([companyId], "operator"), isInstanceAdmin: true });
const localBoard = (): Actor => ({ type: "board", source: "local_implicit", userId: "local", isInstanceAdmin: false, companyIds: [], memberships: [] });
const agent = (company = companyId, id = agentId): Actor => ({ type: "agent", agentId: id, companyId: company, source: "agent_key", runId: "run-1" });

async function buildApp(actor: Actor) {
  const { apiToolRoutes } = await import("../routes/api-tools.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", apiToolRoutes(withFakeCompanyScopeReserve(fakeRawDb()) as never));
  app.use(errorHandler);
  return app;
}

const createBody = {
  name: "Fal.ai",
  description: "Makes images",
  baseUrl: "https://fal.run",
  auth: { kind: "header", name: "Authorization", prefix: "Key ", secretId },
  actions: baseTool.actions,
};

describe("DUR-4004 api-tools routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentRow.current = { id: agentId, companyId, apiToolIds: [toolId] };
    mockSvc.list.mockResolvedValue([baseTool]);
    mockSvc.get.mockResolvedValue(baseTool);
    mockSvc.create.mockResolvedValue(baseTool);
    mockSvc.update.mockResolvedValue(baseTool);
    mockSvc.remove.mockResolvedValue(undefined);
    mockSvc.test.mockResolvedValue({ ok: true, status: 200, message: "fal.run answered 200. The key was accepted." });
    mockSvc.runAction.mockResolvedValue(runResult);
    mockSvc.listForAgent.mockResolvedValue([{ ...baseTool, enabled: true }]);
    mockSvc.listGranted.mockResolvedValue([baseTool]);
    mockAgentsSvc.syncApiToolSelection.mockResolvedValue({ id: agentId, apiToolIds: [toolId] });
    mockImport.mockResolvedValue({ title: "Fal", baseUrl: "https://fal.run", actions: baseTool.actions, skipped: 0 });
  });

  describe("board-only: an agent is refused everywhere but the run route", () => {
    it.each([
      ["GET", `/api/companies/${companyId}/api-tools`],
      ["POST", `/api/companies/${companyId}/api-tools`],
      ["POST", `/api/companies/${companyId}/api-tools/import-openapi`],
      ["GET", `/api/companies/${companyId}/api-tools/${toolId}`],
      ["PATCH", `/api/companies/${companyId}/api-tools/${toolId}`],
      ["DELETE", `/api/companies/${companyId}/api-tools/${toolId}`],
      ["POST", `/api/companies/${companyId}/api-tools/${toolId}/test`],
      ["POST", `/api/agents/${agentId}/api-tools/sync`],
    ])("%s %s -> 403 for an agent, service untouched", async (method, url) => {
      const app = await buildApp(agent());
      const res = await request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url).send(
        method === "POST" && url.endsWith("sync") ? { desiredToolIds: [toolId] } : url.endsWith("import-openapi") ? { url: "https://fal.run/openapi.json" } : createBody,
      );
      expect(res.status).toBe(403);
      for (const fn of [mockSvc.create, mockSvc.update, mockSvc.remove, mockSvc.test, mockSvc.list, mockSvc.get, mockImport, mockAgentsSvc.syncApiToolSelection]) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  describe("members read, owners and admins write", () => {
    it("lets an operator list and read, but not add, change, test, import or delete", async () => {
      const app = await buildApp(operator());
      expect((await request(app).get(`/api/companies/${companyId}/api-tools`)).status).toBe(200);
      expect((await request(app).get(`/api/companies/${companyId}/api-tools/${toolId}`)).status).toBe(200);
      const created = await request(app).post(`/api/companies/${companyId}/api-tools`).send(createBody);
      expect(created.status).toBe(403);
      expect(created.body.error).toBe("Only a company owner or admin can change tools. You can see them, but not change them.");
      expect((await request(app).patch(`/api/companies/${companyId}/api-tools/${toolId}`).send({ name: "X" })).status).toBe(403);
      expect((await request(app).delete(`/api/companies/${companyId}/api-tools/${toolId}`)).status).toBe(403);
      expect((await request(app).post(`/api/companies/${companyId}/api-tools/${toolId}/test`)).status).toBe(403);
      expect((await request(app).post(`/api/companies/${companyId}/api-tools/import-openapi`).send({ url: "https://fal.run/openapi.json" })).status).toBe(403);
      expect((await request(app).post(`/api/agents/${agentId}/api-tools/sync`).send({ desiredToolIds: [toolId] })).status).toBe(403);
      expect(mockSvc.create).not.toHaveBeenCalled();
      expect(mockAgentsSvc.syncApiToolSelection).not.toHaveBeenCalled();
    });

    it.each([
      ["owner", owner()],
      ["admin", admin()],
      ["instance admin", instanceAdmin()],
      ["local single-user board", localBoard()],
    ])("lets the %s add, change, test, import, delete and grant", async (_label, actor) => {
      const app = await buildApp(actor);
      const created = await request(app).post(`/api/companies/${companyId}/api-tools`).send(createBody);
      expect(created.status).toBe(201);
      expect(mockSvc.create).toHaveBeenCalledWith(companyId, expect.objectContaining({ name: "Fal.ai", dailyCap: 300, status: "active" }), expect.anything());
      expect((await request(app).patch(`/api/companies/${companyId}/api-tools/${toolId}`).send({ dailyCap: 50 })).status).toBe(200);
      expect(mockSvc.update).toHaveBeenCalledWith(companyId, toolId, { dailyCap: 50 });
      const tested = await request(app).post(`/api/companies/${companyId}/api-tools/${toolId}/test`);
      expect(tested.status).toBe(200);
      expect(tested.body.message).toContain("The key was accepted");
      const imported = await request(app).post(`/api/companies/${companyId}/api-tools/import-openapi`).send({ url: "https://fal.run/openapi.json" });
      expect(imported.status).toBe(200);
      expect(imported.body.actions).toHaveLength(1);
      expect((await request(app).delete(`/api/companies/${companyId}/api-tools/${toolId}`)).status).toBe(204);
      const synced = await request(app).post(`/api/agents/${agentId}/api-tools/sync`).send({ desiredToolIds: [toolId, toolId] });
      expect(synced.status).toBe(200);
      expect(mockAgentsSvc.syncApiToolSelection).toHaveBeenCalledWith(agentId, [toolId]);
    });

    it("refuses a board user of another company, and a tool from another company in a grant", async () => {
      const app = await buildApp(owner([otherCompanyId]));
      expect((await request(app).get(`/api/companies/${companyId}/api-tools`)).status).toBe(403);
      expect((await request(app).post(`/api/companies/${companyId}/api-tools`).send(createBody)).status).toBe(403);

      const own = await buildApp(owner());
      mockSvc.get.mockRejectedValueOnce(notFound("Tool not found"));
      const synced = await request(own).post(`/api/agents/${agentId}/api-tools/sync`).send({ desiredToolIds: ["55555555-5555-4555-8555-555555555555"] });
      expect(synced.status).toBe(422);
      expect(mockAgentsSvc.syncApiToolSelection).not.toHaveBeenCalled();
    });

    it("validates the body: no key value field, https only, a named header", async () => {
      const app = await buildApp(owner());
      const withValue = await request(app).post(`/api/companies/${companyId}/api-tools`).send({ ...createBody, auth: { ...createBody.auth, value: "sk-abc" } });
      expect(withValue.status).toBe(400);
      const http = await request(app).post(`/api/companies/${companyId}/api-tools`).send({ ...createBody, baseUrl: "http://fal.run" });
      expect(http.status).toBe(400);
      const noName = await request(app).post(`/api/companies/${companyId}/api-tools`).send({ ...createBody, auth: { kind: "header", secretId } });
      expect(noName.status).toBe(400);
      expect(mockSvc.create).not.toHaveBeenCalled();
    });
  });

  describe("running an action", () => {
    const runUrl = `/api/companies/${companyId}/api-tools/${toolId}/actions/flux/run`;

    it("lets an agent run an action of a tool ticked on for it, as channel agent_run with its run id", async () => {
      const app = await buildApp(agent());
      const res = await request(app).post(runUrl).send({ input: { prompt: "a cat" } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(runResult);
      expect(mockSvc.runAction).toHaveBeenCalledWith(companyId, toolId, "flux", { prompt: "a cat" }, { channel: "agent_run", agentId, userId: null, runId: "run-1" });
    });

    it("refuses an agent that does not have the tool ticked on, with a plain sentence", async () => {
      agentRow.current = { id: agentId, companyId, apiToolIds: [] };
      const app = await buildApp(agent());
      const res = await request(app).post(runUrl).send({ input: {} });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("This tool is not ticked on for you. Ask a company owner or admin to give it to you from your Tools tab.");
      expect(mockSvc.runAction).not.toHaveBeenCalled();
    });

    it("refuses an agent of another company before anything is looked up", async () => {
      const app = await buildApp(agent(otherCompanyId));
      const res = await request(app).post(runUrl).send({ input: {} });
      expect(res.status).toBe(403);
      expect(mockSvc.runAction).not.toHaveBeenCalled();
    });

    it("lets a board user who can write run it as channel board; a viewer is refused; a service token is refused", async () => {
      const board = await buildApp(operator());
      const res = await request(board).post(runUrl).send({ input: { prompt: "x" } });
      expect(res.status).toBe(200);
      expect(mockSvc.runAction).toHaveBeenCalledWith(companyId, toolId, "flux", { prompt: "x" }, { channel: "board", agentId: null, userId: "filip", runId: null });

      const view = await buildApp(viewer());
      expect((await request(view).post(runUrl).send({ input: {} })).status).toBe(403);
      const service = await buildApp({ type: "service", companyId, source: "service_token" });
      expect((await request(service).post(runUrl).send({ input: {} })).status).toBe(403);
      expect(mockSvc.runAction).toHaveBeenCalledTimes(1);
    });

    it("passes the service's refusal through as the status and sentence it chose", async () => {
      mockSvc.runAction.mockRejectedValueOnce(tooManyRequests('The tool "Fal.ai" has used its 300 calls for today.'));
      const app = await buildApp(agent());
      const res = await request(app).post(runUrl).send({ input: {} });
      expect(res.status).toBe(429);
      expect(res.body.error).toContain("has used its 300 calls for today");
    });
  });

  describe("an agent's own tools", () => {
    it("GET /agents/:id/api-tools: board sees every tool with an enabled flag; the agent itself sees only what it has; another agent is refused", async () => {
      const board = await buildApp(owner());
      const res = await request(board).get(`/api/agents/${agentId}/api-tools`);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ id: toolId, enabled: true });

      const self = await buildApp(agent());
      const mine = await request(self).get(`/api/agents/${agentId}/api-tools`);
      expect(mine.status).toBe(200);
      expect(mockSvc.listGranted).toHaveBeenCalledWith(companyId, [toolId]);
      expect(mine.body[0]).not.toHaveProperty("enabled");

      const other = await buildApp(agent(companyId, "66666666-6666-4666-8666-666666666666"));
      expect((await request(other).get(`/api/agents/${agentId}/api-tools`)).status).toBe(403);
    });
  });

  it("no route answer carries anything but the secret's id", async () => {
    const app = await buildApp(owner());
    for (const res of [
      await request(app).get(`/api/companies/${companyId}/api-tools`),
      await request(app).get(`/api/companies/${companyId}/api-tools/${toolId}`),
      await request(app).post(`/api/companies/${companyId}/api-tools`).send(createBody),
      await request(app).get(`/api/agents/${agentId}/api-tools`),
    ]) {
      const text = JSON.stringify(res.body);
      expect(text).toContain(secretId);
      expect(text).not.toMatch(/"value"|"apiKey"|"token"/);
    }
  });
});
