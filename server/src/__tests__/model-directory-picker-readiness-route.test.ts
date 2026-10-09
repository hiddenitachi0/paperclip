import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * GET /model-directory?withReadiness=1: each saved model carries the same
 * picker readiness the core pickers show, so add-on pickers (Media Studio)
 * can show "✅ Ready / ⚠️ Not installed on … / ⚠️ Never checked" too.
 * Company scoped, from stored readings only, and never a key.
 */

const companyId = "22222222-2222-4222-8222-222222222222";

const baseEntry = {
  companyId,
  providerRouting: null,
  defaultThinking: null,
  defaultTemperature: 0.5,
  defaultMaxOutputTokens: null,
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
  createdByUserId: "u",
  updatedByUserId: "u",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};
const installed = { ...baseEntry, id: "e-installed", name: "Qwen", provider: "local", model: "qwen3:14b", baseUrl: "http://office-pc:11434/v1" };
const missing = { ...baseEntry, id: "e-missing", name: "Big", provider: "local", model: "llama9:70b", baseUrl: null };
const unchecked = { ...baseEntry, id: "e-unchecked", name: "Gemma", provider: "local", model: "gemma3:12b", baseUrl: "http://office-pc:11434/v1" };
const hosted = { ...baseEntry, id: "e-hosted", name: "Mistral", provider: "openrouter", model: "mistralai/mistral-small-3.2-24b-instruct", baseUrl: null };

const mockSvc = vi.hoisted(() => ({ list: vi.fn(), getSettings: vi.fn() }));
vi.mock("../services/model-directory.js", () => ({ modelDirectoryService: () => mockSvc }));
const mockHealth = vi.hoisted(() => ({ overview: vi.fn(), recordLocalSync: vi.fn() }));
vi.mock("../services/model-health.js", () => ({ modelHealthService: () => mockHealth }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const owner = {
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "owner" }],
};

async function buildApp() {
  const { modelDirectoryRoutes } = await import("../routes/model-directory.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = owner;
    next();
  });
  app.use("/api", modelDirectoryRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const report = (status: string) => ({ status, message: "", hint: null, runbookPath: null, lastCheckedAt: new Date().toISOString(), outageStartedAt: null });

describe("model directory list with picker readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.list.mockResolvedValue([installed, missing, unchecked, hosted]);
    mockSvc.getSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: "http://studio-mac:11434", openrouterBlockedHosts: [], openrouterPreferredHosts: [] });
    mockHealth.overview.mockResolvedValue({
      entries: [
        { entryId: "e-installed", applicable: true, ...report("ready") },
        { entryId: "e-missing", applicable: true, ...report("model_missing") },
        { entryId: "e-unchecked", applicable: true, ...report("not_checked"), lastCheckedAt: null },
        { entryId: "e-hosted", applicable: false, ...report("not_checked"), lastCheckedAt: null },
      ],
      agents: [],
    });
  });

  it("leaves the plain list alone", async () => {
    const res = await request(await buildApp()).get(`/api/companies/${companyId}/model-directory`);
    expect(res.status).toBe(200);
    expect(res.body[0].readiness).toBeUndefined();
    expect(mockHealth.overview).not.toHaveBeenCalled();
  });

  it("adds the readiness each picker shows, using the company's address for a model with none", async () => {
    const res = await request(await buildApp()).get(`/api/companies/${companyId}/model-directory?withReadiness=1`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body as Array<{ id: string; readiness: Record<string, unknown> }>).map((e) => [e.id, e.readiness]));
    expect(byId["e-installed"]).toMatchObject({ kind: "ready", badge: "✅ Ready", runLabel: "Local — installed" });
    expect(byId["e-missing"]).toMatchObject({ kind: "not_installed", badge: "⚠️ Not installed on studio-mac" });
    expect(byId["e-unchecked"]).toMatchObject({ kind: "never_checked", badge: "⚠️ Never checked" });
    expect(byId["e-hosted"]).toMatchObject({ kind: "key_per_use", runLabel: null });
    expect(mockHealth.overview).toHaveBeenCalledWith(companyId);
    expect(JSON.stringify(res.body)).not.toMatch(/apiKey|secret/i);
  });
});
