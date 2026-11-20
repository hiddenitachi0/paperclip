import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// DUR-5208: only a board user may change where a project's code lives.

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
  removeWorkspace: vi.fn(),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  updateWorkspace: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({ normalizeEnvBindingsForPersistence: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

const REFUSAL = "Only a person on the board can change where this project's code lives or how it is built.";
const companyId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";

function registerMocks() {
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    executionWorkspaceService: () => ({ getById: vi.fn(), update: vi.fn() }),
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/workspace-runtime.js", () => ({
    cleanupExecutionWorkspaceArtifacts: vi.fn(),
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForExecutionWorkspace: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

let counter = 0;
async function createApp(actor: Record<string, unknown>) {
  registerMocks();
  counter += 1;
  const routeModulePath = `../routes/projects.js?ws-board-only-${counter}`;
  const middlewareModulePath = `../middleware/index.js?ws-board-only-${counter}`;
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/projects.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes(withFakeCompanyScopeReserve({}) as any));
  app.use(errorHandler);
  return app;
}

const agentActor = { type: "agent", agentId: "agent-1", companyId, source: "agent_key", runId: "run-1" };
const boardActor = {
  type: "board",
  userId: "board-1",
  companyIds: [companyId],
  source: "session",
  isInstanceAdmin: false,
};

function buildWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: workspaceId,
    companyId,
    projectId,
    name: "Workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: "https://github.com/acme/app",
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: { testCommand: "pnpm test", note: "keep" },
    runtimeConfig: null,
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildProject() {
  return {
    id: projectId,
    companyId,
    urlKey: "project",
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
    codebase: null,
    workspaces: [buildWorkspace()],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe.sequential("project workspace code-location is board-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockEnvironmentService.getById.mockResolvedValue(null);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_c, env) => env);
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.create.mockResolvedValue(buildProject());
    mockProjectService.listWorkspaces.mockResolvedValue([buildWorkspace()]);
    mockProjectService.createWorkspace.mockResolvedValue(buildWorkspace());
    mockProjectService.updateWorkspace.mockResolvedValue(buildWorkspace());
    mockProjectService.removeWorkspace.mockResolvedValue(buildWorkspace());
  });

  const refusedPatches: Array<[string, Record<string, unknown>]> = [
    ["repoUrl", { repoUrl: "https://example.com/elsewhere/app" }],
    ["repoRef", { repoRef: "my-own-branch" }],
    ["defaultRef", { defaultRef: "my-own-branch" }],
    ["isPrimary", { isPrimary: false }],
    ["setupCommand", { setupCommand: "pnpm install" }],
    ["metadata.testCommand (changed)", { metadata: { testCommand: "true" } }],
    ["metadata.testCommand (dropped by replacing metadata)", { metadata: { note: "keep" } }],
  ];

  it.each(refusedPatches)("refuses an agent PATCH that changes %s", async (_label, patch) => {
    const app = await createApp(agentActor);
    const res = await request(app).patch(`/api/projects/${projectId}/workspaces/${workspaceId}`).send(patch);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an agent PATCH that changes cleanupCommand", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ cleanupCommand: "rm -rf /tmp/x" });
    expect(res.status).toBe(403);
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an agent creating a workspace", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .post(`/api/projects/${projectId}/workspaces`)
      .send({ name: "New", cwd: "/tmp/new" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an agent creating a project with a workspace", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "P", workspace: { name: "W", repoUrl: "https://github.com/acme/app" } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
    expect(mockProjectService.create).not.toHaveBeenCalled();
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  }, 15000);

  // DUR-5231: a project PATCH replaces the whole executionWorkspacePolicy, so omitting a
  // board-set protected field drops it just like naming it would change it.
  describe("project PATCH cannot drop a board-set execution workspace policy", () => {
    const storedPolicy = {
      enabled: true,
      requireIsolation: true,
      workspaceRuntime: { services: [{ name: "x", command: "id" }] },
      workspaceStrategy: { type: "git_worktree", provisionCommand: "p" },
    };

    beforeEach(() => {
      mockProjectService.getById.mockResolvedValue({ ...buildProject(), executionWorkspacePolicy: storedPolicy });
      mockProjectService.update.mockResolvedValue({ ...buildProject(), executionWorkspacePolicy: null });
    });

    it.each([
      ["{ enabled: false }", { executionWorkspacePolicy: { enabled: false } }],
      ["null", { executionWorkspacePolicy: null }],
    ])("refuses an agent sending executionWorkspacePolicy: %s", async (_label, body) => {
      const app = await createApp(agentActor);
      const res = await request(app).patch(`/api/projects/${projectId}`).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("requireIsolation");
      expect(mockProjectService.update).not.toHaveBeenCalled();
    }, 15000);

    it("lets an agent PATCH other fields without touching the policy", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).patch(`/api/projects/${projectId}`).send({ name: "Renamed" });
      expect(res.status).toBe(200);
      expect(mockProjectService.update).toHaveBeenCalledTimes(1);
    }, 15000);

    it("lets a board user clear the policy", async () => {
      const app = await createApp(boardActor);
      const res = await request(app).patch(`/api/projects/${projectId}`).send({ executionWorkspacePolicy: null });
      expect(res.status).toBe(200);
      expect(mockProjectService.update).toHaveBeenCalledTimes(1);
    }, 15000);
  });

  it("refuses an agent deleting a workspace", async () => {
    const app = await createApp(agentActor);
    const res = await request(app).delete(`/api/projects/${projectId}/workspaces/${workspaceId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
    expect(mockProjectService.removeWorkspace).not.toHaveBeenCalled();
  }, 15000);

  it("lets an agent change other workspace fields, including resending unchanged code-location fields", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({
        name: "Renamed",
        repoUrl: "https://github.com/acme/app",
        repoRef: "main",
        isPrimary: true,
        metadata: { testCommand: "pnpm test", note: "changed" },
      });
    expect(res.status).toBe(200);
    expect(mockProjectService.updateWorkspace).toHaveBeenCalledTimes(1);
  }, 15000);

  it("lets a board user create, change and delete workspaces", async () => {
    const app = await createApp(boardActor);
    const created = await request(app)
      .post(`/api/projects/${projectId}/workspaces`)
      .send({ name: "New", repoUrl: "https://github.com/acme/app", repoRef: "main" });
    expect(created.status).toBe(201);
    const updated = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ repoUrl: "https://github.com/acme/other", repoRef: "release", metadata: { testCommand: "pnpm t" } });
    expect(updated.status).toBe(200);
    const deleted = await request(app).delete(`/api/projects/${projectId}/workspaces/${workspaceId}`);
    expect(deleted.status).toBe(200);
    expect(mockProjectService.removeWorkspace).toHaveBeenCalledTimes(1);
  }, 15000);
});
