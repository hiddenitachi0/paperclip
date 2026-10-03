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

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentByKey: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  documentService: () => mockDocumentService,
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

/**
 * A minimal chainable stand-in for the drizzle query built by
 * verifyMediaJobDelivery: `.select().from().innerJoin().where().limit()`.
 * `rows` is what the (mocked) lookup for a matching finished media job
 * resolves to — `[]` means "no matching job found".
 */
function fakeRawDb(rows: unknown[] = []) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.from = () => builder;
  builder.innerJoin = () => builder;
  builder.where = () => builder;
  builder.limit = () => Promise.resolve(rows);
  return builder as unknown;
}

async function createApp(actor: Record<string, unknown>, rawDb: unknown = fakeRawDb()) {
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
  app.use("/api", issueAnswerRoutes(rawDb as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/issue-answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue(null);
  });

  it("says when the task has a result page, with its title only and never its text", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment({ body: "Plan is ready: 4 days in Rome." })]);
    mockDocumentService.getIssueDocumentByKey.mockResolvedValue({
      key: "result",
      title: "Rome, 4 days",
      body: "# Day 1\nThe whole private plan",
    });
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(mockDocumentService.getIssueDocumentByKey).toHaveBeenCalledWith(ownIssueId, "result");
    expect(res.body.issues[0].resultDocument).toEqual({ key: "result", title: "Rome, 4 days" });
    expect(JSON.stringify(res.body)).not.toContain("The whole private plan");
  });

  it("has no result page when the task has no result document", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment()]);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.body.issues[0].resultDocument).toBeNull();
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

  // DUR-4091 finding 2: the Telegram bridge parses "Your video/audio is
  // ready: ... (file id <uuid>)" out of this route's answer and uploads that
  // file id's bytes as a Telegram media message. Without verifying the claim
  // against the media job that would have produced it, any comment shaped
  // like this — however it landed on the task — could trigger delivery of an
  // arbitrary same-company file. These pin that the file-id trigger is
  // stripped unless a matching finished job is on record, and left intact
  // when one is.
  const mediaFileId = "77777777-7777-4777-8777-777777777777";
  const mediaReadyBody = `Your video is ready: office-tour.mp4 (file id ${mediaFileId}). Saved to the company's Files.`;

  it("strips the file-id trigger from a media-ready claim with no matching finished job", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment({ body: mediaReadyBody })]);
    const app = await createApp(boardActor(), fakeRawDb([]));

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues[0].answer.body).not.toContain(mediaFileId);
    expect(res.body.issues[0].answer.body).toMatch(/\(file id unverified\)/);
  });

  it("keeps the file-id trigger when a matching finished media job is on record", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment({ body: mediaReadyBody })]);
    const app = await createApp(boardActor(), fakeRawDb([{ id: "job-row-1" }]));

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues[0].answer.body).toBe(mediaReadyBody);
  });

  it("leaves an ordinary answer untouched (no lookup shape to verify)", async () => {
    mockIssueService.getById.mockResolvedValue(issue(ownIssueId));
    mockIssueService.listComments.mockResolvedValue([comment({ body: "Final: 1.2 MNOK." })]);
    const app = await createApp(boardActor(), fakeRawDb([]));

    const res = await request(app).get(`/api/companies/${companyId}/issue-answers`).query({ ids: ownIssueId });

    expect(res.status).toBe(200);
    expect(res.body.issues[0].answer.body).toBe("Final: 1.2 MNOK.");
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
