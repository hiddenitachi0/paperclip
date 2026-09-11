import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitHubTokenCheckReport, Project, ProjectDeployPolicy } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { environmentsApi } from "../api/environments";
import { goalsApi } from "../api/goals";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Archive, ArchiveRestore, Check, ExternalLink, Github, HelpCircle, Loader2, Plus, Trash2, X } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { ReportsToPicker } from "./ReportsToPicker";

const PROJECT_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function toDeployDraft(deployPolicy: ProjectDeployPolicy | null | undefined) {
  return {
    enabled: deployPolicy?.enabled === true,
    requestingAgentId: deployPolicy?.requestingAgentId ?? null,
    workspaceId: deployPolicy?.workspaceId ?? "",
    deployTargetPath: deployPolicy?.deployTargetPath ?? "",
    deployKind: deployPolicy?.deployKind ?? "compose_recreate",
    deployServices: deployPolicy?.deployServices ?? [],
    deployCommand: deployPolicy?.deployCommand ?? "",
    composeFiles: deployPolicy?.composeFiles ?? [],
    envFile: deployPolicy?.envFile ?? "",
    healthCheckUrl: deployPolicy?.healthCheckUrl ?? "",
    appHealthCheckPaths: deployPolicy?.appHealthCheckPaths ?? [],
    rollback: deployPolicy?.rollback ?? "git_previous",
    deployBranch: deployPolicy?.deployBranch ?? "",
    previewCommand: deployPolicy?.previewCommand ?? "",
    previewHealthPath: deployPolicy?.previewHealthPath ?? "",
    ...(deployPolicy?.mirrorBranch ? { mirrorBranch: deployPolicy.mirrorBranch } : {}),
  };
}

type DeployDraft = ReturnType<typeof toDeployDraft>;

/** What gets sent to the server: empty optional strings/lists are dropped so the strict schema stays happy. */
function toDeployPolicyPayload(draft: DeployDraft): Record<string, unknown> {
  const {
    deployCommand,
    composeFiles,
    appHealthCheckPaths,
    envFile,
    deployBranch,
    mirrorBranch,
    previewCommand,
    previewHealthPath,
    ...rest
  } = draft;
  return {
    ...rest,
    ...(deployCommand.trim() ? { deployCommand: deployCommand.trim() } : {}),
    ...(composeFiles.length > 0 ? { composeFiles } : {}),
    ...(appHealthCheckPaths.length > 0 ? { appHealthCheckPaths } : {}),
    ...(envFile.trim() ? { envFile: envFile.trim() } : {}),
    ...(deployBranch.trim() ? { deployBranch: deployBranch.trim() } : {}),
    ...(mirrorBranch ? { mirrorBranch } : {}),
    ...(previewCommand.trim() ? { previewCommand: previewCommand.trim() } : {}),
    ...(previewHealthPath.trim() ? { previewHealthPath: previewHealthPath.trim() } : {}),
  };
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void | Promise<void>;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void | Promise<void>;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  onArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";
export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "env"
  | "execution_workspace_enabled"
  | "execution_workspace_default_mode"
  | "execution_workspace_environment"
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_teardown_command"
  | "deploy_enabled"
  | "deploy_requesting_agent"
  | "deploy_workspace"
  | "deploy_kind"
  | "deploy_target_path"
  | "deploy_services"
  | "deploy_command"
  | "deploy_health_check_url"
  | "deploy_app_health_check_paths"
  | "deploy_rollback"
  | "deploy_branch"
  | "deploy_env_file"
  | "deploy_compose_files"
  | "deploy_preview_command"
  | "deploy_preview_health_path";

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return null;
}

function FieldLabel({
  label,
  state,
}: {
  label: string;
  state: ProjectFieldSaveState;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SaveIndicator state={state} />
    </div>
  );
}

function PropertyRow({
  label,
  children,
  alignStart = false,
  valueClassName = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  alignStart?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-20 mt-0.5">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap", valueClassName)}>
        {children}
      </div>
    </div>
  );
}

function ProjectStatusPicker({ status, onChange }: { status: string; onChange: (status: string) => void }) {
  const [open, setOpen] = useState(false);
  const colorClass = statusBadge[status] ?? statusBadgeDefault;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer hover:opacity-80 transition-opacity",
            colorClass,
          )}
        >
          {status.replace("_", " ")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {PROJECT_STATUSES.map((s) => (
          <Button
            key={s.value}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s.value === status && "bg-accent")}
            onClick={() => {
              onChange(s.value);
              setOpen(false);
            }}
          >
            {s.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Plain-language GitHub token guidance for a project that has a GitHub repo,
 * plus the board's "Check token" button. The scope names are GitHub's own
 * ("repo", "workflow") so the operator can find them on the token page; the
 * report never contains the token itself.
 */
function GitHubTokenGuidance({
  projectId,
  companyId,
  canCheck,
}: {
  projectId: string;
  companyId: string | null;
  canCheck: boolean;
}) {
  const check = useMutation({
    mutationFn: () => projectsApi.checkGitHubToken(projectId, companyId ?? undefined),
  });
  const report: GitHubTokenCheckReport | undefined = check.data;
  const workflowKnown = report?.hasWorkflows !== null && report?.hasWorkflows !== undefined;

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        Agents push through a GitHub token set below under <span className="font-medium">Env</span>{" "}
        (<span className="font-mono">GITHUB_TOKEN</span>). Create it with the{" "}
        <span className="font-mono">repo</span> scope so it can read and write this repo's files
        {workflowKnown && report?.hasWorkflows === false ? (
          <>. This repo has no CI files under <span className="font-mono">.github/workflows/</span>, so the{" "}
          <span className="font-mono">workflow</span> scope is not needed.</>
        ) : workflowKnown && report?.hasWorkflows === true ? (
          <>, and tick <span className="font-mono">workflow</span> too: this repo has CI files under{" "}
          <span className="font-mono">.github/workflows/</span>, and GitHub blocks every push that touches them without it.</>
        ) : (
          <>, plus <span className="font-mono">workflow</span> if the repo has CI files under{" "}
          <span className="font-mono">.github/workflows/</span> — without it GitHub blocks every push that touches them.</>
        )}
      </p>
      {canCheck ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            className="h-6 px-2"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Checking…
              </>
            ) : (
              "Check token"
            )}
          </Button>
          <span className="text-[11px] text-muted-foreground">Asks GitHub which of these the saved token has.</span>
        </div>
      ) : null}
      {check.isError ? (
        <p className="text-xs text-destructive">{errorMessage(check.error, "Could not check the token.")}</p>
      ) : null}
      {report ? (
        <div className={cn("space-y-1 rounded-md border px-2 py-1.5", report.ok ? "border-green-600/40 bg-green-500/5" : "border-amber-600/45 bg-amber-500/5")}>
          <p className="text-xs">{report.summary}</p>
          {report.tokenSource ? (
            <p className="text-[11px] text-muted-foreground">Checked {report.tokenSource}.</p>
          ) : null}
          <ul className="space-y-0.5">
            {report.scopes.map((scope) => (
              <li key={scope.scope} className="flex items-start gap-1.5 text-[11px]">
                {scope.status === "ok" ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
                ) : scope.status === "missing" ? (
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                ) : (
                  <HelpCircle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="font-mono">{scope.scope}</span>
                  {" — "}
                  <span className="text-muted-foreground">{scope.why}</span>
                  {scope.note ? <span className="block text-foreground">{scope.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ArchiveDangerZone({
  project,
  onArchive,
  archivePending,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  archivePending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? "Archive" : "Unarchive";

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? "Archive this project to hide it from the sidebar and project selectors."
          : "Unarchive this project to restore it in the sidebar and project selectors."}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? "Archiving..." : "Unarchiving..."}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {action} &ldquo;{project.name}&rdquo;?
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{action} project</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{action} project</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "repo" | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>): void | Promise<void> => {
    if (onFieldUpdate) {
      return onFieldUpdate(field, data);
    }
    return onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });
  const { data: companyAgents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const linkedGoalIds = project.goalIds.length > 0
    ? project.goalIds
    : project.goalId
      ? [project.goalId]
      : [];

  const linkedGoals = project.goals.length > 0
    ? project.goals
    : linkedGoalIds.map((id) => ({
        id,
        title: allGoals?.find((g) => g.id === id)?.title ?? id.slice(0, 8),
      }));

  const availableGoals = (allGoals ?? []).filter((g) => !linkedGoalIds.includes(g.id));
  const workspaces = project.workspaces ?? [];
  const codebase = project.codebase;
  const primaryCodebaseWorkspace = project.primaryWorkspace ?? null;
  const hasAdditionalLegacyWorkspaces = workspaces.some((workspace) => workspace.id !== primaryCodebaseWorkspace?.id);
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated_workspace" ? "isolated_workspace" : "shared_workspace";
  const executionWorkspaceEnvironmentId = executionWorkspacePolicy?.environmentId ?? "";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
    type: "git_worktree",
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };
  const runSelectableEnvironments = (environments ?? []).filter((environment) => {
    if (environment.driver === "local" || environment.driver === "ssh") return true;
    if (environment.driver !== "sandbox") return false;
    const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
    return provider !== null && provider !== "fake";
  });
  const showExecutionWorkspaceEnvironmentControl = environmentsEnabled && runSelectableEnvironments.length > 1;

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (project.urlKey !== project.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeGoal = (goalId: string) => {
    if (!onUpdate && !onFieldUpdate) return;
    commitField("goals", { goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  const addGoal = (goalId: string) => {
    if ((!onUpdate && !onFieldUpdate) || linkedGoalIds.includes(goalId)) return;
    commitField("goals", { goalIds: [...linkedGoalIds, goalId] });
    setGoalOpen(false);
  };

  const updateExecutionWorkspacePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate && !onFieldUpdate) return;
    return {
      executionWorkspacePolicy: {
        enabled: executionWorkspacesEnabled,
        defaultMode: executionWorkspaceDefaultMode,
        allowIssueOverride: executionWorkspacePolicy?.allowIssueOverride ?? true,
        ...executionWorkspacePolicy,
        ...patch,
      },
    };
  };

  // deployPolicySchema requires workspaceId/deployTargetPath/healthCheckUrl together
  // (not optional), unlike executionWorkspacePolicy's fields which each save independently.
  // A local draft lets edits across fields accumulate before all required fields are
  // filled, since no single field's commit can satisfy the schema on its own otherwise.
  const [deployDraft, setDeployDraft] = useState(() => toDeployDraft(project.deployPolicy));
  const [deployFormOpen, setDeployFormOpen] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  useEffect(() => {
    setDeployDraft(toDeployDraft(project.deployPolicy));
    setDeployFormOpen(false);
    setDeployError(null);
  }, [project.id]);

  /**
   * Save one deploy field. The whole draft goes to the server each time (the
   * schema wants the full object); the server answers with a plain-language
   * message when the settings are incomplete or inconsistent, which is shown
   * under the section. Switching deploys ON is the one change that is rolled
   * back locally on failure, so the toggle never claims something the server
   * refused.
   */
  const commitDeployField = (field: ProjectConfigFieldKey, patch: Partial<DeployDraft>) => {
    if (!onUpdate && !onFieldUpdate) return;
    const next = { ...deployDraft, ...patch };
    setDeployDraft(next);
    setDeployError(null);
    Promise.resolve(commitField(field, { deployPolicy: toDeployPolicyPayload(next) })).catch((error: unknown) => {
      setDeployError(errorMessage(error, "Could not save the deploy settings."));
      if (patch.enabled === true) {
        setDeployDraft((current) => ({ ...current, enabled: false }));
        setDeployFormOpen(true);
      }
    });
  };
  const showDeployForm = deployDraft.enabled || deployFormOpen;

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const looksLikeRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const isSafeExternalUrl = (value: string | null | undefined) => {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const formatRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2) return parsed.host;
      const owner = segments[0];
      const repo = segments[1]?.replace(/\.git$/i, "");
      if (!owner || !repo) return parsed.host;
      return `${parsed.host}/${owner}/${repo}`;
    } catch {
      return value;
    }
  };

  const deriveSourceType = (cwd: string | null, repoUrl: string | null) => {
    if (repoUrl) return "git_repo";
    if (cwd) return "local_path";
    return undefined;
  };

  const persistCodebase = (patch: { cwd?: string | null; repoUrl?: string | null }) => {
    const nextCwd = patch.cwd !== undefined ? patch.cwd : codebase.localFolder;
    const nextRepoUrl = patch.repoUrl !== undefined ? patch.repoUrl : codebase.repoUrl;
    if (!nextCwd && !nextRepoUrl) {
      if (primaryCodebaseWorkspace) {
        removeWorkspace.mutate(primaryCodebaseWorkspace.id);
      }
      return;
    }

    const data: Record<string, unknown> = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(deriveSourceType(nextCwd, nextRepoUrl) ? { sourceType: deriveSourceType(nextCwd, nextRepoUrl) } : {}),
      isPrimary: true,
    };

    if (primaryCodebaseWorkspace) {
      updateWorkspace.mutate({ workspaceId: primaryCodebaseWorkspace.id, data });
      return;
    }

    createWorkspace.mutate(data);
  };

  const submitLocalWorkspace = () => {
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      setWorkspaceError(null);
      persistCodebase({ cwd: null });
      return;
    }
    if (!isAbsolutePath(cwd)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ cwd });
  };

  const submitRepoWorkspace = () => {
    const repoUrl = workspaceRepoUrl.trim();
    if (!repoUrl) {
      setWorkspaceError(null);
      persistCodebase({ repoUrl: null });
      return;
    }
    if (!looksLikeRepoUrl(repoUrl)) {
      setWorkspaceError("Repo must use a valid GitHub or GitHub Enterprise repo URL.");
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ repoUrl });
  };

  const clearLocalWorkspace = () => {
    const confirmed = window.confirm(
      codebase.repoUrl
        ? "Clear local folder from this workspace?"
        : "Delete this workspace local folder?",
    );
    if (!confirmed) return;
    persistCodebase({ cwd: null });
  };

  const clearRepoWorkspace = () => {
    const hasLocalFolder = Boolean(codebase.localFolder);
    const confirmed = window.confirm(
      hasLocalFolder
        ? "Clear repo from this workspace?"
        : "Delete this workspace repo?",
    );
    if (!confirmed) return;
    if (primaryCodebaseWorkspace && hasLocalFolder) {
      updateWorkspace.mutate({
        workspaceId: primaryCodebaseWorkspace.id,
        data: { repoUrl: null, repoRef: null, defaultRef: null, sourceType: deriveSourceType(codebase.localFolder, null) },
      });
      return;
    }
    persistCodebase({ repoUrl: null });
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label="Name" state={fieldState("name")} />}>
          {onUpdate || onFieldUpdate ? (
            <DraftInput
              value={project.name}
              onCommit={(name) => commitField("name", { name })}
              immediate
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
              placeholder="Project name"
            />
          ) : (
            <span className="text-sm">{project.name}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label="Description" state={fieldState("description")} />}
          alignStart
          valueClassName="space-y-0.5"
        >
          {onUpdate || onFieldUpdate ? (
            <InlineEditor
              value={project.description ?? ""}
              onSave={(description) => commitField("description", { description })}
              nullable
              as="p"
              className="text-sm text-muted-foreground"
              placeholder="Add a description..."
              multiline
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.description?.trim() || "No description"}
            </p>
          )}
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Status" state={fieldState("status")} />}>
          {onUpdate || onFieldUpdate ? (
            <ProjectStatusPicker
              status={project.status}
              onChange={(status) => commitField("status", { status })}
            />
          ) : (
            <StatusBadge status={project.status} />
          )}
        </PropertyRow>
        {project.leadAgentId && (
          <PropertyRow label="Lead">
            <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
          </PropertyRow>
        )}
        <PropertyRow
          label={<FieldLabel label="Goals" state={fieldState("goals")} />}
          alignStart
          valueClassName="space-y-2"
        >
          {linkedGoals.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {linkedGoals.map((goal) => (
                <span
                  key={goal.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                >
                  <Link to={`/goals/${goal.id}`} className="hover:underline break-words min-w-0">
                    {goal.title}
                  </Link>
                  {(onUpdate || onFieldUpdate) && (
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      type="button"
                      onClick={() => removeGoal(goal.id)}
                      aria-label={`Remove goal ${goal.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {(onUpdate || onFieldUpdate) && (
            <Popover open={goalOpen} onOpenChange={setGoalOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  className={cn("h-6 w-fit px-2", linkedGoals.length > 0 && "ml-1")}
                  disabled={availableGoals.length === 0}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Goal
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start">
                {availableGoals.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    All goals linked.
                  </div>
                ) : (
                  availableGoals.map((goal) => (
                    <button
                      key={goal.id}
                      className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => addGoal(goal.id)}
                    >
                      {goal.title}
                    </button>
                  ))
                )}
              </PopoverContent>
            </Popover>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label="Env" state={fieldState("env")} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvironmentVariablesEditor
              value={project.env ?? {}}
              secrets={availableSecrets}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />
            <p className="text-[11px] text-muted-foreground">
              Applied to all runs for tasks in this project. Project values override agent env on key conflicts.
            </p>
          </div>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Created" state="idle" />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Updated" state="idle" />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label="Target Date" state="idle" />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator className="my-4" />

      <div className="space-y-1 py-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Codebase</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label="Codebase help"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Repo identifies the source of truth. Local folder is the default place agents write code.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Repo</div>
              {codebase.repoUrl ? (
                <div className="flex items-center justify-between gap-2">
                  {isSafeExternalUrl(codebase.repoUrl) ? (
                    <a
                      href={codebase.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{formatRepoUrl(codebase.repoUrl)}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{codebase.repoUrl}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      onClick={() => {
                        setWorkspaceMode("repo");
                        setWorkspaceRepoUrl(codebase.repoUrl ?? "");
                        setWorkspaceError(null);
                      }}
                    >
                      Change repo
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearRepoWorkspace}
                      aria-label="Clear repo"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">Not set.</div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    onClick={() => {
                      setWorkspaceMode("repo");
                      setWorkspaceRepoUrl(codebase.repoUrl ?? "");
                      setWorkspaceError(null);
                    }}
                  >
                    Set repo
                  </Button>
                </div>
              )}
              {codebase.repoUrl && (
                <GitHubTokenGuidance
                  projectId={project.id}
                  companyId={selectedCompanyId ?? null}
                  canCheck={Boolean(onUpdate || onFieldUpdate)}
                />
              )}
            </div>

            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Local folder</div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                    {codebase.effectiveLocalFolder}
                  </div>
                  {codebase.origin === "managed_checkout" && (
                    <div className="text-[11px] text-muted-foreground">Paperclip-managed folder.</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    onClick={() => {
                      setWorkspaceMode("local");
                      setWorkspaceCwd(codebase.localFolder ?? "");
                      setWorkspaceError(null);
                    }}
                  >
                    {codebase.localFolder ? "Change local folder" : "Set local folder"}
                  </Button>
                  {codebase.localFolder ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearLocalWorkspace}
                      aria-label="Clear local folder"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            {hasAdditionalLegacyWorkspaces && (
              <div className="text-[11px] text-muted-foreground">
                Additional legacy workspace records exist on this project. Paperclip is using the primary workspace as the codebase view.
              </div>
            )}

            {primaryCodebaseWorkspace?.runtimeServices && primaryCodebaseWorkspace.runtimeServices.length > 0 ? (
              <div className="space-y-1">
                {primaryCodebaseWorkspace.runtimeServices.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium">{service.serviceName}</span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                            service.status === "running"
                              ? "bg-green-500/15 text-green-700 dark:text-green-300"
                              : service.status === "failed"
                                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {service.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {service.url ? (
                          <a
                            href={service.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-foreground hover:underline"
                          >
                            {service.url}
                          </a>
                        ) : (
                          service.command ?? "No URL"
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {service.lifecycle}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {workspaceMode === "local" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                  value={workspaceCwd}
                  onChange={(e) => setWorkspaceCwd(e.target.value)}
                  placeholder="/absolute/path/to/workspace"
                />
                <ChoosePathButton />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!workspaceCwd.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitLocalWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceCwd("");
                    setWorkspaceError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {workspaceMode === "repo" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                value={workspaceRepoUrl}
                onChange={(e) => setWorkspaceRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!workspaceRepoUrl.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitRepoWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceRepoUrl("");
                    setWorkspaceError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to save workspace.</p>
          )}
          {removeWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to delete workspace.</p>
          )}
          {updateWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to update workspace.</p>
          )}
        </div>

        {isolatedWorkspacesEnabled ? (
          <>
            <Separator className="my-4" />

            <div className="py-1.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Execution Workspaces</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                      aria-label="Execution workspaces help"
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Project-owned defaults for isolated task checkouts and execution workspace behavior.
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>Enable isolated task checkouts</span>
                      <SaveIndicator state={fieldState("execution_workspace_enabled")} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Let tasks choose between the project's primary checkout and an isolated execution workspace.
                    </div>
                  </div>
                  {onUpdate || onFieldUpdate ? (
                    <ToggleSwitch
                      checked={executionWorkspacesEnabled}
                      onCheckedChange={() =>
                        commitField(
                          "execution_workspace_enabled",
                          updateExecutionWorkspacePolicy({ enabled: !executionWorkspacesEnabled })!,
                        )}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {executionWorkspacesEnabled ? "Enabled" : "Disabled"}
                    </span>
                  )}
                </div>

                {executionWorkspacesEnabled ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span>New tasks default to isolated checkout</span>
                          <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          If disabled, new tasks stay on the project's primary checkout unless someone opts in.
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={executionWorkspaceDefaultMode === "isolated_workspace"}
                        onCheckedChange={() =>
                          commitField(
                            "execution_workspace_default_mode",
                            updateExecutionWorkspacePolicy({
                              defaultMode:
                                executionWorkspaceDefaultMode === "isolated_workspace"
                                  ? "shared_workspace"
                                  : "isolated_workspace",
                            })!,
                          )}
                      />
                    </div>

                    <div className="border-t border-border/60 pt-2">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                      >
                        {executionWorkspaceAdvancedOpen
                          ? "Hide advanced checkout settings"
                          : "Show advanced checkout settings"}
                      </button>
                    </div>

                    {executionWorkspaceAdvancedOpen ? (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">
                          Host-managed implementation: <span className="text-foreground">Git worktree</span>
                        </div>
                        {showExecutionWorkspaceEnvironmentControl ? (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5">
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>Environment</span>
                                <SaveIndicator state={fieldState("execution_workspace_environment")} />
                              </label>
                            </div>
                            <select
                              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                              value={executionWorkspaceEnvironmentId}
                              onChange={(e) =>
                                commitField(
                                  "execution_workspace_environment",
                                  updateExecutionWorkspacePolicy({
                                    environmentId: e.target.value || null,
                                  })!,
                                )}
                            >
                              <option value="">No environment</option>
                              {runSelectableEnvironments.map((environment) => (
                                <option key={environment.id} value={environment.id}>
                                  {environment.name} · {environment.driver}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Base ref</span>
                              <SaveIndicator state={fieldState("execution_workspace_base_ref")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.baseRef ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_base_ref", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    baseRef: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="origin/main"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Branch template</span>
                              <SaveIndicator state={fieldState("execution_workspace_branch_template")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.branchTemplate ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_branch_template", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    branchTemplate: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="{{issue.identifier}}-{{slug}}"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Worktree parent dir</span>
                              <SaveIndicator state={fieldState("execution_workspace_worktree_parent_dir")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.worktreeParentDir ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_worktree_parent_dir", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    worktreeParentDir: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder=".paperclip/worktrees"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Provision command</span>
                              <SaveIndicator state={fieldState("execution_workspace_provision_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.provisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_provision_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    provisionCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/provision-worktree.sh"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Teardown command</span>
                              <SaveIndicator state={fieldState("execution_workspace_teardown_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.teardownCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_teardown_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    teardownCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/teardown-worktree.sh"
                          />
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Provision runs inside the derived worktree before agent execution. Teardown is stored here for
                          future cleanup flows.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        <Separator className="my-4" />

        <div className="py-1.5 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Deployment</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label="Deployment help"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                When this is on, the chosen agent can ask you to deploy a merged change. You approve it on the board, and
                the deploy runner on the server fetches the code, restarts the app and checks that it answers. Nothing is
                deployed without your approval.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>Agents can request deploys of this project</span>
                  <SaveIndicator state={fieldState("deploy_enabled")} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {deployDraft.enabled
                    ? "On. Deploy requests show up as cards for you to approve."
                    : "Off. Fill in the settings below first, then switch this on."}
                </div>
              </div>
              {onUpdate || onFieldUpdate ? (
                <ToggleSwitch
                  checked={deployDraft.enabled}
                  onCheckedChange={() => commitDeployField("deploy_enabled", { enabled: !deployDraft.enabled })}
                />
              ) : (
                <span className="text-xs text-muted-foreground">
                  {deployDraft.enabled ? "Enabled" : "Disabled"}
                </span>
              )}
            </div>

            {!deployDraft.enabled && (onUpdate || onFieldUpdate) ? (
              <button
                type="button"
                className="flex items-center gap-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setDeployFormOpen((open) => !open)}
              >
                {deployFormOpen ? "Hide deployment settings" : "Set up deployment"}
              </button>
            ) : null}

            {deployError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                {deployError}
              </p>
            ) : null}

            {showDeployForm ? (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Agent that requests deploys</span>
                      <SaveIndicator state={fieldState("deploy_requesting_agent")} />
                    </label>
                  </div>
                  <ReportsToPicker
                    agents={companyAgents}
                    value={deployDraft.requestingAgentId}
                    onChange={(id) => commitDeployField("deploy_requesting_agent", { requestingAgentId: id })}
                    chooseLabel="Choose an agent..."
                    disabledEmptyLabel="No agent chosen"
                    selectedLabel={(name) => name}
                    clearLabel="No agent"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    The agent that files a deploy request once a change has been merged. Usually the project lead.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Deploy from workspace</span>
                      <SaveIndicator state={fieldState("deploy_workspace")} />
                    </label>
                  </div>
                  <select
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                    value={deployDraft.workspaceId}
                    onChange={(e) => commitDeployField("deploy_workspace", { workspaceId: e.target.value })}
                  >
                    <option value="">Choose a workspace</option>
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                        {workspace.id === primaryCodebaseWorkspace?.id ? " (primary)" : ""}
                        {!workspace.repoUrl ? " (no repo)" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    The workspace whose repo the runner fetches the code from. It must have a repo set.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Deploy branch</span>
                      <SaveIndicator state={fieldState("deploy_branch")} />
                    </label>
                  </div>
                  <DraftInput
                    value={deployDraft.deployBranch}
                    onCommit={(value) => commitDeployField("deploy_branch", { deployBranch: value })}
                    immediate
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                    placeholder="main"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Only changes merged into this branch can be deployed. Leave empty to allow any branch.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>How to deploy</span>
                      <SaveIndicator state={fieldState("deploy_kind")} />
                    </label>
                  </div>
                  <select
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                    value={deployDraft.deployKind}
                    onChange={(e) =>
                      commitDeployField("deploy_kind", { deployKind: e.target.value as DeployDraft["deployKind"] })}
                  >
                    <option value="compose_recreate">Docker Compose: restart the containers with the new code</option>
                    <option value="compose_build_swap">Docker Compose: build the new version first, then swap it in</option>
                    <option value="custom">Run a custom command</option>
                  </select>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Folder on the server</span>
                      <SaveIndicator state={fieldState("deploy_target_path")} />
                    </label>
                  </div>
                  <DraftInput
                    value={deployDraft.deployTargetPath}
                    onCommit={(value) => commitDeployField("deploy_target_path", { deployTargetPath: value })}
                    immediate
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                    placeholder="/root/my-project"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Where the project is checked out on the server that runs it. Must be a full path starting with /.
                  </p>
                </div>

                {deployDraft.deployKind === "custom" ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Command to run</span>
                        <SaveIndicator state={fieldState("deploy_command")} />
                      </label>
                    </div>
                    <DraftInput
                      value={deployDraft.deployCommand}
                      onCommit={(value) => commitDeployField("deploy_command", { deployCommand: value })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="bash ./scripts/deploy.sh"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">Run inside the folder above after the new code is fetched.</p>
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Services to restart (comma-separated)</span>
                          <SaveIndicator state={fieldState("deploy_services")} />
                        </label>
                      </div>
                      <DraftInput
                        value={deployDraft.deployServices.join(", ")}
                        onCommit={(value) => commitDeployField("deploy_services", { deployServices: splitCommaList(value) })}
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="web, worker"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        The service names from the Compose file. Leave empty to restart all of them.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Environment file (optional)</span>
                          <SaveIndicator state={fieldState("deploy_env_file")} />
                        </label>
                      </div>
                      <DraftInput
                        value={deployDraft.envFile}
                        onCommit={(value) => commitDeployField("deploy_env_file", { envFile: value })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder=".env"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Passed to Docker Compose as its env file. A path inside the project folder.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Compose files (optional, comma-separated)</span>
                          <SaveIndicator state={fieldState("deploy_compose_files")} />
                        </label>
                      </div>
                      <DraftInput
                        value={deployDraft.composeFiles.join(", ")}
                        onCommit={(value) => commitDeployField("deploy_compose_files", { composeFiles: splitCommaList(value) })}
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="docker/docker-compose.yml, docker/docker-compose.prod.yml"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Only needed when the Compose file is not the docker-compose.yml at the top of the project folder.
                      </p>
                    </div>
                  </>
                )}

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Health check</span>
                      <SaveIndicator state={fieldState("deploy_health_check_url")} />
                    </label>
                  </div>
                  <DraftInput
                    value={deployDraft.healthCheckUrl}
                    onCommit={(value) => commitDeployField("deploy_health_check_url", { healthCheckUrl: value })}
                    immediate
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                    placeholder="https://example.com/api/health"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    A web address the runner opens after each deploy. If it does not answer OK, the deploy is treated as failed.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Pages that must still work (comma-separated)</span>
                      <SaveIndicator state={fieldState("deploy_app_health_check_paths")} />
                    </label>
                  </div>
                  <DraftInput
                    value={deployDraft.appHealthCheckPaths.join(", ")}
                    onCommit={(value) =>
                      commitDeployField("deploy_app_health_check_paths", { appHealthCheckPaths: splitCommaList(value) })
                    }
                    className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                    placeholder="/, /dashboard, /reports"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Real pages of the app, not a status endpoint. Before each deploy the runner notes how they answer
                    today; after the deploy it opens them again, and only undoes the deploy if a page that worked before
                    is now broken. A page that was already broken, needs a login, or does not exist cannot fail a deploy.
                    Leave this empty and the runner can only check the front page.
                  </p>
                </div>

                <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
                  <div className="space-y-0.5">
                    <div className="text-sm">Let me try it before I approve</div>
                    <div className="text-[11px] text-muted-foreground">
                      Optional. With a start command here, every merge and deploy card gets a
                      &ldquo;Preview this before approving&rdquo; button that runs a throwaway copy of the pending
                      code so you can click around first. The copy shuts itself down when you decide the card.
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>How to start a preview</span>
                        <SaveIndicator state={fieldState("deploy_preview_command")} />
                      </label>
                    </div>
                    <DraftInput
                      value={deployDraft.previewCommand}
                      onCommit={(value) => commitDeployField("deploy_preview_command", { previewCommand: value })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="pnpm install && pnpm start"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Runs inside a fresh copy of the code the card would ship. Paperclip picks a free port and
                      passes it as PORT — the command must listen on that.
                    </p>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Page that says it is ready (optional)</span>
                        <SaveIndicator state={fieldState("deploy_preview_health_path")} />
                      </label>
                    </div>
                    <DraftInput
                      value={deployDraft.previewHealthPath}
                      onCommit={(value) =>
                        commitDeployField("deploy_preview_health_path", { previewHealthPath: value })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="/"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Paperclip waits for this page to answer before it gives you the link. Leave empty to use the
                      front page.
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm">
                      <span>Roll back automatically if the health check fails</span>
                      <SaveIndicator state={fieldState("deploy_rollback")} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {deployDraft.rollback === "git_previous"
                        ? "The runner puts the previous version back and tells you what happened."
                        : "Off: a failed deploy stays as it is until someone fixes it."}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={deployDraft.rollback === "git_previous"}
                    onCheckedChange={() =>
                      commitDeployField("deploy_rollback", {
                        rollback: deployDraft.rollback === "git_previous" ? "none" : "git_previous",
                      })}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

      </div>

      {onArchive && (
        <>
          <Separator className="my-4" />
          <div className="space-y-4 py-4">
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">
              Danger Zone
            </div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
            />
          </div>
        </>
      )}
    </div>
  );
}
