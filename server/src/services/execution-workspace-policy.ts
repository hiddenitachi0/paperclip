import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
} from "@paperclipai/shared";
import { asString, parseObject } from "../adapters/utils.js";

type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return { ...value };
}

function parseExecutionWorkspaceStrategy(raw: unknown): ExecutionWorkspaceStrategy | null {
  const parsed = parseObject(raw);
  const type = asString(parsed.type, "");
  if (type !== "project_primary" && type !== "git_worktree" && type !== "adapter_managed" && type !== "cloud_sandbox") {
    return null;
  }
  return {
    type,
    ...(typeof parsed.baseRef === "string" ? { baseRef: parsed.baseRef } : {}),
    ...(typeof parsed.branchTemplate === "string" ? { branchTemplate: parsed.branchTemplate } : {}),
    ...(typeof parsed.worktreeParentDir === "string" ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.teardownCommand === "string" ? { teardownCommand: parsed.teardownCommand } : {}),
  };
}

export function parseProjectExecutionWorkspacePolicy(raw: unknown): ProjectExecutionWorkspacePolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const defaultMode = asString(parsed.defaultMode, "");
  const defaultProjectWorkspaceId =
    typeof parsed.defaultProjectWorkspaceId === "string" ? parsed.defaultProjectWorkspaceId : undefined;
  const allowIssueOverride =
    typeof parsed.allowIssueOverride === "boolean" ? parsed.allowIssueOverride : undefined;
  const normalizedDefaultMode = (() => {
    if (
      defaultMode === "shared_workspace" ||
      defaultMode === "isolated_workspace" ||
      defaultMode === "operator_branch" ||
      defaultMode === "adapter_default"
    ) {
      return defaultMode as ProjectExecutionWorkspaceDefaultMode;
    }
    if (defaultMode === "project_primary") return "shared_workspace";
    if (defaultMode === "isolated") return "isolated_workspace";
    return undefined;
  })();
  return {
    enabled,
    ...(normalizedDefaultMode ? { defaultMode: normalizedDefaultMode } : {}),
    ...(allowIssueOverride !== undefined ? { allowIssueOverride } : {}),
    ...(defaultProjectWorkspaceId ? { defaultProjectWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(parsed.branchPolicy && typeof parsed.branchPolicy === "object" && !Array.isArray(parsed.branchPolicy)
      ? { branchPolicy: { ...(parsed.branchPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.pullRequestPolicy && typeof parsed.pullRequestPolicy === "object" && !Array.isArray(parsed.pullRequestPolicy)
      ? { pullRequestPolicy: { ...(parsed.pullRequestPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.authorizationPolicy && typeof parsed.authorizationPolicy === "object" && !Array.isArray(parsed.authorizationPolicy)
      ? { authorizationPolicy: { ...(parsed.authorizationPolicy as Record<string, unknown>) } }
      : {}),
  };
}

export function gateProjectExecutionWorkspacePolicy(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
  isolatedWorkspacesEnabled: boolean,
): ProjectExecutionWorkspacePolicy | null {
  if (!isolatedWorkspacesEnabled) return null;
  return projectPolicy;
}

export function parseIssueExecutionWorkspaceSettings(raw: unknown): IssueExecutionWorkspaceSettings | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const mode = asString(parsed.mode, "");
  const normalizedMode = (() => {
    if (
      mode === "inherit" ||
      mode === "shared_workspace" ||
      mode === "isolated_workspace" ||
      mode === "operator_branch" ||
      mode === "reuse_existing" ||
      mode === "agent_default"
    ) {
      return mode;
    }
    if (mode === "project_primary") return "shared_workspace";
    if (mode === "isolated") return "isolated_workspace";
    return "";
  })();
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
  };
}

export type ExecutionWorkspaceEnvironmentSource =
  | "agent"
  | "instance"
  | "default";

export type ExecutionWorkspaceEnvironmentResolution = {
  environmentId: string;
  source: ExecutionWorkspaceEnvironmentSource;
};

export function resolveExecutionWorkspaceEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null;
  instanceDefaultEnvironmentId: string | null;
  localDefaultEnvironmentId: string;
}): ExecutionWorkspaceEnvironmentResolution {
  if (input.agentDefaultEnvironmentId) {
    return {
      environmentId: input.agentDefaultEnvironmentId,
      source: "agent",
    };
  }
  if (input.instanceDefaultEnvironmentId) {
    return {
      environmentId: input.instanceDefaultEnvironmentId,
      source: "instance",
    };
  }
  return {
    environmentId: input.localDefaultEnvironmentId,
    source: "default",
  };
}

export function defaultIssueExecutionWorkspaceSettingsForProject(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
): IssueExecutionWorkspaceSettings | null {
  if (!projectPolicy?.enabled) return null;
  return {
    mode:
      projectPolicy.defaultMode === "isolated_workspace"
        ? "isolated_workspace"
        : projectPolicy.defaultMode === "operator_branch"
          ? "operator_branch"
          : projectPolicy.defaultMode === "adapter_default"
            ? "agent_default"
            : "shared_workspace",
  };
}

export function issueExecutionWorkspaceModeForPersistedWorkspace(
  mode: string | null | undefined,
): IssueExecutionWorkspaceSettings["mode"] {
  if (mode === null || mode === undefined) {
    return "agent_default";
  }
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function resolveExecutionWorkspaceMode(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
}): ParsedExecutionWorkspaceMode {
  const issueMode = input.issueSettings?.mode;
  if (issueMode && issueMode !== "inherit" && issueMode !== "reuse_existing") {
    return issueMode;
  }
  if (input.projectPolicy?.enabled) {
    if (input.projectPolicy.defaultMode === "isolated_workspace") return "isolated_workspace";
    if (input.projectPolicy.defaultMode === "operator_branch") return "operator_branch";
    if (input.projectPolicy.defaultMode === "adapter_default") return "agent_default";
    return "shared_workspace";
  }
  if (input.legacyUseProjectWorkspace === false) {
    return "agent_default";
  }
  return "shared_workspace";
}

export function buildExecutionWorkspaceAdapterConfig(input: {
  agentConfig: Record<string, unknown>;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  mode: ParsedExecutionWorkspaceMode;
  legacyUseProjectWorkspace: boolean | null;
  issueProjectId?: string | null;
  issueProjectWorkspaceId?: string | null;
}): Record<string, unknown> {
  const nextConfig = { ...input.agentConfig };
  const projectHasPolicy = Boolean(input.projectPolicy?.enabled);
  const issueHasWorkspaceOverrides = Boolean(
    input.issueSettings?.mode ||
    input.issueSettings?.workspaceStrategy ||
    input.issueSettings?.workspaceRuntime,
  );
  const hasWorkspaceControl = projectHasPolicy || issueHasWorkspaceOverrides || input.legacyUseProjectWorkspace === false;

  if (hasWorkspaceControl) {
    if (input.mode === "isolated_workspace") {
      const strategy =
        input.issueSettings?.workspaceStrategy ??
        input.projectPolicy?.workspaceStrategy ??
        parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy) ??
        ({ type: "git_worktree" } satisfies ExecutionWorkspaceStrategy);
      nextConfig.workspaceStrategy = strategy as unknown as Record<string, unknown>;
    } else {
      delete nextConfig.workspaceStrategy;
    }

    if (input.mode === "agent_default") {
      delete nextConfig.workspaceRuntime;
    } else if (input.issueSettings?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.issueSettings.workspaceRuntime) ?? undefined;
    } else if (input.projectPolicy?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.projectPolicy.workspaceRuntime) ?? undefined;
    }
  } else if (input.mode === "shared_workspace") {
    // No project policy, issue override, or legacy opt-out configures workspace
    // isolation at all here — this is the project_primary default path that used
    // to hand every concurrent run the exact same checkout with no isolation
    // (DUR-75/DUR-82). Default it to git_worktree instead of leaving
    // workspaceStrategy unset, which used to fall through to the shared
    // checkout in realizeExecutionWorkspace's own default.
    //
    // Only default to git_worktree when the issue is actually linked to a
    // project workspace with a resolvable project id — that's the only case
    // that can suffer the DUR-75 collision (concurrent runs sharing that
    // project's primary checkout). Issues with no project linkage at all
    // resolve to a per-agent/per-task-session cwd that was never shared, so
    // forcing a worktree there would instead try (and likely fail) to
    // resolve a git repo root that doesn't correspond to any real checkout.
    // Issues linked to a project workspace but missing a project id are a
    // separate misconfiguration that must surface the existing friendly
    // "missing_project_id" validation error later in dispatch
    // (assertGitSensitiveAdapterWorkspaceValid), not an opaque worktree
    // setup failure.
    if (input.issueProjectWorkspaceId && input.issueProjectId) {
      nextConfig.workspaceStrategy = { type: "git_worktree" } satisfies ExecutionWorkspaceStrategy as unknown as Record<
        string,
        unknown
      >;
    }
  }

  return nextConfig;
}
