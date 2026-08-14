import type { ProjectDeployKind, ProjectDeployPolicy, ProjectDeployRollbackStrategy } from "@paperclipai/shared";
import { asString, asStringArray, parseObject } from "../adapters/utils.js";

function isDeployKind(value: unknown): value is ProjectDeployKind {
  return value === "compose_recreate" || value === "compose_build_swap" || value === "custom";
}

function isDeployRollbackStrategy(value: unknown): value is ProjectDeployRollbackStrategy {
  return value === "git_previous" || value === "none";
}

export function parseProjectDeployPolicy(raw: unknown): ProjectDeployPolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const requestingAgentId = typeof parsed.requestingAgentId === "string" ? parsed.requestingAgentId : null;
  return {
    enabled,
    requestingAgentId,
    workspaceId: asString(parsed.workspaceId, ""),
    deployTargetPath: asString(parsed.deployTargetPath, ""),
    deployKind: isDeployKind(parsed.deployKind) ? parsed.deployKind : "custom",
    ...(Array.isArray(parsed.deployServices) ? { deployServices: asStringArray(parsed.deployServices) } : {}),
    ...(typeof parsed.deployCommand === "string" ? { deployCommand: parsed.deployCommand } : {}),
    ...(Array.isArray(parsed.composeFiles) ? { composeFiles: asStringArray(parsed.composeFiles) } : {}),
    ...(typeof parsed.envFile === "string" ? { envFile: parsed.envFile } : {}),
    healthCheckUrl: asString(parsed.healthCheckUrl, ""),
    rollback: isDeployRollbackStrategy(parsed.rollback) ? parsed.rollback : "none",
  };
}
