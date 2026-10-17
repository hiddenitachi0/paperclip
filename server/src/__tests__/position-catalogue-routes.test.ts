// Routes for "Add from catalogue" on the Positions page: board-only, installs
// the catalogue skills a position needs (best effort), and logs the change.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { forbidden } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockCatalogue = vi.hoisted(() => ({
  listPositionCatalogue: vi.fn(),
  addPositionFromCatalogue: vi.fn(),
  catalogueSkillIds: vi.fn(),
}));
vi.mock("../services/position-catalogue.js", () => mockCatalogue);

const mockInstallFromCatalog = vi.hoisted(() => vi.fn());
vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({ installFromCatalog: mockInstallFromCatalog }),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockAuthz = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "user", actorId: "user-1", agentId: null, runId: null })),
}));
vi.mock("../routes/authz.js", () => mockAuthz);

vi.setConfig({ testTimeout: 20_000 });

async function buildApp() {
  const { agentRoleRoutes } = await import("../routes/agent-roles.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1" };
    next();
  });
  app.use("/api", agentRoleRoutes(withFakeCompanyScopeReserve({}) as any));
  app.use(errorHandler);
  return app;
}

describe("position catalogue routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
  });

  it("lists the catalogue for the company", async () => {
    mockCatalogue.listPositionCatalogue.mockResolvedValue([{ key: "scheduler", alreadyAdded: false }]);
    const res = await request(await buildApp()).get(`/api/companies/${companyId}/agent-roles/catalogue`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ key: "scheduler", alreadyAdded: false }]);
    expect(mockCatalogue.listPositionCatalogue).toHaveBeenCalledWith(expect.anything(), companyId);
  });

  it("adds a position, installs the skills it can, and reports the ones it cannot", async () => {
    mockCatalogue.addPositionFromCatalogue.mockResolvedValue({
      position: { id: "role-1", name: "Content & Video Producer" },
      createdPosition: true,
      createdJobs: ["Make a 30-second launch video"],
      linkedJobs: [],
      missingSkillKeys: ["paperclipai/optional/content/brag-video", "paperclipai/optional/content/brag"],
    });
    mockCatalogue.catalogueSkillIds.mockReturnValue([
      { key: "paperclipai/optional/content/brag-video", catalogSkillId: "paperclipai:optional:content:brag-video" },
      { key: "paperclipai/optional/content/brag", catalogSkillId: "paperclipai:optional:content:brag" },
    ]);
    mockInstallFromCatalog
      .mockResolvedValueOnce({ action: "created" })
      .mockRejectedValueOnce(new Error("This skill ships scripts and needs a review first."));

    const res = await request(await buildApp())
      .post(`/api/companies/${companyId}/agent-roles/catalogue/content-video-producer`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.installedSkills).toEqual(["paperclipai/optional/content/brag-video"]);
    expect(res.body.missingSkillKeys).toEqual(["paperclipai/optional/content/brag"]);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("paperclipai/optional/content/brag");
    expect(mockInstallFromCatalog).toHaveBeenCalledWith(companyId, {
      catalogSkillId: "paperclipai:optional:content:brag-video",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "position.added_from_catalogue", entityId: "role-1" }),
    );
  });

  it("can add a position without installing skills", async () => {
    mockCatalogue.addPositionFromCatalogue.mockResolvedValue({
      position: { id: "role-2", name: "Scheduler" },
      createdPosition: false,
      createdJobs: [],
      linkedJobs: [],
      missingSkillKeys: ["paperclipai/optional/operations/calendar-scheduling"],
    });
    const res = await request(await buildApp())
      .post(`/api/companies/${companyId}/agent-roles/catalogue/scheduler`)
      .send({ installSkills: false });
    expect(res.status).toBe(200);
    expect(mockInstallFromCatalog).not.toHaveBeenCalled();
    expect(res.body.missingSkillKeys).toEqual(["paperclipai/optional/operations/calendar-scheduling"]);
  });

  it("refuses non-board callers", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      throw forbidden("Board access required");
    });
    const res = await request(await buildApp())
      .post(`/api/companies/${companyId}/agent-roles/catalogue/scheduler`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockCatalogue.addPositionFromCatalogue).not.toHaveBeenCalled();
  });
});
