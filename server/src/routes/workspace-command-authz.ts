import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
}

/**
 * The deploy policy carries two commands the box runs as itself: the one that
 * starts a preview copy and the one that deploys. They are host commands like
 * any other, so an agent key must not be able to set or change them from a
 * project write.
 *
 * DUR-4106: the SFTP transport fields carry the same (arguably higher) risk
 * as those commands — the box authenticates to `sftpHost`/`sftpUsername` with
 * whichever real credential is bound to `requestingAgentId`, so an agent key
 * that could set any of these could redirect that credential to a host it
 * chooses and have it exfiltrated on the runner's next tick. Same board-only
 * bar as the credential bind/unbind routes themselves.
 */
export function collectDeployPolicyCommandPaths(deployPolicy: unknown): string[] {
  if (!isRecord(deployPolicy)) return [];
  const paths: string[] = [];
  if (hasOwn(deployPolicy, "previewCommand")) {
    paths.push("deployPolicy.previewCommand");
  }
  if (hasOwn(deployPolicy, "deployCommand")) {
    paths.push("deployPolicy.deployCommand");
  }
  if (hasOwn(deployPolicy, "requestingAgentId")) {
    paths.push("deployPolicy.requestingAgentId");
  }
  if (hasOwn(deployPolicy, "sftpHost")) {
    paths.push("deployPolicy.sftpHost");
  }
  if (hasOwn(deployPolicy, "sftpPort")) {
    paths.push("deployPolicy.sftpPort");
  }
  if (hasOwn(deployPolicy, "sftpUsername")) {
    paths.push("deployPolicy.sftpUsername");
  }
  if (hasOwn(deployPolicy, "sftpRemotePath")) {
    paths.push("deployPolicy.sftpRemotePath");
  }
  if (hasOwn(deployPolicy, "sftpAllowlist")) {
    paths.push("deployPolicy.sftpAllowlist");
  }
  return paths;
}

/**
 * DUR-4106: `deployTransport` lives on the project record itself, not inside
 * `deployPolicy`, but deciding "sftp" is exactly as host-trusted as any of
 * the deployPolicy fields above -- it is what makes the runner call
 * upload_via_sftp with a real bound credential instead of running a recipe.
 */
export function collectProjectDeployTransportCommandPaths(body: unknown): string[] {
  if (!isRecord(body)) return [];
  return hasOwn(body, "deployTransport") ? ["deployTransport"] : [];
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  return hasOwn(workspacePatch, "cleanupCommand")
    ? [prefixPath(prefix, "cleanupCommand")]
    : [];
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}
