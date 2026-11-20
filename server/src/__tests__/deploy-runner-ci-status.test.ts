/**
 * DUR-5183: GET /companies/:companyId/projects/:projectId/ci-status reads the checks of one
 * version of the project's deploy repository through the server's own GitHub access, so a
 * session with only a read-only deploy key can tell whether it is time to file a deploy card.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const mockGhFetch = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockResolveDeployWorkspaceId = vi.hoisted(() => vi.fn());

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: () => "https://api.github.com",
}));
vi.mock("../services/index.js", () => ({
  secretService: () => ({ resolveGitHubToken: mockResolveGitHubToken }),
}));
vi.mock("../services/deploy-workspace.js", () => ({
  resolveProjectDeployWorkspaceId: mockResolveDeployWorkspaceId,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const SHA = "abc1234def5678901234567890abcdef12345678";

function fakeDb(opts: { projectExists?: boolean; repoUrl?: string | null } = {}) {
  const projectExists = opts.projectExists ?? true;
  const repoUrl = opts.repoUrl === undefined ? "https://github.com/acme/widgets" : opts.repoUrl;
  return withFakeCompanyScopeReserve(
    {},
    {
      unsafeRows: (query: string) => {
        if (query.includes('"project_workspaces"')) return [[repoUrl]];
        if (query.includes('"projects"')) return projectExists ? [[PROJECT_ID]] : [];
        return [];
      },
    },
  );
}

async function createApp(db: unknown) {
  const [{ errorHandler }, { deployRunnerRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/deploy-runner.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
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

function github(runs: Array<{ name: string; status: string; conclusion: string | null }>) {
  mockGhFetch.mockImplementation(async (url: string) => {
    if (url.includes("/check-runs")) {
      return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), { status: 200 });
    }
    return new Response(JSON.stringify({ state: "pending", total_count: 0, statuses: [] }), { status: 200 });
  });
}

const url = (sha: string | null = SHA, company = COMPANY_ID) =>
  `/api/companies/${company}/projects/${PROJECT_ID}/ci-status${sha === null ? "" : `?sha=${sha}`}`;

describe("GET /companies/:companyId/projects/:projectId/ci-status", () => {
  beforeEach(() => {
    mockGhFetch.mockReset();
    mockResolveGitHubToken.mockReset().mockResolvedValue("ghp_secret");
    mockResolveDeployWorkspaceId.mockReset().mockResolvedValue(WORKSPACE_ID);
  });

  it("reports green for a commit whose checks all passed", async () => {
    github([{ name: "build", status: "completed", conclusion: "success" }]);
    const res = await request(await createApp(fakeDb())).get(url());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "green",
      failedChecks: [],
      pendingChecks: [],
      sha: SHA,
      repo: "acme/widgets",
    });
    // The company's GitHub token is used, and the right repository is asked.
    const asked = mockGhFetch.mock.calls.map((call) => call[0] as string);
    expect(asked.every((u) => u.includes("/repos/acme/widgets/commits/"))).toBe(true);
    expect(mockGhFetch.mock.calls[0]![1].headers.authorization).toBe("Bearer ghp_secret");
  });

  it("reports pending checks by name", async () => {
    github([
      { name: "build", status: "in_progress", conclusion: null },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    const res = await request(await createApp(fakeDb())).get(url());
    expect(res.body).toMatchObject({ state: "pending", pendingChecks: ["build"], failedChecks: [] });
  });

  it("reports failed checks by name", async () => {
    github([{ name: "unit tests", status: "completed", conclusion: "failure" }]);
    const res = await request(await createApp(fakeDb())).get(url());
    expect(res.body).toMatchObject({ state: "failed", failedChecks: ["unit tests"] });
  });

  it("reports unknown (never green) when GitHub cannot be asked", async () => {
    mockGhFetch.mockRejectedValue(new Error("network down"));
    const res = await request(await createApp(fakeDb())).get(url());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unknown");
  });

  it("refuses a missing or malformed sha with 400 and asks GitHub nothing", async () => {
    const app = await createApp(fakeDb());
    expect((await request(app).get(url(null))).status).toBe(400);
    expect((await request(app).get(url("not-hex"))).status).toBe(400);
    expect((await request(app).get(url("abc12"))).status).toBe(400);
    expect((await request(app).get(url("a".repeat(41)))).status).toBe(400);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("is 404 for a project that is not in this company", async () => {
    const res = await request(await createApp(fakeDb({ projectExists: false }))).get(url());
    expect(res.status).toBe(404);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("is 422 when the project has no deploy workspace or it is not a github.com repository", async () => {
    mockResolveDeployWorkspaceId.mockResolvedValueOnce(null);
    expect((await request(await createApp(fakeDb())).get(url())).status).toBe(422);
    const res = await request(await createApp(fakeDb({ repoUrl: "https://gitlab.com/acme/widgets" }))).get(url());
    expect(res.status).toBe(422);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("is 403 for a board user of another company", async () => {
    const res = await request(await createApp(fakeDb())).get(url(SHA, OTHER_COMPANY_ID));
    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });
});
