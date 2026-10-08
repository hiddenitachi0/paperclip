import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { unprocessable } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Catalogue v2 routes: settings read/write and the local Ollama resync.
 * Owner/admin only (like the rest of the directory), board only, company
 * scoped, an activity row per mutation. Service mocked.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";

const mockSvc = vi.hoisted(() => ({
  get: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  syncLocalModels: vi.fn(),
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

const base = `/api/companies/${companyId}/model-directory`;
const syncResult = {
  baseUrl: "http://100.124.232.68:11434/v1",
  checkedAt: "2026-10-08T12:00:00.000Z",
  installed: [{ name: "llama3.2:latest", sizeGb: 2, parameterSize: "3.2B", quantization: "Q4_K_M", family: "llama", entryIds: ["e1"] }],
  missingEntryIds: ["e2"],
  markedInstalledEntryIds: ["e1"],
};

describe("catalogue v2 routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.getSettings.mockResolvedValue({ localGpuVramGb: 12 });
    mockSvc.updateSettings.mockImplementation(async (_c: string, body: { localGpuVramGb: number | null }) => body);
    mockSvc.syncLocalModels.mockResolvedValue(syncResult);
  });

  const calls: Array<[string, string, unknown]> = [
    ["get", `${base}/settings`, undefined],
    ["put", `${base}/settings`, { localGpuVramGb: 12 }],
    ["post", `${base}/local-sync`, { baseUrl: "http://100.124.232.68:11434/v1" }],
  ];

  it.each(calls)("%s %s -> 403 for an agent", async (method, url, body) => {
    const app = await buildApp(agent());
    expect((await (request(app) as any)[method](url).send(body)).status).toBe(403);
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it.each(["operator", "viewer"])("refuses a %s, and an owner of another company", async (role) => {
    for (const app of [await buildApp(board(role)), await buildApp(board("owner", [otherCompanyId]))]) {
      for (const [method, url, body] of calls) {
        expect((await (request(app) as any)[method](url).send(body)).status, `${method} ${url}`).toBe(403);
      }
    }
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a %s read and save settings; saving is logged, reading is not", async (role) => {
    const app = await buildApp(board(role));
    const read = await request(app).get(`${base}/settings`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ localGpuVramGb: 12 });
    expect(mockSvc.get).not.toHaveBeenCalled(); // not swallowed by /:entryId
    expect(mockLog).not.toHaveBeenCalled();

    const saved = await request(app).put(`${base}/settings`).send({ localGpuVramGb: 16 });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ localGpuVramGb: 16 });
    expect(mockSvc.updateSettings).toHaveBeenCalledWith(companyId, { localGpuVramGb: 16 }, { userId: "filip" });
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]![1]).toMatchObject({
      companyId,
      action: "model_directory.settings_updated",
      entityType: "model_directory_settings",
      entityId: companyId,
      details: { localGpuVramGb: 16 },
    });
  });

  it("rejects bad settings before the service", async () => {
    const app = await buildApp(board("owner"));
    for (const body of [{}, { localGpuVramGb: "12" }, { localGpuVramGb: -2 }, { localGpuVramGb: 12, extra: 1 }]) {
      expect((await request(app).put(`${base}/settings`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(mockSvc.updateSettings).not.toHaveBeenCalled();
  });

  it("runs the local resync for an owner and logs it", async () => {
    const app = await buildApp(board("owner"));
    const res = await request(app).post(`${base}/local-sync`).send({ baseUrl: "http://100.124.232.68:11434/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(syncResult);
    expect(mockSvc.syncLocalModels).toHaveBeenCalledWith(companyId, "http://100.124.232.68:11434/");
    expect(mockLog.mock.calls[0]![1]).toMatchObject({
      companyId,
      action: "model_directory.local_synced",
      details: { baseUrl: syncResult.baseUrl, installedCount: 1, markedInstalledEntryIds: ["e1"], missingEntryIds: ["e2"] },
    });
  });

  it("passes a refused address through as 422 with a plain message, and a bad body as 400", async () => {
    const app = await buildApp(board("owner"));
    mockSvc.syncLocalModels.mockRejectedValue(unprocessable("That address is not one of your local model addresses."));
    const res = await request(app).post(`${base}/local-sync`).send({ baseUrl: "http://10.0.0.1:11434" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("not one of your local model addresses");
    expect(mockLog).not.toHaveBeenCalled();
    for (const body of [{}, { baseUrl: "not a url" }, { baseUrl: "http://x", other: 1 }]) {
      expect((await request(app).post(`${base}/local-sync`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(mockSvc.syncLocalModels).toHaveBeenCalledTimes(1);
  });
});
