import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  listChangeLog: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { changeLogRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/change-log.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", changeLogRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("change log routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listChangeLog.mockResolvedValue([]);
  });

  it("rejects cross-company reads for an agent key scoped to a different company", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });

    const res = await request(app).get("/api/companies/company-2/change-log");

    expect(res.status).toBe(403);
    expect(mockIssueService.listChangeLog).not.toHaveBeenCalled();
  });

  it("passes projectId/days/limit query params through to the service", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });

    const res = await request(app)
      .get("/api/companies/company-1/change-log")
      .query({ projectId: "project-1", days: "7", limit: "10" });

    expect(res.status).toBe(200);
    expect(mockIssueService.listChangeLog).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
      days: 7,
      limit: 10,
    });
  });

  it("rejects a non-numeric days param", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });

    const res = await request(app)
      .get("/api/companies/company-1/change-log")
      .query({ days: "not-a-number" });

    expect(res.status).toBe(400);
    expect(mockIssueService.listChangeLog).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit param", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    });

    const res = await request(app)
      .get("/api/companies/company-1/change-log")
      .query({ limit: "not-a-number" });

    expect(res.status).toBe(400);
    expect(mockIssueService.listChangeLog).not.toHaveBeenCalled();
  });
});
