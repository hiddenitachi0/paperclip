/**
 * Code-rendered video routes (Media Studio D14): who may call them. Agents of
 * the company (the explainer-video and Brag skills) and its board members may
 * submit and read; another company's agent key, a viewer's write and a bad
 * body never reach the service.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
  };
});

const mockRenders = vi.hoisted(() => ({
  configured: true,
  limits: vi.fn(),
  usage: vi.fn(async () => ({ configured: true, activeJobs: 0, companySecondsToday: 0, limits: {} })),
  submit: vi.fn(async (_companyId: string, _actor: unknown, input: { kind: string }) => ({ id: "job-1", status: "queued", kind: input.kind })),
  get: vi.fn(async () => ({ id: "job-1", status: "running" })),
  list: vi.fn(async () => []),
  cancel: vi.fn(async () => ({ id: "job-1", status: "cancelled" })),
  tick: vi.fn(),
}));
vi.mock("../services/code-renders.js", () => ({ codeRenderService: () => mockRenders }));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { codeRenderRoutes }] = await Promise.all([import("../middleware/index.js"), import("../routes/code-renders.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", codeRenderRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const AGENT = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID, runId: "run-1" };
const FOREIGN_AGENT = { type: "agent", agentId: AGENT_ID, companyId: OTHER_COMPANY_ID, runId: "run-2" };
const BOARD = { type: "board", userId: "user-1", companyIds: [COMPANY_ID], source: "session", isInstanceAdmin: false, memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "operator" }] };
const VIEWER = { ...BOARD, memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }] };

const BODY = {
  kind: "render",
  title: "Q3 orders",
  files: [{ path: "index.html", content: "<html></html>" }],
  durationSeconds: 20,
};

describe("code-render routes", () => {
  vi.setConfig({ testTimeout: 20000 });

  beforeEach(() => {
    for (const fn of Object.values(mockRenders)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  });

  it("lets the company's agent submit; the agent and its run are the actor", async () => {
    const res = await request(await createApp(AGENT)).post(`/api/companies/${COMPANY_ID}/code-renders`).send(BODY);
    expect(res.status).toBe(202);
    expect(mockRenders.submit).toHaveBeenCalledWith(COMPANY_ID, { agentId: AGENT_ID, userId: null, runId: "run-1" }, expect.objectContaining({ kind: "render", durationSeconds: 20 }));
  });

  it("lets a board member submit as themselves", async () => {
    const res = await request(await createApp(BOARD)).post(`/api/companies/${COMPANY_ID}/code-renders`).send(BODY);
    expect(res.status).toBe(202);
    expect(mockRenders.submit).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({ agentId: null, userId: "user-1" }), expect.anything());
  });

  it("refuses another company's agent key on every route", async () => {
    const app = await createApp(FOREIGN_AGENT);
    expect((await request(app).post(`/api/companies/${COMPANY_ID}/code-renders`).send(BODY)).status).toBe(403);
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders`)).status).toBe(403);
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders/${JOB_ID}`)).status).toBe(403);
    expect((await request(app).post(`/api/companies/${COMPANY_ID}/code-renders/${JOB_ID}/cancel`)).status).toBe(403);
    expect(mockRenders.submit).not.toHaveBeenCalled();
    expect(mockRenders.get).not.toHaveBeenCalled();
  });

  it("lets a viewer read but not submit", async () => {
    const app = await createApp(VIEWER);
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders`)).status).toBe(200);
    expect((await request(app).post(`/api/companies/${COMPANY_ID}/code-renders`).send(BODY)).status).toBe(403);
  });

  it("validates the body before the service sees it", async () => {
    const app = await createApp(AGENT);
    const cases = [
      { ...BODY, durationSeconds: undefined },
      { ...BODY, files: [{ path: "../escape.html", content: "x" }] },
      { ...BODY, files: [{ path: "/etc/passwd.html", content: "x" }] },
      { ...BODY, kind: "shell" },
      { ...BODY, files: [] },
      { ...BODY, assets: [{ fileId: "not-a-uuid", path: "assets/a.png" }] },
      { ...BODY, files: [{ path: "index.html", content: "a" }, { path: "INDEX.html", content: "b" }] },
      { ...BODY, files: [{ path: "index.html", content: "a", contentBase64: "YQ==" }] },
      { ...BODY, files: [{ path: "index.html" }] },
      { ...BODY, files: [{ path: "index.html", content: "a" }, { path: "sfx/click.ogg", contentBase64: "not base64!" }] },
      { ...BODY, extra: true },
    ];
    for (const body of cases) {
      const res = await request(app).post(`/api/companies/${COMPANY_ID}/code-renders`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockRenders.submit).not.toHaveBeenCalled();
  });

  it("accepts a small binary file inline next to the text files", async () => {
    const body = { ...BODY, files: [...BODY.files, { path: "sfx/click.ogg", contentBase64: Buffer.from("OggS").toString("base64") }] };
    const res = await request(await createApp(AGENT)).post(`/api/companies/${COMPANY_ID}/code-renders`).send(body);
    expect(res.status).toBe(202);
  });

  it("reads one job, lists, shows usage and cancels", async () => {
    const app = await createApp(AGENT);
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders/${JOB_ID}`)).body).toMatchObject({ status: "running" });
    expect(mockRenders.get).toHaveBeenCalledWith(COMPANY_ID, JOB_ID);
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders?limit=5`)).status).toBe(200);
    expect(mockRenders.list).toHaveBeenCalledWith(COMPANY_ID, { limit: 5 });
    expect((await request(app).get(`/api/companies/${COMPANY_ID}/code-renders/usage`)).status).toBe(200);
    expect(mockRenders.usage).toHaveBeenCalledWith(COMPANY_ID);
    expect((await request(app).post(`/api/companies/${COMPANY_ID}/code-renders/${JOB_ID}/cancel`)).body).toMatchObject({ status: "cancelled" });
  });

  it("answers 404 for a job id that is not a uuid", async () => {
    const res = await request(await createApp(AGENT)).get(`/api/companies/${COMPANY_ID}/code-renders/not-a-job`);
    expect(res.status).toBe(404);
    expect(mockRenders.get).not.toHaveBeenCalled();
  });
});
