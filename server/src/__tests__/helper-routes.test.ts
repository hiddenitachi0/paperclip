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
const mockInvestigations = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  availability: vi.fn(),
  estimateFor: vi.fn(),
}));
vi.mock("../services/helper-investigations.js", () => ({ helperInvestigationService: () => mockInvestigations }));

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
const investigationsUrl = `/api/companies/${companyId}/helper/investigations`;

describe("helper routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.ask.mockResolvedValue({ answer: "Do this.", directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false });
    mockSvc.getSettings.mockResolvedValue({ defaultDirectoryEntryId: null, investigationAgentId: null, keys: [], models: [], builtInDefaultLabel: "Claude", canEdit: true, updatedAt: null });
    mockSvc.updateSettings.mockResolvedValue(undefined);
    mockInvestigations.list.mockResolvedValue({ investigations: [], availability: { ready: false, problemCode: "no_agent" } });
    mockInvestigations.start.mockResolvedValue({ id: entryId, status: "queued" });
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

  it("lets any member attach pictures (upload or a company file), and refuses more than 4 or any other kind", async () => {
    const app = await buildApp(board("operator"));
    const upload = { kind: "upload", name: "shot.png", contentType: "image/png", dataBase64: "iVBORw0KGgo=" };
    const file = { kind: "file", fileId: entryId };
    const res = await request(app).post(askUrl).send({ message: "What's wrong here?", pictures: [upload, file] });
    expect(res.status).toBe(200);
    expect(mockSvc.ask).toHaveBeenCalledWith(expect.objectContaining({ companyId, pictures: [upload, file] }));

    mockSvc.ask.mockClear();
    expect((await request(app).post(askUrl).send({ message: "hi", pictures: [upload, upload, upload, upload, upload] })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", pictures: [{ kind: "file", fileId: "../../etc" }] })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", pictures: [{ kind: "screen" }] })).status).toBe(400);
    expect((await request(app).post(askUrl).send({ message: "hi", pictures: [{ ...upload, url: "http://evil" }] })).status).toBe(400);
    expect(mockSvc.ask).not.toHaveBeenCalled();
  });

  it("refuses pictures from an agent or another company's member just like a question", async () => {
    const pictures = [{ kind: "upload", dataBase64: "iVBORw0KGgo=" }];
    expect((await request(await buildApp(agent())).post(askUrl).send({ message: "hi", pictures })).status).toBe(403);
    expect((await request(await buildApp(board("owner", [otherCompanyId]))).post(askUrl).send({ message: "hi", pictures })).status).toBe(403);
    expect(mockSvc.ask).not.toHaveBeenCalled();
  });

  it("takes 4 full-size pictures in one question on its own body limit (the default 10 MB would refuse them)", async () => {
    const { helperRoutes, HELPER_ASK_API_PATH, HELPER_ASK_JSON_BODY_LIMIT } = await import("../routes/helper.js");
    const app = express();
    app.use(HELPER_ASK_API_PATH, express.json({ limit: HELPER_ASK_JSON_BODY_LIMIT }));
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = board("operator");
      next();
    });
    app.use("/api", helperRoutes(withFakeCompanyScopeReserve({}) as never));
    app.use(errorHandler);
    const big = "A".repeat(6_990_000);
    const pictures = [0, 1, 2, 3].map(() => ({ kind: "upload", dataBase64: big }));
    const res = await request(app).post(askUrl).send({ message: "Compare these", pictures });
    expect(res.status).toBe(200);
    expect(mockSvc.ask).toHaveBeenCalledTimes(1);
  });

  describe("Investigate deeper (Phase 3)", () => {
    it("refuses an agent: it can neither start an investigation nor list any", async () => {
      const app = await buildApp(agent());
      expect((await request(app).post(investigationsUrl).send({ question: "Approve it for me" })).status).toBe(403);
      expect((await request(app).get(investigationsUrl)).status).toBe(403);
      expect(mockInvestigations.start).not.toHaveBeenCalled();
      expect(mockInvestigations.list).not.toHaveBeenCalled();
    });

    it("refuses a board user of another company", async () => {
      const app = await buildApp(board("owner", [otherCompanyId]));
      expect((await request(app).post(investigationsUrl).send({ question: "hi" })).status).toBe(403);
      expect((await request(app).get(investigationsUrl)).status).toBe(403);
      expect(mockInvestigations.start).not.toHaveBeenCalled();
    });

    it("lets any member start one, for themselves, in the company from the URL", async () => {
      const app = await buildApp(board("operator"));
      const res = await request(app)
        .post(investigationsUrl)
        .send({
          question: "Should I approve this?",
          context: "Card: Deploy",
          pageRoute: "/ACM/dashboard/now",
          references: [`approval:${entryId}`],
          quickAnswer: "Maybe.",
          pictures: [{ kind: "file", fileId: entryId }],
        });
      expect(res.status).toBe(201);
      expect(mockInvestigations.start).toHaveBeenCalledWith({
        companyId,
        userId: "filip",
        question: "Should I approve this?",
        context: "Card: Deploy",
        pageRoute: "/ACM/dashboard/now",
        references: [`approval:${entryId}`],
        quickAnswer: "Maybe.",
        pictures: [{ kind: "file", fileId: entryId }],
        canConfigure: false,
      });

      const admin = await buildApp(board("admin"));
      await request(admin).post(investigationsUrl).send({ question: "And this?" });
      expect(mockInvestigations.start).toHaveBeenLastCalledWith(expect.objectContaining({ canConfigure: true, references: [] }));
    });

    it("lists only the asking person's own investigations", async () => {
      const app = await buildApp(board("operator"));
      const res = await request(app).get(investigationsUrl);
      expect(res.status).toBe(200);
      expect(mockInvestigations.list).toHaveBeenCalledWith(companyId, "filip", { canConfigure: false });
    });

    it("validates the request: no picking the agent, the company or the task fields; record references and pictures checked", async () => {
      const app = await buildApp(board("owner"));
      expect((await request(app).post(investigationsUrl).send({ question: "" })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", assigneeAgentId: entryId })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", companyId: otherCompanyId })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", status: "done" })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", references: ["<script>"] })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", references: Array(21).fill(`agent:${entryId}`) })).status).toBe(400);
      const upload = { kind: "upload", dataBase64: "iVBORw0KGgo=" };
      expect((await request(app).post(investigationsUrl).send({ question: "hi", pictures: [upload, upload, upload, upload, upload] })).status).toBe(400);
      expect((await request(app).post(investigationsUrl).send({ question: "hi", context: "x".repeat(12_001) })).status).toBe(400);
      expect(mockInvestigations.start).not.toHaveBeenCalled();
    });

    it("lets only an owner/admin change the investigation agent and limits, within bounds", async () => {
      const operator = await buildApp(board("operator"));
      expect((await request(operator).put(settingsUrl).send({ investigationAgentId: entryId })).status).toBe(403);
      const admin = await buildApp(board("admin"));
      const ok = await request(admin).put(settingsUrl).send({ investigationAgentId: entryId, investigationMaxRunning: 5, investigationMaxPerDay: 50 });
      expect(ok.status).toBe(200);
      expect(mockSvc.updateSettings).toHaveBeenCalledWith(
        companyId,
        { investigationAgentId: entryId, investigationMaxRunning: 5, investigationMaxPerDay: 50 },
        { userId: "filip" },
      );
      expect((await request(admin).put(settingsUrl).send({ investigationMaxRunning: 0 })).status).toBe(400);
      expect((await request(admin).put(settingsUrl).send({ investigationMaxPerDay: 201 })).status).toBe(400);
      expect((await request(admin).put(settingsUrl).send({ investigationMaxRunning: 2.5 })).status).toBe(400);
    });
  });
});
