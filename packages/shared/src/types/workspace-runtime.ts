import type { TrustAuthorizationPolicy } from "../trust-policy.js";

export type ExecutionWorkspaceStrategyType =
  | "project_primary"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type ProjectExecutionWorkspaceDefaultMode =
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "adapter_default";

export type ExecutionWorkspaceMode =
  | "inherit"
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "reuse_existing"
  | "agent_default";

export type ExecutionWorkspaceProviderType =
  | "local_fs"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type ExecutionWorkspaceStatus =
  | "active"
  | "idle"
  | "in_review"
  | "archived"
  | "cleanup_failed";

export type ExecutionWorkspaceCloseReadinessState =
  | "ready"
  | "ready_with_warnings"
  | "blocked";

export type ExecutionWorkspaceCloseActionKind =
  | "archive_record"
  | "stop_runtime_services"
  | "cleanup_command"
  | "teardown_command"
  | "git_worktree_remove"
  | "git_branch_delete"
  | "remove_local_directory";

export type WorkspaceRuntimeDesiredState = "running" | "stopped" | "manual";
export type WorkspaceRuntimeServiceStateMap = Record<string, WorkspaceRuntimeDesiredState>;
export type WorkspaceCommandKind = "service" | "job";

export interface WorkspaceCommandSource {
  type: "paperclip";
  key: "commands" | "services" | "jobs";
  index: number;
}

export interface WorkspaceCommandDefinition {
  id: string;
  name: string;
  kind: WorkspaceCommandKind;
  command: string | null;
  cwd: string | null;
  lifecycle: "shared" | "ephemeral" | null;
  serviceIndex: number | null;
  disabledReason: string | null;
  rawConfig: Record<string, unknown>;
  source: WorkspaceCommandSource;
}

export interface ExecutionWorkspaceStrategy {
  type: ExecutionWorkspaceStrategyType;
  baseRef?: string | null;
  branchTemplate?: string | null;
  worktreeParentDir?: string | null;
  provisionCommand?: string | null;
  teardownCommand?: string | null;
}

export interface ExecutionWorkspaceConfig {
  environmentId?: string | null;
  provisionCommand: string | null;
  teardownCommand: string | null;
  cleanupCommand: string | null;
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}

export interface ProjectWorkspaceRuntimeConfig {
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}

export interface WorkspaceRuntimeControlTarget {
  workspaceCommandId?: string | null;
  runtimeServiceId?: string | null;
  serviceIndex?: number | null;
}

export interface ExecutionWorkspaceCloseAction {
  kind: ExecutionWorkspaceCloseActionKind;
  label: string;
  description: string;
  command: string | null;
}

export interface ExecutionWorkspaceCloseLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  isTerminal: boolean;
}

export interface ExecutionWorkspaceCloseGitReadiness {
  repoRoot: string | null;
  workspacePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  hasDirtyTrackedFiles: boolean;
  hasUntrackedFiles: boolean;
  dirtyEntryCount: number;
  untrackedEntryCount: number;
  aheadCount: number | null;
  behindCount: number | null;
  isMergedIntoBase: boolean | null;
  createdByRuntime: boolean;
}

export interface ExecutionWorkspaceCloseReadiness {
  workspaceId: string;
  state: ExecutionWorkspaceCloseReadinessState;
  blockingReasons: string[];
  warnings: string[];
  linkedIssues: ExecutionWorkspaceCloseLinkedIssue[];
  plannedActions: ExecutionWorkspaceCloseAction[];
  isDestructiveCloseAllowed: boolean;
  isSharedWorkspace: boolean;
  isProjectPrimaryWorkspace: boolean;
  git: ExecutionWorkspaceCloseGitReadiness | null;
  runtimeServices: WorkspaceRuntimeService[];
}

export interface ProjectExecutionWorkspacePolicy {
  enabled: boolean;
  defaultMode?: ProjectExecutionWorkspaceDefaultMode;
  allowIssueOverride?: boolean;
  defaultProjectWorkspaceId?: string | null;
  environmentId?: string | null;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
  branchPolicy?: Record<string, unknown> | null;
  pullRequestPolicy?: Record<string, unknown> | null;
  runtimePolicy?: Record<string, unknown> | null;
  cleanupPolicy?: Record<string, unknown> | null;
  authorizationPolicy?: TrustAuthorizationPolicy | null;
}

export type ProjectDeployKind = "compose_recreate" | "compose_build_swap" | "custom";
export type ProjectDeployRollbackStrategy = "git_previous" | "none";

/**
 * Which upload mechanism the deploy runner uses for a project's production
 * target (DUR-4068). `git_push` is today's behavior (git fetch + reset inside
 * deployTargetPath), unchanged and the default. `sftp` uploads
 * `deployPolicy.sftpAllowlist` to `deployPolicy.sftpHost` instead.
 */
export type ProjectDeployTransport = "git_push" | "sftp";

/**
 * Governs whether a production deploy for *this project's own site* needs a
 * board approval card (DUR-4068). Distinct from, and never changes, the
 * separate always-a-card rule for deploying Paperclip itself.
 *   - auto_after_review: deploy once review/security checks pass, no card.
 *   - approval_every_time: every production deploy is a request_board_approval
 *     card, like Paperclip's own deploy gate.
 *   - preview_only: never auto-deploys; every change becomes a preview link
 *     for a human to push by hand.
 * Unset means today's behavior: always a card (same as approval_every_time).
 */
export type ProjectDeployPolicyMode = "auto_after_review" | "approval_every_time" | "preview_only";

/**
 * Action categories that always route to a request_board_approval card
 * regardless of `deployPolicy.mode` (DUR-4068) — a direct implementation of
 * "ask the owner first" for specific action kinds, wired to Paperclip's
 * approval flow rather than left as a convention in a role's instructions.
 */
export type ProjectDeployAskFirstAction =
  | "delete_or_overwrite_foreign_file"
  | "live_data_write"
  | "access_policy_change"
  | "structural_change"
  | "costs_money"
  | "publish_new_public_content";

export interface ProjectDeployPolicy {
  enabled: boolean;
  requestingAgentId: string | null;
  workspaceId: string;
  deployTargetPath: string;
  deployKind: ProjectDeployKind;
  deployServices?: string[];
  deployCommand?: string;
  composeFiles?: string[];
  envFile?: string;
  healthCheckUrl: string;
  /**
   * DUR-3974: real pages that must still work after a deploy — see the
   * matching field on `deployPolicySchema` (validators/project.ts) for the
   * full rationale. The two declarations are kept in step by a compile-time
   * assertion at the bottom of that file, not by anyone remembering.
   */
  appHealthCheckPaths?: string[];
  rollback: ProjectDeployRollbackStrategy;
  /** Branch a merge must land on before it can be deployed (DUR-40). */
  deployBranch?: string;
  /** Read-only upstream mirror branch that is never deployed (DUR-40). */
  mirrorBranch?: string;
  /**
   * Command that starts a throwaway copy of the pending code so the operator
   * can look at it before approving. Runs inside a fresh checkout of the
   * branch or commit the card would ship, with PORT set for it.
   */
  previewCommand?: string;
  /** Path on the preview that answers OK once it has finished starting. */
  previewHealthPath?: string;
  /** See ProjectDeployPolicyMode. Unset = today's behavior (always a card). */
  mode?: ProjectDeployPolicyMode;
  /** Action categories that always force a board approval card (DUR-4068). */
  askFirstActions?: ProjectDeployAskFirstAction[];
  /** SFTP host, used only when the project's deployTransport is "sftp". */
  sftpHost?: string;
  /** SFTP port. Defaults to 22 when unset. */
  sftpPort?: number;
  sftpUsername?: string;
  /** Remote directory the allowlisted files are uploaded into. */
  sftpRemotePath?: string;
  /**
   * Explicit list of local (repo-relative) files the deploy runner may
   * upload over SFTP — never a wildcard/whole-tree upload (DUR-4068).
   */
  sftpAllowlist?: string[];
}

export interface IssueExecutionWorkspaceSettings {
  mode?: ExecutionWorkspaceMode;
  environmentId?: string | null;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
}

export interface ExecutionWorkspaceSummary {
  id: string;
  name: string;
  mode: Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing" | "agent_default"> | "adapter_managed" | "cloud_sandbox";
  status: ExecutionWorkspaceStatus;
  cwd: string | null;
  branchName: string | null;
  projectWorkspaceId: string | null;
  lastUsedAt: Date;
}

export interface WorkspaceOverviewLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
}

export interface WorkspaceOverviewPrimaryService {
  id: string;
  serviceName: string;
  status: WorkspaceRuntimeService["status"];
  url: string | null;
  port: number | null;
  healthStatus: WorkspaceRuntimeService["healthStatus"];
  updatedAt: Date;
}

export interface WorkspaceOverviewItem {
  key: string;
  kind: "execution_workspace";
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectUrlKey: string;
  projectName: string;
  mode: ExecutionWorkspaceSummary["mode"];
  strategyType: ExecutionWorkspaceStrategyType;
  cwd: string | null;
  branchName: string | null;
  lastUpdatedAt: Date;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string;
  executionWorkspaceStatus: ExecutionWorkspaceStatus;
  serviceCount: number;
  runningServiceCount: number;
  primaryServiceUrl: string | null;
  primaryServiceUrlRunning: boolean;
  primaryService: WorkspaceOverviewPrimaryService | null;
  hasRuntimeConfig: boolean;
  linkedIssueCount: number;
  linkedIssues: WorkspaceOverviewLinkedIssue[];
}

export interface WorkspaceOverviewResponse {
  items: WorkspaceOverviewItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface ExecutionWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing" | "agent_default"> | "adapter_managed" | "cloud_sandbox";
  strategyType: ExecutionWorkspaceStrategyType;
  name: string;
  status: ExecutionWorkspaceStatus;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: ExecutionWorkspaceProviderType;
  providerRef: string | null;
  derivedFromExecutionWorkspaceId: string | null;
  lastUsedAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  cleanupEligibleAt: Date | null;
  cleanupReason: string | null;
  config: ExecutionWorkspaceConfig | null;
  metadata: Record<string, unknown> | null;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceRuntimeService {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  configIndex?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceRealizationTransport = "local" | "ssh" | "sandbox" | "plugin";

export type WorkspaceRealizationSyncStrategy =
  | "none"
  | "ssh_git_import_export"
  | "sandbox_archive_upload_download"
  | "provider_defined";

export interface WorkspaceRealizationRequest {
  version: 1;
  adapterType: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string;
  requestedMode: string | null;
  source: {
    kind: "project_primary" | "task_session" | "agent_home";
    localPath: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    strategy: "project_primary" | "git_worktree";
    branchName: string | null;
    worktreePath: string | null;
  };
  runtimeOverlay: {
    provisionCommand: string | null;
    teardownCommand: string | null;
    cleanupCommand: string | null;
    workspaceRuntime: Record<string, unknown> | null;
  };
}

export interface WorkspaceRealizationRecord {
  version: 1;
  transport: WorkspaceRealizationTransport;
  provider: string | null;
  environmentId: string;
  leaseId: string;
  providerLeaseId: string | null;
  local: {
    path: string;
    source: WorkspaceRealizationRequest["source"]["kind"];
    strategy: WorkspaceRealizationRequest["source"]["strategy"];
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
    worktreePath: string | null;
  };
  remote: {
    path: string | null;
    host?: string | null;
    port?: number | null;
    username?: string | null;
    sandboxId?: string | null;
  };
  sync: {
    strategy: WorkspaceRealizationSyncStrategy;
    prepare: string;
    syncBack: string | null;
  };
  bootstrap: {
    command: string | null;
  };
  rebuild: {
    executionWorkspaceId: string | null;
    mode: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    localPath: string;
    remotePath: string | null;
    providerLeaseId: string | null;
    metadata: Record<string, unknown>;
  };
  summary: string;
}
