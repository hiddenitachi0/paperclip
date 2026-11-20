import type { Request } from "express";
import {
  assertAgentTaskWorkspaceSettingsAllowed,
  isBoardOnlyBlockedActor,
  sameValue,
} from "./workspace-command-authz.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * DUR-5246: a pipeline stage's `onEnter` / `automation` settings become the
 * `executionWorkspaceSettings` of the task its routine creates, so an agent writing a stage is
 * writing a task's workspace settings. Apply the same checks as the task routes to each section.
 * A value equal to the one already stored is a round-trip and is left alone. A board user is
 * not bound by any of this.
 */
export async function assertAgentStageConfigWorkspaceSettingsAllowed(
  req: Request,
  config: unknown,
  storedConfig: unknown,
  loadProjectPolicy: (projectId: string) => Promise<unknown>,
) {
  if (!isBoardOnlyBlockedActor(req)) return;
  const next = asRecord(config);
  if (!next) return;
  const stored = asRecord(storedConfig);
  for (const section of ["onEnter", "automation"] as const) {
    const nextSection = asRecord(next[section]);
    const incoming = nextSection?.executionWorkspaceSettings;
    if (incoming === undefined || incoming === null) continue;
    const storedSettings = asRecord(stored?.[section])?.executionWorkspaceSettings;
    if (sameValue(incoming, storedSettings)) continue;
    const projectId = typeof nextSection?.projectId === "string" ? nextSection.projectId : null;
    const policy = projectId ? await loadProjectPolicy(projectId) : null;
    assertAgentTaskWorkspaceSettingsAllowed(req, incoming, policy, storedSettings);
  }
}
