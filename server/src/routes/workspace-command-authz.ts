import type { Request } from "express";
import { PROJECT_WORKSPACE_TEST_COMMAND_KEY } from "@paperclipai/shared";
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
  const paths = collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
  // workspaceRuntime.services[].command runs on the host with the running
  // agent's environment, so it is board-only like the commands above.
  if (hasOwn(policy, "workspaceRuntime")) {
    paths.push("executionWorkspacePolicy.workspaceRuntime");
  }
  // requireIsolation is the operator's safety setting: an agent must not be
  // able to switch it off and put the project's runs back on the shared checkout.
  if (hasOwn(policy, "requireIsolation")) {
    paths.push("executionWorkspacePolicy.requireIsolation");
  }
  return paths;
}

/**
 * DUR-5231: a project PATCH replaces the whole `executionWorkspacePolicy`, so an
 * agent that leaves a board-set protected field out (or sends `null`, or
 * `{ enabled: false }`) wipes it without ever naming it. Compare the new policy
 * to the stored one and list every protected field (workspaceRuntime and the
 * strategy commands) the write would change or drop. `null` counts as touching all of them. Only call this when the body
 * actually contains `executionWorkspacePolicy`.
 */
export function collectProjectExecutionWorkspacePolicyDropPaths(
  nextPolicy: unknown,
  storedPolicy: unknown,
): string[] {
  if (!isRecord(storedPolicy)) return [];
  const next = isRecord(nextPolicy) ? nextPolicy : null;
  const storedStrategy = isRecord(storedPolicy.workspaceStrategy) ? storedPolicy.workspaceStrategy : null;
  const nextStrategy = next && isRecord(next.workspaceStrategy) ? next.workspaceStrategy : null;
  const paths: string[] = [];
  const check = (path: string, stored: unknown, incoming: unknown) => {
    if (stored === undefined || stored === null) return;
    if (!sameValue(stored, incoming)) paths.push(path);
  };
  check("executionWorkspacePolicy.workspaceRuntime", storedPolicy.workspaceRuntime, next?.workspaceRuntime);
  // requireIsolation is deliberately not checked here: the project PATCH route carries the
  // stored `true` forward for agent writes (DUR-5184), so omitting it cannot drop it, and an
  // explicit change is already refused by collectProjectExecutionWorkspaceCommandPaths.
  check(
    "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
    storedStrategy?.provisionCommand,
    nextStrategy?.provisionCommand,
  );
  check(
    "executionWorkspacePolicy.workspaceStrategy.teardownCommand",
    storedStrategy?.teardownCommand,
    nextStrategy?.teardownCommand,
  );
  return paths;
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
 *
 * DUR-4139: `mode` and `askFirstActions` decide whether a deploy needs a
 * request_board_approval card at all (see deploy-policy-enforcement.ts) --
 * an agent key that could set either of these on its own project could
 * switch itself to `auto_after_review` and clear the ask-first list in the
 * same write that requests the deploy, defeating the whole point of the
 * policy. Same board-only bar as the fields above.
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
  if (hasOwn(deployPolicy, "sftpExclude")) {
    paths.push("deployPolicy.sftpExclude");
  }
  if (hasOwn(deployPolicy, "sftpHostKeySha256")) {
    paths.push("deployPolicy.sftpHostKeySha256");
  }
  if (hasOwn(deployPolicy, "mode")) {
    paths.push("deployPolicy.mode");
  }
  if (hasOwn(deployPolicy, "askFirstActions")) {
    paths.push("deployPolicy.askFirstActions");
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
  options: { includeMetadataTestCommand?: boolean } = {},
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths: string[] = [];
  if (hasOwn(workspacePatch, "cleanupCommand")) paths.push(prefixPath(prefix, "cleanupCommand"));
  // "Test command (run before review)": the server runs it on the host, so an agent key
  // may not set it, change it, or write it through the free-form metadata object.
  if (hasOwn(workspacePatch, PROJECT_WORKSPACE_TEST_COMMAND_KEY)) {
    paths.push(prefixPath(prefix, PROJECT_WORKSPACE_TEST_COMMAND_KEY));
  }
  // A PATCH of an existing workspace passes includeMetadataTestCommand: false: the board-only
  // code-location check compares against the stored value, so resending it unchanged is allowed.
  if (
    options.includeMetadataTestCommand !== false
    && isRecord(workspacePatch.metadata)
    && hasOwn(workspacePatch.metadata, PROJECT_WORKSPACE_TEST_COMMAND_KEY)
  ) {
    paths.push(prefixPath(prefix, `metadata.${PROJECT_WORKSPACE_TEST_COMMAND_KEY}`));
  }
  return paths;
}

/**
 * DUR-5208: where a project's code lives and how it is built decides whether a
 * task counts as a code task (done-gate with evidence, pre-review test loop),
 * which branch the "commit is on the project's branch" check compares against,
 * and which ref the deploy runner reads. An agent that could rewrite these
 * could switch those controls off for its own work, so only a board user may
 * create or delete a project workspace or change any of the fields below.
 */
export const PROJECT_CODE_LOCATION_BOARD_ONLY_MESSAGE =
  "Only a person on the board can change where this project's code lives or how it is built.";

const PROJECT_WORKSPACE_CODE_LOCATION_FIELDS = [
  "repoUrl",
  "repoRef",
  "defaultRef",
  "isPrimary",
  "setupCommand",
  "cleanupCommand",
] as const;

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function readTestCommand(metadata: unknown): unknown {
  return isRecord(metadata) ? metadata.testCommand : undefined;
}

/**
 * Lists the code-location fields a workspace PATCH would actually change.
 * Fields resent with their current value are not a change, so an agent that
 * round-trips a whole workspace object for another field is not refused.
 */
export function collectProjectWorkspaceCodeLocationChanges(
  patch: unknown,
  existing: Record<string, unknown> | null | undefined,
): string[] {
  if (!isRecord(patch)) return [];
  const changed: string[] = [];
  for (const field of PROJECT_WORKSPACE_CODE_LOCATION_FIELDS) {
    if (hasOwn(patch, field) && !sameValue(patch[field], existing?.[field])) {
      changed.push(field);
    }
  }
  // `metadata` is replaced as a whole, so dropping the key is also a change.
  if (
    hasOwn(patch, "metadata")
    && !sameValue(readTestCommand(patch.metadata), readTestCommand(existing?.metadata))
  ) {
    changed.push("metadata.testCommand");
  }
  return changed;
}

export function assertBoardOnlyProjectWorkspaceChange(req: Request, changed: string[] | true) {
  if (req.actor.type !== "agent") return;
  if (changed !== true && changed.length === 0) return;
  throw forbidden(PROJECT_CODE_LOCATION_BOARD_ONLY_MESSAGE);
}

/** Same field list for a portable (company import) workspace entry. */
export function collectImportedWorkspaceCodeLocationFields(workspace: {
  repoUrl?: unknown;
  repoRef?: unknown;
  defaultRef?: unknown;
  isPrimary?: unknown;
  metadata?: unknown;
}): string[] {
  const fields: string[] = [];
  if (workspace.repoUrl) fields.push("repoUrl");
  if (workspace.repoRef) fields.push("repoRef");
  if (workspace.defaultRef) fields.push("defaultRef");
  if (workspace.isPrimary) fields.push("isPrimary");
  if (readTestCommand(workspace.metadata) !== undefined) fields.push("metadata.testCommand");
  return fields;
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
