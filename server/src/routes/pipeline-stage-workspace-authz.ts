import type { Request } from "express";
import { forbidden } from "../errors.js";
import {
  assertAgentTaskWorkspaceSettingsAllowed,
  isBoardOnlyBlockedActor,
  sameValue,
} from "./workspace-command-authz.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isEmptyRecord(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && Object.keys(record).length === 0;
}

/**
 * DUR-5246: a pipeline stage's `onEnter` / `automation` settings become the
 * `executionWorkspaceSettings` of the task its routine creates, so an agent writing a stage is
 * writing a task's workspace settings. Apply the same checks as the task routes to each section.
 * A round-trip (settings, `projectId` and `routineId` all equal to the stored section) is left
 * alone. A board user is not bound by any of this.
 *
 * Settings with no explicit `projectId` are refused for an agent: at dispatch the routine's own
 * project is used, `routineId` can be any routine in the company and that routine's project can
 * be changed later, so no project policy can be checked when the stage is written. An explicit
 * `projectId` always wins at dispatch.
 */
export const STAGE_WORKSPACE_SETTINGS_NEED_PROJECT_MESSAGE =
  "Workspace settings on a pipeline stage need a project named on the same step. Only a person on the board can set them without one.";

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
    const storedSection = asRecord(stored?.[section]);
    const storedSettings = storedSection?.executionWorkspaceSettings;
    const projectId = typeof nextSection?.projectId === "string" && nextSection.projectId ? nextSection.projectId : null;
    const storedProjectId = typeof storedSection?.projectId === "string" ? storedSection.projectId : null;
    const sameProject = (projectId ?? null) === storedProjectId;
    // Only a round-trip when the project and the routine it runs are unchanged as well.
    if (sameProject && sameValue(nextSection?.routineId, storedSection?.routineId) && sameValue(incoming, storedSettings)) continue;
    if (!projectId) {
      if (isEmptyRecord(incoming)) continue;
      throw forbidden(STAGE_WORKSPACE_SETTINGS_NEED_PROJECT_MESSAGE);
    }
    const policy = await loadProjectPolicy(projectId);
    // The stored mode only excuses a mode when the project is the one it was stored under.
    assertAgentTaskWorkspaceSettingsAllowed(req, incoming, policy, sameProject ? storedSettings : undefined);
  }
}
