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
  maker: null,
  baseModel: null,
  lane: null,
  availability: null,
  tags: [],
  specs: null,
  favorite: false,
  archivedAt: null,
  createdByUserId: "filip",
  updatedByUserId: "filip",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};

const mockSvc = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  duplicate: vi.fn(),
  exportCatalogue: vi.fn(),
  importCatalogue: vi.fn(),
}));
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

const catalogueFile = {
  version: 1,
  exportedAt: "2026-10-08T09:00:00.000Z",
  entries: [{ name: "Local llama", provider: "local", model: "llama3.1", baseUrl: "http://localhost:11434/v1", backupNames: [], archived: false }],
};
const importBody = {
  ...catalogueFile,
  onExisting: "update",
  entries: [
    { name: "Local llama", provider: "local", model: "llama3.1", baseUrl: "http://localhost:11434/v1", tags: ["Fast"], backupNames: ["Cloud"] },
    { name: "Cloud", provider: "openrouter", model: "vendor/x", archived: true },
  ],
};
const importOutcome = {
  result: { created: ["Cloud"], updated: ["Local llama"], skipped: [] },
  createdEntries: [{ ...entry, id: "44444444-4444-4444-8444-444444444444", name: "Cloud", provider: "openrouter", model: "vendor/x" }],
  updatedEntries: [entry],
};

describe("DUR-4379 model directory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.list.mockResolvedValue([entry]);
    mockSvc.get.mockResolvedValue(entry);
    mockSvc.create.mockResolvedValue(entry);
    mockSvc.update.mockResolvedValue(entry);
    mockSvc.remove.mockResolvedValue(entry);
    mockSvc.duplicate.mockResolvedValue({ ...entry, name: "Local llama (copy)" });
    mockSvc.exportCatalogue.mockResolvedValue(catalogueFile);
    mockSvc.importCatalogue.mockResolvedValue(importOutcome);
  });

  const calls: Array<[string, string, unknown]> = [
    ["get", base, undefined],
    ["post", base, createBody],
    ["get", `${base}/${entryId}`, undefined],
    ["patch", `${base}/${entryId}`, { note: "x" }],
    ["delete", `${base}/${entryId}`, undefined],
    ["post", `${base}/${entryId}/duplicate`, {}],
    ["get", `${base}/export`, undefined],
    ["post", `${base}/import`, importBody],
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

  it("refuses an owner of a different company, including export and import", async () => {
    const app = await buildApp(board("owner", [otherCompanyId]));
    expect((await request(app).get(base)).status).toBe(403);
    expect((await request(app).get(`${base}/export`)).status).toBe(403);
    expect((await request(app).post(`${base}/import`).send(importBody)).status).toBe(403);
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("hides archived setups from the list unless includeArchived is true or 1", async () => {
    const app = await buildApp(board("owner"));
    await request(app).get(base);
    await request(app).get(`${base}?includeArchived=true`);
    await request(app).get(`${base}?includeArchived=1`);
    await request(app).get(`${base}?includeArchived=false`);
    expect(mockSvc.list.mock.calls).toEqual([
      [companyId, { includeArchived: false }],
      [companyId, { includeArchived: true }],
      [companyId, { includeArchived: true }],
      [companyId, { includeArchived: false }],
    ]);
  });

  it.each(["owner", "admin"])("lets a %s export the catalogue, which is a read (no activity row)", async (role) => {
    const app = await buildApp(board(role));
    const res = await request(app).get(`${base}/export`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(catalogueFile);
    expect(mockSvc.exportCatalogue).toHaveBeenCalledWith(companyId);
    expect(mockSvc.get).not.toHaveBeenCalled(); // not swallowed by /:entryId
    expect(mockLog).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a %s import a catalogue: parsed body to the service, one activity row per saved setup", async (role) => {
    const app = await buildApp(board(role));
    const res = await request(app).post(`${base}/import`).send(importBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(importOutcome.result);
    const [calledCompany, body, actor] = mockSvc.importCatalogue.mock.calls[0]!;
    expect(calledCompany).toBe(companyId);
    expect(actor).toEqual({ userId: "filip" });
    expect(body.onExisting).toBe("update");
    expect(body.entries[0].tags).toEqual(["fast"]); // went through the schema
    expect(mockLog.mock.calls.map((c) => [c[1].action, c[1].details.name, c[1].details.source])).toEqual([
      ["model_directory_entry.created", "Cloud", "catalogue_import"],
      ["model_directory_entry.updated", "Local llama", "catalogue_import"],
    ]);
    expect(mockLog.mock.calls[0]![1]).toMatchObject({ companyId, actorType: "user", entityType: "model_directory_entry" });
  });

  it("rejects a bad catalogue file before the service", async () => {
    const app = await buildApp(board("owner"));
    const one = importBody.entries[1]!;
    const bad: unknown[] = [
      {},
      { entries: [] },
      { entries: [{ ...one, apiKey: "sk-secret" }] },
      { entries: [{ ...one, backupEntryIds: ["44444444-4444-4444-8444-444444444444"] }] },
      { entries: [{ ...one, id: "44444444-4444-4444-8444-444444444444" }] },
      { entries: [one, { ...one, name: "CLOUD" }] }, // listed twice
      { entries: [one], onExisting: "replace" },
      { entries: [one], version: 2 },
      { entries: [{ name: "x", provider: "local", model: "m" }] }, // local needs an address
    ];
    for (const body of bad) {
      expect((await request(app).post(`${base}/import`).send(body as object)).status, JSON.stringify(body)).toBe(400);
    }
    expect(mockSvc.importCatalogue).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a %s list, read, create, update, duplicate and delete, logging each mutation", async (role) => {
    const app = await buildApp(board(role));
    expect((await request(app).get(base)).body).toEqual([entry]);
    expect((await request(app).get(`${base}/${entryId}`)).status).toBe(200);
    expect((await request(app).post(base).send(createBody)).status).toBe(201);
    expect((await request(app).patch(`${base}/${entryId}`).send({ note: "hi" })).status).toBe(200);
    expect((await request(app).patch(`${base}/${entryId}`).send({ archived: true })).status).toBe(200);
    expect((await request(app).post(`${base}/${entryId}/duplicate`).send({})).status).toBe(201);
    expect((await request(app).delete(`${base}/${entryId}`)).status).toBe(204);
    expect(mockLog.mock.calls.map((c) => c[1].action)).toEqual([
      "model_directory_entry.created",
      "model_directory_entry.updated",
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
    expect((await request(app).patch(`${base}/${entryId}`).send({ lane: "sometimes" })).status).toBe(400);
    expect((await request(app).patch(`${base}/${entryId}`).send({ archivedAt: "2026-10-08T09:00:00.000Z" })).status).toBe(400);
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
