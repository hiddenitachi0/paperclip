import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployRunnerStatusEntry } from "../services/deploy-runner-status.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

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
      { commit: "cccccccccccc", approvalId: "a3", deployedAt: "2026-09-03T10:00:00Z", status: "ok" },
      { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z", status: "ok" },
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

  it("returns more than two releases when given a higher limit (configurable retention)", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
      successLine("a3", "cccccccccccc", "2026-09-03T10:00:00Z"),
      successLine("a4", "dddddddddddd", "2026-09-04T10:00:00Z"),
    ];
    const history = selectProjectDeployHistory(entries, new Set(["a1", "a2", "a3", "a4"]), 10);
    expect(history.map((h) => h.commit)).toEqual(["dddddddddddd", "cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
  });

  it("DUR-4233: tags an entry outcome:needs_attention with status needs_attention, not ok", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const flagged = line({
      approvalId: "a1",
      ts: "2026-09-01T10:00:00Z",
      outcome: "needs_attention",
      commit: "aaaaaaaaaaaa",
      body: "Deployed to /opt/app — commit aaaaaaaaaaaa is live and the app itself checks out. Needs attention: TLS certificate expires in 3 day(s).",
    });
    expect(selectProjectDeployHistory([flagged], new Set(["a1"]))).toEqual([
      { commit: "aaaaaaaaaaaa", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z", status: "needs_attention" },
    ]);
  });

  it("falls back to the commit named in the body for older log lines without a commit field", async () => {
    const { selectProjectDeployHistory } = await import("../services/deploy-history.js");
    const legacy = line({
      approvalId: "a1",
      ts: "2026-09-01T10:00:00Z",
      body: "Deployed to /opt/app — commit abcdef123456 is live and healthy (health check: http://x).",
    });
    expect(selectProjectDeployHistory([legacy], new Set(["a1"]))).toEqual([
      { commit: "abcdef123456", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z", status: "ok" },
    ]);
  });
});

describe("resolveReleaseRetentionCount", () => {
  it("defaults to 10 when unset, null, or not a policy object", async () => {
    const { resolveReleaseRetentionCount, DEFAULT_RELEASE_RETENTION_COUNT } = await import("../services/deploy-history.js");
    expect(DEFAULT_RELEASE_RETENTION_COUNT).toBe(10);
    expect(resolveReleaseRetentionCount(undefined)).toBe(10);
    expect(resolveReleaseRetentionCount(null)).toBe(10);
    expect(resolveReleaseRetentionCount({})).toBe(10);
  });

  it("honors a configured count, clamped to [1, 50]", async () => {
    const { resolveReleaseRetentionCount } = await import("../services/deploy-history.js");
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: 25 })).toBe(25);
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: 0 })).toBe(1);
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: 999 })).toBe(50);
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: 3.7 })).toBe(3);
  });

  it("falls back to the default for a malformed stored value rather than throwing", async () => {
    const { resolveReleaseRetentionCount } = await import("../services/deploy-history.js");
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: "10" as unknown as number })).toBe(10);
    expect(resolveReleaseRetentionCount({ releaseRetentionCount: Number.NaN })).toBe(10);
  });
});

function failLine(approvalId: string, ts: string, body: string, outcome?: string, commit?: string): DeployRunnerStatusEntry {
  return line({ approvalId, ts, body, outcome, commit });
}

describe("selectProjectDeployHistoryEntries", () => {
  it("includes both pass and fail terminal entries, newest first", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      failLine("a2", "2026-09-02T10:00:00Z", "Deploy failed — health check never returned 200 after deploying bbbbbbbbbbbb.", undefined, "bbbbbbbbbbbb"),
      successLine("a3", "cccccccccccc", "2026-09-03T10:00:00Z"),
    ];
    const items = selectProjectDeployHistoryEntries(entries, new Set(["a1", "a2", "a3"]), {}, 10);
    expect(items).toEqual([
      { commit: "cccccccccccc", approvalId: "a3", deployedAt: "2026-09-03T10:00:00Z", status: "pass" },
      { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z", status: "fail" },
      { commit: "aaaaaaaaaaaa", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z", status: "pass" },
    ]);
  });

  it("excludes interim started/waiting_for_checks lines and no-op carried lines", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      failLine("a1", "2026-09-01T10:00:00Z", "Deploy started — the deploy runner is working on this approval.", "started"),
      failLine("a1", "2026-09-01T10:01:00Z", "Still waiting for the automated checks.", "waiting_for_checks"),
      failLine("a2", "2026-09-01T11:00:00Z", "Skipped — its change shipped as part of another deploy.", "carried", "dddddddddddd"),
    ];
    const items = selectProjectDeployHistoryEntries(entries, new Set(["a1", "a2"]), {}, 10);
    expect(items).toEqual([]);
  });

  it("treats checks_timed_out and checks_failed as terminal fails", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      failLine("a1", "2026-09-01T10:00:00Z", "Deploy not started — the automated checks never passed.", "checks_timed_out"),
      failLine("a2", "2026-09-02T10:00:00Z", "Deploy stopped — the automated checks did not pass.", "checks_failed"),
    ];
    const items = selectProjectDeployHistoryEntries(entries, new Set(["a1", "a2"]), {}, 10);
    expect(items.map((i) => i.status)).toEqual(["fail", "fail"]);
  });

  it("filters by status", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      failLine("a2", "2026-09-02T10:00:00Z", "Deploy failed — could not fetch project proj-1."),
    ];
    const ids = new Set(["a1", "a2"]);
    expect(selectProjectDeployHistoryEntries(entries, ids, { status: "pass" }, 10).map((i) => i.approvalId)).toEqual(["a1"]);
    expect(selectProjectDeployHistoryEntries(entries, ids, { status: "fail" }, 10).map((i) => i.approvalId)).toEqual(["a2"]);
  });

  it("filters by date range, inclusive on both ends", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
      successLine("a3", "cccccccccccc", "2026-09-03T10:00:00Z"),
    ];
    const ids = new Set(["a1", "a2", "a3"]);
    const fromMs = Date.parse("2026-09-02T10:00:00Z");
    const toMs = Date.parse("2026-09-02T10:00:00Z");
    expect(selectProjectDeployHistoryEntries(entries, ids, { fromMs, toMs }, 10).map((i) => i.approvalId)).toEqual(["a2"]);
  });

  it("never collects more than `cap` matching entries, even with no filters", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [
      successLine("a1", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z"),
      successLine("a2", "bbbbbbbbbbbb", "2026-09-02T10:00:00Z"),
      successLine("a3", "cccccccccccc", "2026-09-03T10:00:00Z"),
    ];
    const items = selectProjectDeployHistoryEntries(entries, new Set(["a1", "a2", "a3"]), {}, 2);
    expect(items.map((i) => i.approvalId)).toEqual(["a3", "a2"]);
  });

  it("falls back to null commit when the failure body names none", async () => {
    const { selectProjectDeployHistoryEntries } = await import("../services/deploy-history.js");
    const entries = [failLine("a1", "2026-09-01T10:00:00Z", "Deploy failed — could not fetch project proj-1.")];
    const items = selectProjectDeployHistoryEntries(entries, new Set(["a1"]), {}, 10);
    expect(items).toEqual([{ commit: null, approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z", status: "fail" }]);
  });
});

describe("parseDateBoundary", () => {
  it("anchors a bare date to UTC midnight for a start boundary", async () => {
    const { parseDateBoundary } = await import("../services/deploy-history.js");
    expect(parseDateBoundary("2026-09-01", false)).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
  });

  it("anchors a bare date to the end of day for an end boundary", async () => {
    const { parseDateBoundary } = await import("../services/deploy-history.js");
    expect(parseDateBoundary("2026-09-01", true)).toBe(Date.parse("2026-09-01T23:59:59.999Z"));
  });

  it("accepts a full ISO timestamp as-is", async () => {
    const { parseDateBoundary } = await import("../services/deploy-history.js");
    expect(parseDateBoundary("2026-09-01T06:30:00Z", false)).toBe(Date.parse("2026-09-01T06:30:00Z"));
  });

  it("returns null for unparseable input", async () => {
    const { parseDateBoundary } = await import("../services/deploy-history.js");
    expect(parseDateBoundary("not-a-date", false)).toBeNull();
  });
});

// The route reads through the company-scope middleware (companyScopeFromParam +
// createRequestScopedDb), so the fake must satisfy the reserved-connection
// lifecycle and answer the real drizzle query for `.select({ id })` with
// positional tuples -- see helpers/fake-scoped-db.ts.
function fakeDbWithApprovalIds(ids: string[]) {
  return withFakeCompanyScopeReserve({}, { unsafeRows: ids.map((id) => [id]) });
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
    const bbb = { commit: "bbbbbbbbbbbb", approvalId: "a2", deployedAt: "2026-09-02T10:00:00Z", status: "ok" };
    const aaa = { commit: "aaaaaaaaaaaa", approvalId: "a1", deployedAt: "2026-09-01T10:00:00Z", status: "ok" };
    expect(res.body).toEqual({
      current: bbb,
      previous: aaa,
      releases: [bbb, aaa],
      entries: [
        { ...bbb, status: "pass" },
        { ...aaa, status: "pass" },
      ],
      pagination: { limit: 10, offset: 0, total: 2, hasMore: false },
    });
    // DEFAULT_RELEASE_RETENTION_COUNT (10) * the per-release log-line budget.
    expect(mockReadDeployRunnerStatus).toHaveBeenCalledWith(COMPANY_ID, 400);
  });

  it("returns nulls when the runner has never deployed this project", async () => {
    mockReadDeployRunnerStatus.mockReturnValue([successLine("someone-else", "aaaaaaaaaaaa", "2026-09-01T10:00:00Z")]);
    const app = await createApp(fakeDbWithApprovalIds([]));
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/projects/${PROJECT_ID}/deploy-history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: null,
      previous: null,
      releases: [],
      entries: [],
      pagination: { limit: 10, offset: 0, total: 0, hasMore: false },
    });
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
