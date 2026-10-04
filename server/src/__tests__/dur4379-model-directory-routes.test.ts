import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { conflict, notFound } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * DUR-4379: model directory routes -- owner/admin only, board only, company
 * scoped, one activity row per mutation, no key in any body. Service mocked.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const entryId = "33333333-3333-4333-8333-333333333333";

const entry = {
  id: entryId,
  companyId,
  name: "Local llama",
  provider: "local",
  model: "llama3.1",
  baseUrl: "http://localhost:11434/v1",
  providerRouting: null,
  defaultThinking: "off",
  defaultTemperature: 0.6,
  defaultMaxOutputTokens: 2048,
  backupEntryIds: [],
  note: null,
  createdByUserId: "filip",
  updatedByUserId: "filip",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};

const mockSvc = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), duplicate: vi.fn() }));
vi.mock("../services/model-directory.js", () => ({ modelDirectoryService: () => mockSvc }));
const mockLog = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLog }));

type Actor = Record<string, unknown>;
const board = (role: string, companyIds = [companyId]): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const agent = (): Actor => ({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId, source: "agent_key", runId: "run-1" });

async function buildApp(actor: Actor) {
  const { modelDirectoryRoutes } = await import("../routes/model-directory.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", modelDirectoryRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const createBody = { name: "Local llama", provider: "local", model: "llama3.1", baseUrl: "http://localhost:11434/v1", defaultThinking: "off" };
const base = `/api/companies/${companyId}/model-directory`;

describe("DUR-4379 model directory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.list.mockResolvedValue([entry]);
    mockSvc.get.mockResolvedValue(entry);
    mockSvc.create.mockResolvedValue(entry);
    mockSvc.update.mockResolvedValue(entry);
    mockSvc.remove.mockResolvedValue(entry);
    mockSvc.duplicate.mockResolvedValue({ ...entry, name: "Local llama (copy)" });
  });

  const calls: Array<[string, string, unknown]> = [
    ["get", base, undefined],
    ["post", base, createBody],
    ["get", `${base}/${entryId}`, undefined],
    ["patch", `${base}/${entryId}`, { note: "x" }],
    ["delete", `${base}/${entryId}`, undefined],
    ["post", `${base}/${entryId}/duplicate`, {}],
  ];

  it.each(calls)("%s %s -> 403 for an agent, service untouched", async (method, url, body) => {
    const app = await buildApp(agent());
    const res = await (request(app) as any)[method](url).send(body);
    expect(res.status).toBe(403);
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it.each(["operator", "viewer"])("refuses a %s on every route", async (role) => {
    const app = await buildApp(board(role));
    for (const [method, url, body] of calls) {
      expect((await (request(app) as any)[method](url).send(body)).status, `${method} ${url}`).toBe(403);
    }
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses an owner of a different company", async () => {
    const app = await buildApp(board("owner", [otherCompanyId]));
    expect((await request(app).get(base)).status).toBe(403);
    expect(mockSvc.list).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a %s list, read, create, update, duplicate and delete, logging each mutation", async (role) => {
    const app = await buildApp(board(role));
    expect((await request(app).get(base)).body).toEqual([entry]);
    expect((await request(app).get(`${base}/${entryId}`)).status).toBe(200);
    expect((await request(app).post(base).send(createBody)).status).toBe(201);
    expect((await request(app).patch(`${base}/${entryId}`).send({ note: "hi" })).status).toBe(200);
    expect((await request(app).post(`${base}/${entryId}/duplicate`).send({})).status).toBe(201);
    expect((await request(app).delete(`${base}/${entryId}`)).status).toBe(204);
    expect(mockLog.mock.calls.map((c) => c[1].action)).toEqual([
      "model_directory_entry.created",
      "model_directory_entry.updated",
      "model_directory_entry.duplicated",
      "model_directory_entry.deleted",
    ]);
    expect(mockLog.mock.calls[0]![1]).toMatchObject({ companyId, actorType: "user", entityType: "model_directory_entry", entityId: entryId });
    expect(mockSvc.create).toHaveBeenCalledWith(companyId, expect.objectContaining({ name: "Local llama" }), { userId: "filip" });
  });

  it("rejects an unknown field such as an api key, and a bad body, before the service", async () => {
    const app = await buildApp(board("owner"));
    expect((await request(app).post(base).send({ ...createBody, apiKey: "sk-secret" })).status).toBe(400);
    expect((await request(app).post(base).send({ name: "x", provider: "local", model: "m" })).status).toBe(400); // local needs an address
    expect((await request(app).post(base).send({ ...createBody, provider: "anthropic", model: "llama3.1", baseUrl: null, providerRouting: { only: ["x"] } })).status).toBe(400);
    expect((await request(app).patch(`${base}/${entryId}`).send({ defaultThinking: "maybe" })).status).toBe(400);
    expect(mockSvc.create).not.toHaveBeenCalled();
    expect(mockSvc.update).not.toHaveBeenCalled();
  });

  it("passes through not-found and conflict from the service, with no activity row", async () => {
    const app = await buildApp(board("owner"));
    mockSvc.get.mockRejectedValue(notFound("Model setup not found"));
    expect((await request(app).get(`${base}/${entryId}`)).status).toBe(404);
    mockSvc.create.mockRejectedValue(conflict("exists"));
    expect((await request(app).post(base).send(createBody)).status).toBe(409);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
