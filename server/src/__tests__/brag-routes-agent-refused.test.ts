/**
 * Agents must never start a brag video by themselves. Every Brag pipeline
 * route (estimate, create, plan, scene approval, render, cancel, read) is
 * board-only, so an agent key gets 403 before anything is created or spent.
 * The only automatic path is a person's "brag video when this is done"
 * pre-approval, which runs server-side under that person's authority.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
  };
});

const mockBrag = vi.hoisted(() => ({
  estimate: vi.fn(() => ({ sceneCount: 5, planningCents: 20, musicCents: 0, estimatedCostCents: 20 })),
  createJob: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  planJob: vi.fn(),
  updateScene: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(),
  getSceneStillRef: vi.fn(),
}));
vi.mock("../services/brag.js", () => ({ bragService: () => mockBrag }));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const SCENE_ID = "55555555-5555-4555-8555-555555555555";

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { bragRoutes }] = await Promise.all([import("../middleware/index.js"), import("../routes/brag.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", bragRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const AGENT = { type: "agent", agentId: "44444444-4444-4444-8444-444444444444", companyId: COMPANY_ID, runId: "run-1" };
const BOARD = { type: "board", userId: "local-board", companyIds: [COMPANY_ID], source: "local_implicit", isInstanceAdmin: false };

const ROUTES: Array<{ method: "get" | "post" | "patch"; path: string; body?: Record<string, unknown> }> = [
  { method: "post", path: `/api/companies/${COMPANY_ID}/brag/estimate`, body: { lengthSeconds: 20, music: false } },
  { method: "post", path: `/api/companies/${COMPANY_ID}/brag/jobs`, body: { projectId: PROJECT_ID } },
  { method: "get", path: `/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/brag/jobs` },
  { method: "get", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}` },
  { method: "post", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}/plan` },
  { method: "patch", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}/scenes/${SCENE_ID}`, body: { action: "approve" } },
  { method: "post", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}/render` },
  { method: "post", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}/cancel` },
  { method: "get", path: `/api/companies/${COMPANY_ID}/brag/jobs/${JOB_ID}/scenes/${SCENE_ID}/still/content` },
];

describe("Brag pipeline routes refuse agents", () => {
  vi.setConfig({ testTimeout: 20000 });

  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path.replace(COMPANY_ID, ":companyId")} is refused for an agent`, async () => {
      const app = await createApp(AGENT);
      const call = request(app)[route.method](route.path);
      const res = route.body ? await call.send(route.body) : await call;
      expect(res.status).toBe(403);
    });
  }

  it("never reaches the pipeline for an agent", () => {
    for (const fn of Object.values(mockBrag)) expect(fn).not.toHaveBeenCalled();
  });

  it("still lets a person ask for an estimate", async () => {
    const res = await request(await createApp(BOARD)).post(`/api/companies/${COMPANY_ID}/brag/estimate`).send({ lengthSeconds: 20, music: false });
    expect(res.status).toBe(200);
    expect(mockBrag.estimate).toHaveBeenCalled();
  });
});
