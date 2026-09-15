import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-3978: the Telegram bridge asks "what did the agent answer?" for the
// tasks it created from a chat. These tests pin that it only ever learns about
// the company in the path, that a hidden or foreign task is simply absent, and
// that secrets in the answer are redacted before the text leaves Paperclip.

const companyId = "11111111-1111-4111-8111-111111111112";
const otherCompanyId = "22222222-2222-4222-8222-222222222223";
const ownIssueId = "33333333-3333-4333-8333-333333333333";
const foreignIssueId = "44444444-4444-4444-8444-444444444444";
const hiddenIssueId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listComments: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
}));

// The real middleware reserves a Postgres connection. Here it keeps its one
// job that matters for these tests: running the access check for the path's
// company before the handler.
vi.mock("../middleware/company-scope.js", () => ({
  companyScopeFromParam:
    (_db: unknown, checkAccess?: (req: any, companyId: string) => void) =>
    (req: any, _res: any, next: (err?: unknown) => void) => {
      try {
        checkAccess?.(req, req.params.companyId);
        next();
      } catch (err) {
        next(err);
      }
    },
}));

function issue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    identifier: "DUR-7",
    title: "What is our cash position?",
    status: "done",
    projectId: null,
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    ...overrides,
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    authorType: "agent",
    authorAgentId: "agent-1",
    body: "About 1.2 MNOK in the bank.",
    presentation: null,
    deletedAt: null,
    createdAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

function boardActor(companyIds: string[] = [companyId]) {
  return { type: "board", userId: "board-user-1", companyIds, source: "session", isInstanceAdmin: false };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ issueAnswerRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issue-answers.js")>("../routes/issue-answers.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueAnswerRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/issue-answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
  });

  it("returns the status and the agent's latest answer", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([
      comment({ id: "c-user", authorType: "user", body: "thanks", createdAt: "2026-09-16T12:00:00.000Z" }),
      comment({ id: "c-new", body: "Final: 1.2 MNOK.", createdAt: "2026-09-16T11:00:00.000Z" }),
      comment({ id: "c-old", body: "Looking into it.", createdAt: "2026-09-16T09:00:00.000Z" }),
    ]);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([
      expect.objectContaining({
        id: ownIssueId,
        companyId,
        identifier: "DUR-7",
        status: "done",
        answer: expect.objectContaining({ commentId: "c-new", body: "Final: 1.2 MNOK." }),
      }),
    ]);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(ownIssueId, { order: "desc", limit: 20 });
  });

  it("leaves out a task that belongs to another company, exactly like a missing one", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === foreignIssueId) return issue(foreignIssueId, { companyId: otherCompanyId, title: "Secret plan" });
      return null;
    });
    // Even an operator with access to both companies must not see the other
    // company's task through this company's path.
    const app = await createApp(boardActor([companyId, otherCompanyId]));

    const res = await request(app)
      .get(`/api/companies/${companyId}/issue-answers`)
      .query({ ids: `${foreignIssueId},66666666-6666-4666-8666-666666666666` });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("refuses a caller without access to the company in the path", async () => {
    const app = await createApp(boardActor([otherCompanyId]));

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(403);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("leaves out a task the caller may not read", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => issue(id));
    mockAccessService.decide.mockImplementation(async ({ resource }: any) => ({
      allowed: resource.issueId !== hiddenIssueId,
    }));
    mockIssueService.listComments.mockResolvedValue([comment()]);
    const app = await createApp(boardActor());

    const res = await request(app)
      .get(`/api/companies/${companyId}/issue-answers`)
      .query({ ids: `${ownIssueId},${hiddenIssueId}` });

    expect(res.status).toBe(200);
    expect(res.body.issues.map((i: { id: string }) => i.id)).toEqual([ownIssueId]);
  });

  it("redacts secrets in the answer before it leaves Paperclip", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment({ body: `Use this token: ${token}` })]);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues[0].answer.body).not.toContain(token);
  });

  it("does not treat a deleted comment or a system notice as the answer", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([
      comment({ id: "c-notice", presentation: { kind: "system_notice" }, createdAt: "2026-09-16T12:00:00.000Z" }),
      comment({ id: "c-deleted", deletedAt: "2026-09-16T11:30:00.000Z", createdAt: "2026-09-16T11:00:00.000Z" }),
      comment({ id: "c-system", authorType: "system", createdAt: "2026-09-16T10:30:00.000Z" }),
    ]);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues[0].answer).toBeNull();
  });

  it("rejects a call with no valid ids, or too many", async () => {
    const app = await createApp(boardActor());

    const none = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: "DUR-1,not-a-uuid" });
    const tooMany = await request(app)
      .get(`/api/companies/${companyId}/issue-answers`)
      .query({
        ids: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(","),
      });

    expect(none.status).toBe(400);
    expect(tooMany.status).toBe(400);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });
});
