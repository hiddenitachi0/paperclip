import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * "Ask Paperclip" helper routes: board only, company scoped, settings writes
 * owner/admin only, request validation (model id shape, context cap, no
 * unknown fields such as "tools"). Service mocked.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const entryId = "33333333-3333-4333-8333-333333333333";

const mockSvc = vi.hoisted(() => ({
  ask: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  assertEntryInCompany: vi.fn(),
}));
vi.mock("../services/helper.js", () => ({ helperService: () => mockSvc }));

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
  const { helperRoutes } = await import("../routes/helper.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", helperRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const askUrl = `/api/companies/${companyId}/helper/ask`;
const settingsUrl = `/api/companies/${companyId}/helper/settings`;

describe("helper routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.ask.mockResolvedValue({ answer: "Do this.", directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false });
    mockSvc.getSettings.mockResolvedValue({ defaultDirectoryEntryId: null, investigationAgentId: null, keys: [], models: [], builtInDefaultLabel: "Claude", canEdit: true, updatedAt: null });
    mockSvc.updateSettings.mockResolvedValue(undefined);
  });

  it("refuses an agent on every route, service untouched", async () => {
    const app = await buildApp(agent());
    expect((await request(app).post(askUrl).send({ message: "hi" })).status).toBe(403);
    expect((await request(app).get(settingsUrl)).status).toBe(403);
    expect((await request(app).put(settingsUrl).send({ defaultDirectoryEntryId: null })).status).toBe(403);
    for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses a board user of another company", async () => {
    const app = await buildApp(board("owner", [otherCompanyId]));
    expect((await request(app).post(askUrl).send({ message: "hi" })).status).toBe(403);
    expect((await request(app).get(settingsUrl)).status).toBe(403);
    expect(mockSvc.ask).not.toHaveBeenCalled();
  });

  it("lets any member of the company ask, passing the company from the URL", async () => {
    const app = await buildApp(board("operator"));
    const res = await request(app)
      .post(askUrl)
      .send({ message: "Explain this", context: "Label: Instructions", pageRoute: "/ACM/agents/x", directoryEntryId: entryId, history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Do this.");
    expect(mockSvc.ask).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, userId: "filip", message: "Explain this", directoryEntryId: entryId, pageRoute: "/ACM/agents/x" }),
    );
  });

  it("validates the request: model id shape, context cap, and no unknown fields (no tools can be asked for)", async () => {
    const app = await buildApp(board("owner"));
    expect((await request(app).post(askUrl).send({ message: "" })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", directoryEntryId: "not-a-uuid" })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", context: "x".repeat(12_001) })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", tools: [{ name: "x" }] })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", companyId: otherCompanyId })).status).toBe(400);
    expect(mockSvc.ask).not.toHaveBeenCalled();
  });

  it("lets any member read settings but only an owner/admin change them", async () => {
    const operator = await buildApp(board("operator"));
    const read = await request(operator).get(settingsUrl);
    expect(read.status).toBe(200);
    expect(mockSvc.getSettings).toHaveBeenCalledWith(companyId, { canEdit: false });
    expect((await request(operator).put(settingsUrl).send({ defaultDirectoryEntryId: entryId })).status).toBe(403);
    expect(mockSvc.updateSettings).not.toHaveBeenCalled();

    const admin = await buildApp(board("admin"));
    const res = await request(admin).put(settingsUrl).send({ defaultDirectoryEntryId: entryId, keys: { openrouter: entryId } });
    expect(res.status).toBe(200);
    expect(mockSvc.updateSettings).toHaveBeenCalledWith(companyId, { defaultDirectoryEntryId: entryId, keys: { openrouter: entryId } }, { userId: "filip" });
    expect((await request(admin).put(settingsUrl).send({ keys: { notaprovider: entryId } })).status).toBe(400);
  });
});
