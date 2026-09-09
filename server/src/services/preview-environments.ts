import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, projectWorkspaces, projects, workspaceRuntimeServices } from "@paperclipai/db";
import {
  PREVIEW_DEFAULT_IDLE_TIMEOUT_MINUTES,
  PREVIEW_DEFAULT_MAX_CONCURRENT,
  buildPreviewProxyPath,
  describePreviewStatus,
  readApprovalPreviewRef,
  type PreviewEnvironment,
  type PreviewEnvironmentAvailability,
  type PreviewEnvironmentRef,
  type PreviewEnvironmentStatus,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { parseProjectDeployPolicy } from "./deploy-policy.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "./workspace-runtime.js";

const execFileAsync = promisify(execFile);

/** Marker on an execution workspace saying "this one is a throwaway preview". */
export const PREVIEW_WORKSPACE_MODE = "preview_environment";

/** Name given to the single runtime service that serves a preview. */
export const PREVIEW_SERVICE_NAME = "preview";

/** Directory (under the project's git repo root) preview checkouts live in. */
const PREVIEW_WORKTREE_DIR = path.join(".paperclip", "previews");

/** How long the git work (fetch + worktree add) may take before we give up. */
const GIT_TIMEOUT_MS = 120_000;

/** How long the preview command gets to answer its health path before we call it failed. */
const PREVIEW_READINESS_TIMEOUT_SEC = 180;

export interface PreviewEnvironmentLimits {
  maxConcurrent: number;
  idleTimeoutMinutes: number;
}

export const DEFAULT_PREVIEW_LIMITS: PreviewEnvironmentLimits = {
  maxConcurrent: PREVIEW_DEFAULT_MAX_CONCURRENT,
  idleTimeoutMinutes: PREVIEW_DEFAULT_IDLE_TIMEOUT_MINUTES,
};

type PreviewMetadata = {
  approvalId: string;
  status: PreviewEnvironmentStatus;
  ref: PreviewEnvironmentRef | null;
  resolvedCommit: string | null;
  failureReason: string | null;
  startedAt: string | null;
  lastUsedAt: string | null;
  idleTimeoutMinutes: number;
  warnings: string[];
};

function readPreviewMetadata(metadata: unknown): PreviewMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const preview = (metadata as Record<string, unknown>).preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const raw = preview as Record<string, unknown>;
  const approvalId = typeof raw.approvalId === "string" ? raw.approvalId : null;
  if (!approvalId) return null;
  const status = raw.status;
  return {
    approvalId,
    status:
      status === "starting" || status === "ready" || status === "failed" || status === "stopped"
        ? status
        : "stopped",
    ref: readRef(raw.ref),
    resolvedCommit: typeof raw.resolvedCommit === "string" ? raw.resolvedCommit : null,
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    lastUsedAt: typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : null,
    idleTimeoutMinutes:
      typeof raw.idleTimeoutMinutes === "number" && raw.idleTimeoutMinutes > 0
        ? raw.idleTimeoutMinutes
        : PREVIEW_DEFAULT_IDLE_TIMEOUT_MINUTES,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

function readRef(value: unknown): PreviewEnvironmentRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === "commit" || raw.kind === "branch" ? raw.kind : null;
  const refValue = typeof raw.value === "string" ? raw.value : null;
  if (!kind || !refValue) return null;
  return { kind, value: refValue, label: typeof raw.label === "string" ? raw.label : refValue };
}

/**
 * A branch or commit is only ever handed to git as a single argument, never
 * through a shell — but it still must not look like an option ("--upload-pack=...")
 * or contain the characters a ref can never contain.
 */
export function isSafeGitRefValue(value: string): boolean {
  if (!value || value.length > 255) return false;
  if (value.startsWith("-")) return false;
  if (value.includes("..") || value.endsWith(".lock") || value.endsWith("/")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(value);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

/**
 * Everything the operator is shown about a preview for one approval card.
 * `null` for `preview` simply means nothing is running — never an error.
 */
export interface PreviewEnvironmentView {
  preview: PreviewEnvironment | null;
  availability: PreviewEnvironmentAvailability;
}

export interface PreviewApprovalContext {
  approvalId: string;
  companyId: string;
  type: string;
  payload: Record<string, unknown>;
  /** Project the card belongs to. Resolved by the caller (payload or linked issue). */
  projectId: string | null;
}

export function previewEnvironmentService(rawDb: Db, options: Partial<PreviewEnvironmentLimits> = {}) {
  const limits: PreviewEnvironmentLimits = {
    maxConcurrent: Math.max(1, options.maxConcurrent ?? DEFAULT_PREVIEW_LIMITS.maxConcurrent),
    idleTimeoutMinutes: Math.max(1, options.idleTimeoutMinutes ?? DEFAULT_PREVIEW_LIMITS.idleTimeoutMinutes),
  };

  async function findWorkspaceRowForApproval(approvalId: string, companyId?: string | null) {
    const conditions = [
      eq(executionWorkspaces.mode, PREVIEW_WORKSPACE_MODE),
      inArray(executionWorkspaces.status, ["active", "idle"]),
    ];
    // Company scoping whenever the caller knows it: a preview is that
    // company's code running, and nothing here should ever reach across.
    if (companyId) conditions.push(eq(executionWorkspaces.companyId, companyId));
    const rows = await rawDb.select().from(executionWorkspaces).where(and(...conditions));
    return (
      rows.find((row) => readPreviewMetadata(row.metadata)?.approvalId === approvalId) ?? null
    );
  }

  async function listLivePreviewRows() {
    const rows = await rawDb
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.mode, PREVIEW_WORKSPACE_MODE),
          inArray(executionWorkspaces.status, ["active", "idle"]),
        ),
      );
    return rows.filter((row) => {
      const preview = readPreviewMetadata(row.metadata);
      return preview !== null && (preview.status === "starting" || preview.status === "ready");
    });
  }

  async function patchPreviewMetadata(workspaceId: string, patch: Partial<PreviewMetadata>) {
    const row = await rawDb
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0] ?? null);
    if (!row) return;
    const existing = (row.metadata ?? {}) as Record<string, unknown>;
    const preview = { ...(readPreviewMetadata(existing) ?? {}), ...patch };
    await rawDb
      .update(executionWorkspaces)
      .set({ metadata: { ...existing, preview }, updatedAt: new Date() })
      .where(eq(executionWorkspaces.id, workspaceId));
  }

  async function readServiceUrl(workspaceId: string): Promise<string | null> {
    const service = await rawDb
      .select({ url: workspaceRuntimeServices.url, status: workspaceRuntimeServices.status })
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.executionWorkspaceId, workspaceId),
          eq(workspaceRuntimeServices.serviceName, PREVIEW_SERVICE_NAME),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!service || service.status !== "running") return null;
    return service.url ?? null;
  }

  function toPreview(row: typeof executionWorkspaces.$inferSelect): PreviewEnvironment | null {
    const meta = readPreviewMetadata(row.metadata);
    if (!meta) return null;
    return {
      approvalId: meta.approvalId,
      companyId: row.companyId,
      projectId: row.projectId,
      workspaceId: row.id,
      status: meta.status,
      previewUrl: meta.status === "ready" ? buildPreviewProxyPath(row.id) : null,
      ref: meta.ref,
      message: describePreviewStatus({
        status: meta.status,
        refLabel: meta.ref?.label ?? null,
        failureReason: meta.failureReason,
        idleTimeoutMinutes: meta.idleTimeoutMinutes,
      }),
      failureReason: meta.failureReason,
      startedAt: meta.startedAt,
      lastUsedAt: meta.lastUsedAt,
      idleTimeoutMinutes: meta.idleTimeoutMinutes,
    };
  }

  /**
   * Resolve the project, its preview command, and the checkout it would run —
   * or the plain-language reason the operator cannot preview this card.
   */
  async function resolveStartPlan(context: PreviewApprovalContext): Promise<
    | {
        ok: true;
        ref: PreviewEnvironmentRef;
        projectId: string;
        projectWorkspaceId: string | null;
        baseCwd: string;
        previewCommand: string;
        previewHealthPath: string;
      }
    | { ok: false; reason: string }
  > {
    const ref = readApprovalPreviewRef(context.payload);
    if (!ref) {
      return {
        ok: false,
        reason: "This card does not say which version of the code it would ship, so there is nothing to start.",
      };
    }
    if (!isSafeGitRefValue(ref.value)) {
      return { ok: false, reason: `"${ref.value}" is not a name this can safely check out.` };
    }
    if (!context.projectId) {
      return { ok: false, reason: "This card is not linked to a project, so Paperclip does not know what to start." };
    }

    const project = await rawDb
      .select({ id: projects.id, companyId: projects.companyId, deployPolicy: projects.deployPolicy })
      .from(projects)
      .where(and(eq(projects.id, context.projectId), eq(projects.companyId, context.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!project) {
      return { ok: false, reason: "The project this card belongs to could not be found." };
    }

    const policy = parseProjectDeployPolicy(project.deployPolicy);
    const previewCommand = (policy?.previewCommand ?? "").trim();
    if (!previewCommand) {
      return {
        ok: false,
        reason:
          'This project has no "how to start a preview" command yet. Add one in the project\'s Deployment settings and the button starts working.',
      };
    }

    const workspaceRows = await rawDb
      .select({
        id: projectWorkspaces.id,
        cwd: projectWorkspaces.cwd,
        isPrimary: projectWorkspaces.isPrimary,
      })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, project.id),
          eq(projectWorkspaces.companyId, context.companyId),
        ),
      );
    const configuredWorkspaceId = (policy?.workspaceId ?? "").trim();
    const workspace =
      workspaceRows.find((row) => row.id === configuredWorkspaceId)
      ?? workspaceRows.find((row) => row.isPrimary)
      ?? workspaceRows[0]
      ?? null;
    if (!workspace?.cwd) {
      return {
        ok: false,
        reason: "This project has no folder on this machine to make a copy from.",
      };
    }

    return {
      ok: true,
      ref,
      projectId: project.id,
      projectWorkspaceId: workspace.id,
      baseCwd: workspace.cwd,
      previewCommand,
      previewHealthPath: normalizeHealthPath(policy?.previewHealthPath),
    };
  }

  /** Prepare a detached checkout of exactly the code the card would ship. */
  async function provisionPreviewCheckout(input: {
    baseCwd: string;
    workspaceId: string;
    ref: PreviewEnvironmentRef;
  }): Promise<{ worktreePath: string; repoRoot: string; commit: string; warnings: string[] }> {
    const warnings: string[] = [];
    const repoRoot = await git(["rev-parse", "--show-toplevel"], input.baseCwd);

    // Best effort: a preview of a branch is only honest if we looked for the
    // newest commit on it first. A repo with no reachable remote still gets a
    // preview -- of whatever is local -- and the operator is told so.
    try {
      if (input.ref.kind === "branch") {
        await git(["fetch", "--quiet", "origin", input.ref.value], repoRoot);
      } else {
        await git(["fetch", "--quiet", "origin"], repoRoot);
      }
    } catch (err) {
      warnings.push(
        `Could not check with the code host for newer commits (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). The preview uses the copy already on this machine.`,
      );
    }

    const candidates =
      input.ref.kind === "commit"
        ? [input.ref.value]
        : [`refs/remotes/origin/${input.ref.value}`, `refs/heads/${input.ref.value}`, input.ref.value];
    let commit: string | null = null;
    for (const candidate of candidates) {
      try {
        commit = await git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], repoRoot);
        if (commit) break;
      } catch {
        commit = null;
      }
    }
    if (!commit) {
      throw new Error(
        `this machine has no copy of ${input.ref.kind === "commit" ? `version ${input.ref.value.slice(0, 7)}` : `the branch ${input.ref.value}`}`,
      );
    }

    const worktreePath = path.join(repoRoot, PREVIEW_WORKTREE_DIR, input.workspaceId);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    // Detached on purpose: a preview never owns a branch, so it can never
    // block a branch that is already checked out somewhere else, and throwing
    // it away leaves nothing behind.
    await git(["worktree", "add", "--detach", worktreePath, commit], repoRoot);

    return { worktreePath, repoRoot, commit, warnings };
  }

  function buildPreviewRuntimeConfig(input: { previewCommand: string; previewHealthPath: string }) {
    return {
      workspaceRuntime: {
        services: [
          {
            name: PREVIEW_SERVICE_NAME,
            command: input.previewCommand,
            cwd: ".",
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            port: { type: "auto", envKey: "PORT" },
            expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
            readiness: {
              type: "http",
              urlTemplate: `http://127.0.0.1:{{port}}${input.previewHealthPath}`,
              timeoutSec: PREVIEW_READINESS_TIMEOUT_SEC,
            },
            stopPolicy: { type: "idle_timeout", idleSeconds: limits.idleTimeoutMinutes * 60 },
          },
        ],
      },
    } satisfies Record<string, unknown>;
  }

  /**
   * Stop the process, remove the throwaway checkout, and record what happened.
   *
   * `keep: "visible"` leaves the workspace row where the approval card can
   * still find it -- that is how a failed start keeps its reason on screen
   * instead of silently reverting to "nothing is running". A failed preview
   * holds no slot: only `starting` and `ready` count towards the limit.
   */
  async function tearDownWorkspace(
    workspaceId: string,
    reason: string,
    options: { previewStatus?: PreviewEnvironmentStatus; failureReason?: string | null; keep?: "visible" } = {},
  ) {
    const row = await rawDb
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0] ?? null);
    if (!row) return;

    await stopRuntimeServicesForExecutionWorkspace({
      db: rawDb,
      executionWorkspaceId: workspaceId,
      workspaceCwd: row.cwd,
    }).catch((err) => {
      logger.warn({ err, workspaceId }, "preview: stopping runtime services failed");
    });

    try {
      await cleanupExecutionWorkspaceArtifacts({
        workspace: {
          id: row.id,
          cwd: row.cwd,
          providerType: row.providerType,
          providerRef: row.providerRef,
          branchName: null,
          repoUrl: row.repoUrl,
          baseRef: row.baseRef,
          projectId: row.projectId,
          projectWorkspaceId: row.projectWorkspaceId,
          sourceIssueId: row.sourceIssueId,
          metadata: { createdByRuntime: false },
        },
      });
    } catch (err) {
      logger.warn({ err, workspaceId }, "preview: removing the throwaway checkout failed");
    }

    const existing = (row.metadata ?? {}) as Record<string, unknown>;
    const preview = {
      ...(readPreviewMetadata(existing) ?? {}),
      status: options.previewStatus ?? "stopped",
      failureReason: options.failureReason ?? null,
    };
    const visible = options.keep === "visible";
    await rawDb
      .update(executionWorkspaces)
      .set({
        status: visible ? "idle" : "archived",
        closedAt: visible ? null : new Date(),
        cleanupReason: reason,
        cwd: null,
        providerRef: null,
        metadata: { ...existing, preview },
        updatedAt: new Date(),
      })
      .where(eq(executionWorkspaces.id, workspaceId));
  }

  async function runStart(input: {
    workspaceId: string;
    companyId: string;
    plan: Extract<Awaited<ReturnType<typeof resolveStartPlan>>, { ok: true }>;
  }) {
    try {
      const checkout = await provisionPreviewCheckout({
        baseCwd: input.plan.baseCwd,
        workspaceId: input.workspaceId,
        ref: input.plan.ref,
      });
      await rawDb
        .update(executionWorkspaces)
        .set({ cwd: checkout.worktreePath, providerRef: checkout.worktreePath, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, input.workspaceId));
      await patchPreviewMetadata(input.workspaceId, {
        resolvedCommit: checkout.commit,
        warnings: checkout.warnings,
      });

      const realized: RealizedExecutionWorkspace = {
        baseCwd: input.plan.baseCwd,
        source: "task_session",
        projectId: input.plan.projectId,
        workspaceId: input.plan.projectWorkspaceId,
        repoUrl: null,
        repoRef: input.plan.ref.value,
        strategy: "git_worktree",
        cwd: checkout.worktreePath,
        branchName: null,
        worktreePath: checkout.worktreePath,
        warnings: checkout.warnings,
        created: true,
        baseRefSha: checkout.commit,
      };

      const services = await startRuntimeServicesForWorkspaceControl({
        db: rawDb,
        actor: { id: null, name: "Board", companyId: input.companyId },
        issue: null,
        workspace: realized,
        executionWorkspaceId: input.workspaceId,
        config: buildPreviewRuntimeConfig({
          previewCommand: input.plan.previewCommand,
          previewHealthPath: input.plan.previewHealthPath,
        }),
        adapterEnv: {},
        serviceIndex: 0,
      });

      if (services.length === 0 || !services[0]?.url) {
        throw new Error("the start command did not open a web address to look at");
      }

      await patchPreviewMetadata(input.workspaceId, {
        status: "ready",
        failureReason: null,
        lastUsedAt: new Date().toISOString(),
      });
      armIdleTimer(input.workspaceId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err, workspaceId: input.workspaceId }, "preview: start failed");
      // A half-started preview is still a checkout and possibly a process:
      // throw both away rather than leave them counting against the limit --
      // but keep the row so the card can tell the operator what went wrong.
      await tearDownWorkspace(input.workspaceId, "preview_start_failed", {
        previewStatus: "failed",
        failureReason: reason,
        keep: "visible",
      }).catch(() => undefined);
    }
  }

  const idleTimers = new Map<string, NodeJS.Timeout>();

  function armIdleTimer(workspaceId: string) {
    clearIdleTimer(workspaceId);
    const timer = setTimeout(() => {
      idleTimers.delete(workspaceId);
      void tearDownWorkspace(workspaceId, "preview_idle_timeout").catch(() => undefined);
    }, limits.idleTimeoutMinutes * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
    idleTimers.set(workspaceId, timer);
  }

  function clearIdleTimer(workspaceId: string) {
    const timer = idleTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    idleTimers.delete(workspaceId);
  }

  return {
    limits,

    /** What the approval card should show: a running preview, or why there is none. */
    describeForApproval: async (context: PreviewApprovalContext): Promise<PreviewEnvironmentView> => {
      const row = await findWorkspaceRowForApproval(context.approvalId, context.companyId);
      const preview = row ? toPreview(row) : null;
      const plan = await resolveStartPlan(context);
      return {
        preview,
        availability: plan.ok
          ? { canStart: true, blockedReason: null, ref: plan.ref }
          : { canStart: false, blockedReason: plan.reason, ref: readApprovalPreviewRef(context.payload) },
      };
    },

    /**
     * Start a preview for one approval card. Returns immediately with status
     * "starting" — the checkout and the start command run in the background,
     * because they routinely take longer than an operator's click should wait.
     */
    start: async (
      context: PreviewApprovalContext,
    ): Promise<{ ok: true; preview: PreviewEnvironment } | { ok: false; reason: string }> => {
      const existingRow = await findWorkspaceRowForApproval(context.approvalId, context.companyId);
      if (existingRow) {
        const existing = toPreview(existingRow);
        if (existing && (existing.status === "starting" || existing.status === "ready")) {
          return { ok: true, preview: existing };
        }
        await tearDownWorkspace(existingRow.id, "preview_replaced");
      }

      const plan = await resolveStartPlan(context);
      if (!plan.ok) return { ok: false, reason: plan.reason };

      const live = await listLivePreviewRows();
      if (live.length >= limits.maxConcurrent) {
        return {
          ok: false,
          reason: `${limits.maxConcurrent} preview${limits.maxConcurrent === 1 ? " is" : "s are"} already running, which is the most this machine runs at once. Close one from its approval card and try again.`,
        };
      }

      const now = new Date();
      const created = await rawDb
        .insert(executionWorkspaces)
        .values({
          companyId: context.companyId,
          projectId: plan.projectId,
          projectWorkspaceId: plan.projectWorkspaceId,
          mode: PREVIEW_WORKSPACE_MODE,
          strategyType: "git_worktree",
          providerType: "git_worktree",
          name: `Preview of ${plan.ref.label}`,
          status: "active",
          baseRef: plan.ref.value,
          metadata: {
            createdByRuntime: false,
            preview: {
              approvalId: context.approvalId,
              status: "starting",
              ref: plan.ref,
              resolvedCommit: null,
              failureReason: null,
              startedAt: now.toISOString(),
              lastUsedAt: now.toISOString(),
              idleTimeoutMinutes: limits.idleTimeoutMinutes,
              warnings: [],
            } satisfies PreviewMetadata,
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!created) return { ok: false, reason: "The preview could not be created." };

      void runStart({ workspaceId: created.id, companyId: context.companyId, plan });

      const preview = toPreview(created);
      return preview
        ? { ok: true, preview }
        : { ok: false, reason: "The preview could not be created." };
    },

    /** Throw a preview away. Safe to call when there is nothing running. */
    stopForApproval: async (approvalId: string, reason: string) => {
      const row = await findWorkspaceRowForApproval(approvalId);
      if (!row) return false;
      clearIdleTimer(row.id);
      await tearDownWorkspace(row.id, reason);
      return true;
    },

    /**
     * Look up a running preview by the workspace id in a proxy URL. Returns
     * the company it belongs to (so the caller can check the viewer may see
     * it) and the one local address the proxy is allowed to reach.
     */
    resolveProxyTarget: async (
      workspaceId: string,
    ): Promise<
      | { found: true; companyId: string; status: PreviewEnvironmentStatus; targetUrl: string | null; approvalId: string }
      | { found: false }
    > => {
      const row = await rawDb
        .select()
        .from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.mode, PREVIEW_WORKSPACE_MODE)))
        .then((rows) => rows[0] ?? null);
      if (!row) return { found: false };
      const meta = readPreviewMetadata(row.metadata);
      if (!meta) return { found: false };
      const targetUrl = meta.status === "ready" ? await readServiceUrl(row.id) : null;
      return {
        found: true,
        companyId: row.companyId,
        status: meta.status,
        targetUrl,
        approvalId: meta.approvalId,
      };
    },

    /** Push the idle deadline out — called every time the operator uses the preview. */
    touch: async (workspaceId: string) => {
      armIdleTimer(workspaceId);
      await patchPreviewMetadata(workspaceId, { lastUsedAt: new Date().toISOString() }).catch(() => undefined);
    },

    /**
     * Throw away every preview nobody has opened for longer than the idle
     * timeout. Runs on a timer, and also covers previews whose in-process
     * timer was lost to a server restart.
     */
    sweepIdle: async (now: Date = new Date()) => {
      const rows = await listLivePreviewRows();
      let stopped = 0;
      for (const row of rows) {
        const meta = readPreviewMetadata(row.metadata);
        if (!meta) continue;
        const last = meta.lastUsedAt ?? meta.startedAt;
        if (!last) continue;
        const ageMinutes = (now.getTime() - new Date(last).getTime()) / 60_000;
        if (ageMinutes < meta.idleTimeoutMinutes) continue;
        clearIdleTimer(row.id);
        await tearDownWorkspace(row.id, "preview_idle_timeout");
        stopped += 1;
      }
      return stopped;
    },

    /** Test seam: drop the in-process idle timers. */
    dispose: () => {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
    },
  };
}

export type PreviewEnvironmentService = ReturnType<typeof previewEnvironmentService>;

/**
 * Turn whatever the operator typed into a path the readiness check can use.
 * Empty means "the front page".
 */
export function normalizeHealthPath(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "/";
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+/i, "");
  const rooted = withoutOrigin.startsWith("/") ? withoutOrigin : `/${withoutOrigin}`;
  return rooted;
}

/**
 * Periodic idle sweep, started once at server boot (mirrors the heartbeat-run
 * retention sweep). Takes the raw db because it outlives every request.
 */
export function startPreviewEnvironmentIdleSweep(
  service: PreviewEnvironmentService,
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void service.sweepIdle().catch((err) => {
      logger.warn({ err }, "preview: idle sweep failed");
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
