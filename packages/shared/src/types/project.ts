import type { BudgetWindowKind, PauseReason, ProjectStatus } from "../constants.js";
import type {
  ProjectDeployPolicy,
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspaceRuntimeConfig,
  WorkspaceRuntimeService,
} from "./workspace-runtime.js";
import type { AgentEnvConfig } from "./secrets.js";

export type ProjectWorkspaceSourceType = "local_path" | "git_repo" | "remote_managed" | "non_git_path";
export type ProjectWorkspaceVisibility = "default" | "advanced";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

/**
 * Lightweight per-project budget summary surfaced on the projects list payload
 * (IA Phase 4 — PAP-60). Reflects the active `billed_cents` budget policy scoped
 * to the project, when one is set.
 */
export interface ProjectBudgetSummary {
  /** Budget limit in cents. */
  amountCents: number;
  windowKind: BudgetWindowKind;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string | null;
  cleanupCommand: string | null;
  remoteProvider: string | null;
  remoteWorkspaceRef: string | null;
  sharedWorkspaceKey: string | null;
  metadata: Record<string, unknown> | null;
  runtimeConfig: ProjectWorkspaceRuntimeConfig | null;
  isPrimary: boolean;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectCodebaseOrigin = "local_folder" | "managed_checkout";

export interface ProjectCodebase {
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  repoName: string | null;
  localFolder: string | null;
  managedFolder: string;
  effectiveLocalFolder: string;
  origin: ProjectCodebaseOrigin;
}

/**
 * Result of "Check token" on a project with a GitHub repo: which GitHub
 * scopes the project needs and whether the bound token has them. Carries
 * scope names, statuses and the GitHub login -- never the token itself.
 */
export type GitHubTokenScopeStatus = "ok" | "missing" | "unknown";

export interface GitHubTokenRequirement {
  /** GitHub's own name for the permission, e.g. "repo" or "workflow". */
  scope: string;
  /** Why the project needs it, in operator language. */
  why: string;
  /** Whether this repo actually needs it (workflow only matters with CI files). */
  required: boolean;
}

export interface GitHubTokenScopeResult extends GitHubTokenRequirement {
  status: GitHubTokenScopeStatus;
  /** Extra sentence when the status is not "ok". */
  note?: string;
}

export interface GitHubTokenCheckReport {
  tokenKind: "classic" | "fine_grained" | "unknown";
  login: string | null;
  repo: { owner: string; name: string; hostname: string; private: boolean | null; defaultBranch: string | null };
  /** Whether the repo has files under .github/workflows (null when it could not be checked). */
  hasWorkflows: boolean | null;
  scopes: GitHubTokenScopeResult[];
  summary: string;
  ok: boolean;
  /** Where the checked token came from, e.g. "the project's Env setting GITHUB_TOKEN". */
  tokenSource?: string;
}

export interface ProjectManagedByPlugin {
  id: string;
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  resourceKind: "project";
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  env: AgentEnvConfig | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  deployPolicy: ProjectDeployPolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  managedByPlugin?: ProjectManagedByPlugin | null;
  /**
   * Number of tasks (issues) in the project. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  taskCount?: number;
  /**
   * Active budget for the project, when set. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  budget?: ProjectBudgetSummary | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
