/**
 * Previews are disposable, and that promise is only worth as much as the code
 * that keeps it. This suite runs the lifecycle against real Postgres:
 *
 * - a preview nobody has opened for longer than its idle timeout is thrown away,
 * - deciding the card throws its preview away,
 * - the instance never runs more than N at once,
 * - and the proxy is only ever told a local address for a preview that is ready.
 *
 * The git checkout and the start command itself are deliberately not exercised
 * here — they need a real repository and a real app. See the notes in the
 * bundle report for what that leaves untested.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  PREVIEW_SERVICE_NAME,
  PREVIEW_WORKSPACE_MODE,
  isSafeGitRefValue,
  normalizeHealthPath,
  previewEnvironmentService,
} from "../services/preview-environments.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("preview environments against embedded Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-preview-environments-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject(previewCommand: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Preview co ${companyId.slice(0, 8)}`,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Previewable project",
      deployPolicy: {
        enabled: true,
        requestingAgentId: null,
        workspaceId: "",
        deployTargetPath: "/srv/app",
        deployKind: "custom",
        healthCheckUrl: "",
        rollback: "none",
        ...(previewCommand ? { previewCommand } : {}),
      },
    });
    const workspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "primary",
      cwd: "/tmp/does-not-need-to-exist-for-these-assertions",
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId: workspaceId };
  }

  /** Seed a preview row directly — the state a successful start would have left. */
  async function seedPreview(input: {
    companyId: string;
    projectId: string;
    approvalId: string;
    status: "starting" | "ready";
    lastUsedAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      mode: PREVIEW_WORKSPACE_MODE,
      strategyType: "git_worktree",
      providerType: "git_worktree",
      name: "Preview",
      status: "active",
      metadata: {
        createdByRuntime: false,
        preview: {
          approvalId: input.approvalId,
          status: input.status,
          ref: { kind: "branch", value: "build/thing", label: "the latest code on build/thing" },
          resolvedCommit: null,
          failureReason: null,
          startedAt: input.lastUsedAt.toISOString(),
          lastUsedAt: input.lastUsedAt.toISOString(),
          idleTimeoutMinutes: 60,
          warnings: [],
        },
      },
    });
    return id;
  }

  async function readWorkspace(id: string) {
    return await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("shows an operator a running preview and its link", async () => {
    const seed = await seedProject("node server.js");
    const approvalId = randomUUID();
    const workspaceId = await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId,
      status: "ready",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db);
    try {
      const view = await service.describeForApproval({
        approvalId,
        companyId: seed.companyId,
        type: "request_board_approval",
        payload: { kind: "merge_pr", branch: "build/thing", repo: "x/y", prNumber: 1 },
        projectId: seed.projectId,
      });
      expect(view.preview?.status).toBe("ready");
      expect(view.preview?.previewUrl).toBe(`/_preview/${workspaceId}/`);
      expect(view.preview?.message).toContain("is running");
      expect(view.availability.canStart).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it("tells the operator in plain words when the project has no start command", async () => {
    const seed = await seedProject(null);
    const service = previewEnvironmentService(db);
    try {
      const view = await service.describeForApproval({
        approvalId: randomUUID(),
        companyId: seed.companyId,
        type: "request_board_approval",
        payload: { kind: "deploy", commit: "abc1234", projectId: seed.projectId },
        projectId: seed.projectId,
      });
      expect(view.preview).toBeNull();
      expect(view.availability.canStart).toBe(false);
      expect(view.availability.blockedReason).toContain("Deployment settings");
      const started = await service.start({
        approvalId: randomUUID(),
        companyId: seed.companyId,
        type: "request_board_approval",
        payload: { kind: "deploy", commit: "abc1234", projectId: seed.projectId },
        projectId: seed.projectId,
      });
      expect(started).toEqual({ ok: false, reason: expect.stringContaining("Deployment settings") });
    } finally {
      service.dispose();
    }
  });

  it("never runs more previews at once than the instance allows", async () => {
    const seed = await seedProject("node server.js");
    await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId: randomUUID(),
      status: "ready",
      lastUsedAt: new Date(),
    });
    await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId: randomUUID(),
      status: "starting",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db, { maxConcurrent: 2 });
    try {
      const started = await service.start({
        approvalId: randomUUID(),
        companyId: seed.companyId,
        type: "request_board_approval",
        payload: { kind: "merge_pr", branch: "build/third", repo: "x/y", prNumber: 3 },
        projectId: seed.projectId,
      });
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.reason).toContain("already running");
    } finally {
      service.dispose();
    }
  });

  it("throws a preview away when the card is decided", async () => {
    const seed = await seedProject("node server.js");
    const approvalId = randomUUID();
    const workspaceId = await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId,
      status: "ready",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db);
    try {
      expect(await service.stopForApproval(approvalId, "approval_approved")).toBe(true);
      const row = await readWorkspace(workspaceId);
      expect(row?.status).toBe("archived");
      expect(row?.closedAt).not.toBeNull();
      expect(row?.cleanupReason).toBe("approval_approved");
      // Stopping something that is already gone is not an error.
      expect(await service.stopForApproval(approvalId, "approval_approved")).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("throws away a preview nobody has opened for longer than the idle timeout", async () => {
    const seed = await seedProject("node server.js");
    const staleId = await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId: randomUUID(),
      status: "ready",
      lastUsedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const freshId = await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId: randomUUID(),
      status: "ready",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db);
    try {
      const stopped = await service.sweepIdle(new Date());
      expect(stopped).toBeGreaterThanOrEqual(1);
      expect((await readWorkspace(staleId))?.status).toBe("archived");
      expect((await readWorkspace(freshId))?.status).toBe("active");
    } finally {
      service.dispose();
    }
  });

  it("keeps a failed preview on the card so the operator learns why", async () => {
    const seed = await seedProject("node server.js");
    const approvalId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: seed.companyId,
      projectId: seed.projectId,
      mode: PREVIEW_WORKSPACE_MODE,
      strategyType: "git_worktree",
      providerType: "git_worktree",
      name: "Preview",
      // Exactly the state a failed start leaves behind: cleaned up, still visible.
      status: "idle",
      cleanupReason: "preview_start_failed",
      metadata: {
        createdByRuntime: false,
        preview: {
          approvalId,
          status: "failed",
          ref: { kind: "branch", value: "build/thing", label: "the latest code on build/thing" },
          resolvedCommit: null,
          failureReason: "this machine has no copy of the branch build/thing",
          startedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          idleTimeoutMinutes: 60,
          warnings: [],
        },
      },
    });
    const service = previewEnvironmentService(db);
    try {
      const view = await service.describeForApproval({
        approvalId,
        companyId: seed.companyId,
        type: "request_board_approval",
        payload: { kind: "merge_pr", branch: "build/thing", repo: "x/y", prNumber: 1 },
        projectId: seed.projectId,
      });
      expect(view.preview?.status).toBe("failed");
      expect(view.preview?.message).toContain("did not start");
      expect(view.preview?.failureReason).toContain("no copy of the branch");
      expect(view.preview?.previewUrl).toBeNull();
      // A failed preview holds no slot.
      expect(view.availability.canStart).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it("does not let one company's card see another company's preview", async () => {
    const a = await seedProject("node server.js");
    const b = await seedProject("node server.js");
    const approvalId = randomUUID();
    await seedPreview({
      companyId: a.companyId,
      projectId: a.projectId,
      approvalId,
      status: "ready",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db);
    try {
      const view = await service.describeForApproval({
        approvalId,
        companyId: b.companyId,
        type: "request_board_approval",
        payload: { kind: "merge_pr", branch: "build/thing", repo: "x/y", prNumber: 1 },
        projectId: b.projectId,
      });
      expect(view.preview).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("only tells the proxy a local address once the preview is actually serving", async () => {
    const seed = await seedProject("node server.js");
    const approvalId = randomUUID();
    const workspaceId = await seedPreview({
      companyId: seed.companyId,
      projectId: seed.projectId,
      approvalId,
      status: "ready",
      lastUsedAt: new Date(),
    });
    const service = previewEnvironmentService(db);
    try {
      // No runtime-service row yet: nothing to proxy to.
      const before = await service.resolveProxyTarget(workspaceId);
      expect(before).toMatchObject({ found: true, companyId: seed.companyId, targetUrl: null });

      await db.insert(workspaceRuntimeServices).values({
        id: randomUUID(),
        companyId: seed.companyId,
        projectId: seed.projectId,
        executionWorkspaceId: workspaceId,
        scopeType: "execution_workspace",
        scopeId: workspaceId,
        serviceName: PREVIEW_SERVICE_NAME,
        status: "running",
        lifecycle: "shared",
        provider: "local_process",
        url: "http://127.0.0.1:45678",
        port: 45678,
      });
      const after = await service.resolveProxyTarget(workspaceId);
      expect(after).toMatchObject({ found: true, targetUrl: "http://127.0.0.1:45678" });

      // A workspace that is not a preview is invisible to the proxy.
      expect(await service.resolveProxyTarget(randomUUID())).toEqual({ found: false });
    } finally {
      service.dispose();
    }
  });
});

describe("preview checkout guards", () => {
  it("refuses a branch or commit name git could misread as an option", () => {
    expect(isSafeGitRefValue("build/fix-login")).toBe(true);
    expect(isSafeGitRefValue("a1b2c3d4")).toBe(true);
    expect(isSafeGitRefValue("--upload-pack=evil")).toBe(false);
    expect(isSafeGitRefValue("a b")).toBe(false);
    expect(isSafeGitRefValue("main;rm -rf /")).toBe(false);
    expect(isSafeGitRefValue("../../etc")).toBe(false);
    expect(isSafeGitRefValue("")).toBe(false);
  });

  it("turns whatever the operator typed into a usable health path", () => {
    expect(normalizeHealthPath(undefined)).toBe("/");
    expect(normalizeHealthPath("  ")).toBe("/");
    expect(normalizeHealthPath("api/health")).toBe("/api/health");
    expect(normalizeHealthPath("/api/health")).toBe("/api/health");
    expect(normalizeHealthPath("http://localhost:3000/api/health")).toBe("/api/health");
  });
});
