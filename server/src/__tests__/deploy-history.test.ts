import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployRunnerStatusEntry } from "../services/deploy-runner-status.js";

// DUR-3952 follow-up (operator rollback button): the project deploy-history
// API must report the two versions that were genuinely live per the runner's
// own log -- never an approved-but-unprocessed card, never a "carried" line
// (whose commit shipped under a different approval), never another
// project's deploys -- so a one-click rollback always targets the version
// that was actually running before the current one.

const mockReadDeployRunnerStatus = vi.hoisted(() => vi.fn((_companyId: string, _limit?: number) => [] as DeployRunnerStatusEntry[]));
vi.mock("../services/deploy-runner-status.js", () => ({
  readDeployRunnerStatus: (...args: [string, number?]) => mockReadDeployRunnerStatus(...args),
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function successLine(approvalId: string, commit: string, ts: string): DeployRunnerStatusEntry {
  return {
    ts,
    approvalId,
    companyId: COMPANY_ID,
    commentDelivered: true,
    body: `Deployed to /opt/app — commit ${commit} is live and healthy (health check: http://x/health).`,
    commit,
  };
}

function line(overrides: Partial<DeployRunnerStatusEntry> & { approvalId: string; ts: string }): DeployRunnerStatusEntry {
  return { companyId: COMPANY_ID, commentDelivered: true, body: "", ...overrides };
}

describe("selectProjectDeployHistory", () => {
  it("returns the newest two distinct live versions for the project, newest first", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
      successLine("a3", "cccccccccccc", "2026-09-03T10:00:00Z"),
    ];
    const history = selectProjectDeployHistory(entries, new Set(["a1", "a2", "a3"]));
    expect(history).toEqual([
      { commit: "cccccccccccc", approvalId: "a3", deployedAt: "2026-09-03T10:00:00Z" },
      { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z" },
    ]);
  });

  it("ignores other projects' deploys, started/carried/failed lines, and cards that never ran", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const entries = [
      successLine("mine-1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("other-project", "999999999999", "2026-09-01T11:00:00Z"),
      line({ approvalId: "mine-2", ts: "2026-09-02T09:00:00Z", body: "Deploy started — the deploy runner is working on this approval.", outcome: "started" }),
      line({ approvalId: "mine-2", ts: "2026-09-02T09:05:00Z", body: "Deploy failed — health check never returned 200 after deploying bbbbbbbbbbbb. Rolled back to aaaaaaaaaaaa." }),
      line({ approvalId: "mine-3", ts: "2026-09-02T10:00:00Z", body: "Skipped — its change shipped as part of another deploy.", outcome: "carried", commit: "dddddddddddd" }),
      successLine("mine-4", "eeeeeeeeeeee", "2026-09-03T10:00:00Z"),
    ];
    const history = selectProjectDeployHistory(entries, new Set(["mine-1", "mine-2", "mine-3", "mine-4", "never-ran"]));
    expect(history.map((h) => h.commit)).toEqual(["eeeeeeeeeeee", "aaaaaaaaaaaa"]);
  });

  it("does not treat a re-deploy of the same commit as a previous version", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
      successLine("a3", "bbbbbbbbbbbb", "2026-09-03T10:00:00Z"),
    ];
    const history = selectProjectDeployHistory(entries, new Set(["a1", "a2", "a3"]));
    expect(history.map((h) => h.commit)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(history[0]?.approvalId).toBe("a3");
  });

  it("falls back to the commit named in the body for older log lines without a commit field", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const legacy = line({
      approvalId: "a1",
      ts: "2026-09-01T10:00:00Z",
      body: "Deployed to /opt/app — commit abcdef123456 is live and healthy (health check: http://x).",
    });
    expect(selectProjectDeployHistory([legacy], new Set(["a1"]))).toEqual([
      { commit: "abcdef123456", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z" },
    ]);
  });
});

function fakeDbWithApprovalIds(ids: string[]) {
  const rows = ids.map((id) => ({ id }));
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  };
}

async function createApp(db: unknown, actor?: Record<string, unknown>) {
  const [{ errorHandler }, { deployRunnerRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/deploy-runner.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", deployRunnerRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/projects/:projectId/deploy-history", () => {
  beforeEach(() => {
    mockReadDeployRunnerStatus.mockReset();
  });

  it("returns the current and previous live versions for the project", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
    ]);
    const app = await createApp(fakeDbWithApprovalIds(["a1", "a2"]));
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/deploy-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z" },
      previous: { commit: "aaaaaaaaaaaa", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z" },
    });
    expect(mockReadDeployRunnerStatus).toHaveBeenCalledWith(COMPANY_ID, 500);
  });

  it("returns nulls when the runner has never deployed this project", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([successLine("someone-else", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z")]);
    const app = await createApp(fakeDbWithApprovalIds([]));
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/deploy-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ current: null, previous: null });
  });

  it("refuses a caller without access to the company", async () => {
    const app = await createApp(fakeDbWithApprovalIds([]), {
      type: "board",
      userId: "user-2",
      companyIds: ["33333333-3333-4333-8333-333333333333"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/deploy-history`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockReadDeployRunnerStatus).not.toHaveBeenCalled();
  });
});
