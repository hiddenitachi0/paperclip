import type { AdapterModel } from "../../api/agents";
import { getThinkingEffortKey, getThinkingEffortOptions, type Issue, type Project } from "@paperclipai/shared";
import { extractProviderIdWithFallback } from "../../lib/model-utils";
import type { IssueModelLane } from "../../lib/issue-assignee-overrides";

export function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

export function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
}

function primaryWorkspaceIdForProject(project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined) {
  return project?.primaryWorkspace?.id
    ?? project?.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project?.workspaces[0]?.id
    ?? null;
}

export function isMainIssueWorkspace(input: {
  issue: Pick<Issue, "projectWorkspaceId" | "currentExecutionWorkspace">;
  project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined;
}) {
  const workspace = input.issue.currentExecutionWorkspace ?? null;
  const primaryWorkspaceId = primaryWorkspaceIdForProject(input.project);
  const linkedProjectWorkspaceId = workspace?.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  if (workspace) {
    if (workspace.mode !== "shared_workspace") return false;
    if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
    return workspace.mode === "shared_workspace" && linkedProjectWorkspaceId === primaryWorkspaceId;
  }
  if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
  return linkedProjectWorkspaceId === primaryWorkspaceId;
}

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function centsToDollarsInputValue(cents: number | null | undefined) {
  if (cents == null) return "";
  return (cents / 100).toString();
}

export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export function parsePositiveInt(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

/** Task-override effort choices: the shared per-adapter level list, with "" meaning the agent's own setting. */
export function thinkingEffortOptionsFor(adapterType: string | null | undefined) {
  return getThinkingEffortOptions(adapterType, undefined, { autoLabel: "Default" });
}

export function thinkingEffortKeyFor(adapterType: string | null | undefined) {
  return getThinkingEffortKey(adapterType);
}

export function thinkingEffortValueFor(adapterType: string | null | undefined, adapterConfig: Record<string, unknown>) {
  if (adapterType === "codex_local") {
    return String(adapterConfig.modelReasoningEffort ?? adapterConfig.reasoningEffort ?? adapterConfig.effort ?? "");
  }
  if (adapterType === "opencode_local") {
    return String(adapterConfig.variant ?? "");
  }
  return String(adapterConfig.effort ?? "");
}

export function overrideLane(overrides: Issue["assigneeAdapterOverrides"]): IssueModelLane {
  if (overrides?.modelProfile === "cheap") return "cheap";
  if (overrides?.adapterConfig) return "custom";
  return "primary";
}

export function sortAdapterModels(models: AdapterModel[]) {
  return [...models].sort((a, b) => {
    const providerA = extractProviderIdWithFallback(a.id);
    const providerB = extractProviderIdWithFallback(b.id);
    const byProvider = providerA.localeCompare(providerB);
    if (byProvider !== 0) return byProvider;
    return a.id.localeCompare(b.id);
  });
}
