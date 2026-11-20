import type { Request } from "express";
import { PROJECT_WORKSPACE_TEST_COMMAND_KEY } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";

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

// DUR-5246: the board-only guard used to be "not an agent". A recovery-only
// board_delegate token passes company access but is not a person on the board,
// so it is treated like an agent for these fields.
export function isBoardOnlyBlockedActor(req: Request) {
  return req.actor.type === "agent" || req.actor.type === "board_delegate";
}

/**
 * DUR-5231: an agent tried to set a protected project setting to something other than what the
 * board stored. The settings are not all commands, so the wording stays neutral.
 */
export function assertNoAgentProtectedProjectSettingChange(req: Request, paths: string[]) {
  if (!isBoardOnlyBlockedActor(req) || paths.length === 0) return;
  throw forbidden(
    `This project has settings only the board can change (${paths.join(", ")}). Your update would change them. Leave them out, or ask the board.`,
  );
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (!isBoardOnlyBlockedActor(req) || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

/**
 * DUR-5246: the project and task routes guard more than commands (runtime services,
 * authorizationPolicy, requireIsolation, enabled/defaultMode), so they use plain text
 * that stays true for every one of those fields.
 */
export function assertBoardOnlyWorkspaceSettingsMutation(req: Request, paths: string[]) {
  if (!isBoardOnlyBlockedActor(req) || paths.length === 0) return;
  throw forbidden(
    `Only a person on the board can change workspace commands, runtime services or isolation settings (${paths.join(", ")}).`,
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
  // DUR-5242: authorizationPolicy decides whether assignments into the project need
  // approval and which trust preset/boundary applies, so only the board (or a plugin)
  // may set it. On create there is nothing stored, so naming the key at all is refused.
  if (hasOwn(policy, "authorizationPolicy")) {
    paths.push("executionWorkspacePolicy.authorizationPolicy");
  }
  return paths;
}

function isNonEmptyCommand(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * DUR-5231: a project PATCH replaces the whole `executionWorkspacePolicy`, so an agent that
 * leaves a board-set protected field out (or sends `null`, or `{ enabled: false }`) would wipe
 * it without ever naming it. For agent writes the stored protected fields are carried forward
 * into the new policy instead, and the write is refused only when the agent sends a *different*
 * value. Protected fields: requireIsolation, workspaceRuntime, authorizationPolicy and the
 * strategy provision/teardown commands. Everything else in the policy stays editable.
 *
 * `changedPaths` lists protected fields the agent set to a value other than the stored one.
 * `policy` is what should be written: the agent's policy plus the carried-forward fields.
 * Only call this when the body actually contains `executionWorkspacePolicy`.
 */
export function carryForwardProtectedProjectPolicyFields(
  nextPolicy: unknown,
  storedPolicy: unknown,
): { policy: unknown; changedPaths: string[] } {
  const stored = isRecord(storedPolicy) ? storedPolicy : {};
  const next = isRecord(nextPolicy) ? nextPolicy : null;
  const named = (key: string) => next !== null && hasOwn(next, key) && next[key] !== undefined;
  const changedPaths: string[] = [];
  const carried: Record<string, unknown> = {};

  // requireIsolation only means something when it is true; false and absent are the same setting.
  const storedIsolation = stored.requireIsolation === true;
  if (named("requireIsolation")) {
    if ((next!.requireIsolation === true) !== storedIsolation) {
      changedPaths.push("executionWorkspacePolicy.requireIsolation");
    }
  } else if (storedIsolation) {
    carried.requireIsolation = true;
  }

  // Whole-value fields. authorizationPolicy (DUR-5242) decides whether assignments into the
  // project need approval, so it is board-only like the host-run workspaceRuntime.
  for (const key of ["workspaceRuntime", "authorizationPolicy"] as const) {
    const storedValue = stored[key] ?? null;
    if (named(key)) {
      if (!sameValue(next![key], storedValue)) changedPaths.push(`executionWorkspacePolicy.${key}`);
    } else if (storedValue !== null) {
      carried[key] = storedValue;
    }
  }

  const storedStrategy = isRecord(stored.workspaceStrategy) ? stored.workspaceStrategy : null;
  const nextStrategy = next && isRecord(next.workspaceStrategy) ? next.workspaceStrategy : null;
  const carriedCommands: Record<string, unknown> = {};
  for (const key of ["provisionCommand", "teardownCommand"] as const) {
    const storedCommand = storedStrategy?.[key] ?? null;
    if (nextStrategy && nextStrategy[key] !== undefined) {
      if (!sameValue(nextStrategy[key], storedCommand)) {
        changedPaths.push(`executionWorkspacePolicy.workspaceStrategy.${key}`);
      }
    } else if (storedCommand !== null) {
      carriedCommands[key] = storedCommand;
    }
  }
  if (Object.keys(carriedCommands).length > 0) {
    // Strategy left out or not an object: keep the stored one whole. Otherwise keep the
    // agent's strategy and add back only the commands it left out.
    carried.workspaceStrategy = nextStrategy ? { ...nextStrategy, ...carriedCommands } : storedStrategy;
  }

  // DUR-5246: `enabled: false` or `defaultMode: "adapter_default"` leaves the stored fields in
  // place but makes runs ignore them (unless requireIsolation is on), so while any board-only
  // field is stored an agent may not change either switch. Leaving one out keeps the stored value.
  const storedHasBoardOnlyField =
    (stored.workspaceRuntime !== undefined && stored.workspaceRuntime !== null)
    || (stored.authorizationPolicy !== undefined && stored.authorizationPolicy !== null)
    || storedIsolation
    || isNonEmptyCommand(storedStrategy?.provisionCommand)
    || isNonEmptyCommand(storedStrategy?.teardownCommand);
  if (storedHasBoardOnlyField) {
    for (const key of ["enabled", "defaultMode"] as const) {
      if (named(key)) {
        const same = key === "enabled"
          ? Boolean(stored.enabled) === Boolean(next![key])
          : sameValue(stored[key], next![key]);
        if (!same) changedPaths.push(`executionWorkspacePolicy.${key}`);
      } else if (stored[key] !== undefined) {
        carried[key] = stored[key];
      }
    }
  }

  if (Object.keys(carried).length === 0) return { policy: nextPolicy, changedPaths };
  return { policy: { enabled: false, ...(next ?? {}), ...carried }, changedPaths };
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

export function sameValue(a: unknown, b: unknown) {
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
  if (!isBoardOnlyBlockedActor(req)) return;
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
    const settings = input.executionWorkspaceSettings;
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        settings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
    // DUR-5246: workspaceRuntime holds service commands the server runs on the
    // host, and a task's value beats the project's, so it is board-only here
    // exactly as on the project. Same for the command/authorization keys.
    for (const key of ["workspaceRuntime", "authorizationPolicy", "setupCommand", "cleanupCommand"]) {
      if (hasOwn(settings, key)) paths.push(`executionWorkspaceSettings.${key}`);
    }
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
      if (hasOwn(adapterConfig, "workspaceRuntime")) {
        paths.push("assigneeAdapterOverrides.adapterConfig.workspaceRuntime");
      }
    }
  }
  return paths;
}

/**
 * DUR-5246: `allowIssueOverride: false` on a project means tasks may not carry
 * their own workspace settings. An agent write that names `executionWorkspaceSettings`
 * (any value) into such a project is refused; a board user is not bound by it.
 */
export const ISSUE_WORKSPACE_OVERRIDE_DISABLED_MESSAGE =
  "This project does not allow tasks to override the workspace settings. Only a person on the board can change them.";

export function assertAgentIssueWorkspaceOverrideAllowed(
  req: Request,
  input: { executionWorkspaceSettings?: unknown },
  projectPolicy: unknown,
) {
  if (!isBoardOnlyBlockedActor(req)) return;
  if (input.executionWorkspaceSettings === undefined) return;
  if (!isRecord(projectPolicy) || projectPolicy.allowIssueOverride !== false) return;
  throw forbidden(ISSUE_WORKSPACE_OVERRIDE_DISABLED_MESSAGE);
}

/**
 * DUR-5246: a task's `executionWorkspaceSettings.mode` can switch the project's board-set fields
 * off without naming them: a non-isolated mode drops the project's provision/teardown commands,
 * and `agent_default` also drops its runtime services. For an agent (or delegate token) the mode
 * is refused when it would do that and differs from what the project's own default already gives
 * and from the task's stored mode (so a round-trip PATCH still works). `requireIsolation`
 * projects are unaffected: isolation wins whatever the task says.
 */
export function collectAgentTaskModeDropPaths(
  settings: unknown,
  projectPolicy: unknown,
  existingSettings?: unknown,
): string[] {
  if (!isRecord(settings) || !isRecord(projectPolicy)) return [];
  // Use the same reading of `mode` the run does: the old names `project_primary` and `isolated`
  // still resolve to `shared_workspace` and `isolated_workspace` there.
  const parsedSettings = parseIssueExecutionWorkspaceSettings(settings);
  const mode = parsedSettings?.mode;
  if (projectPolicy.enabled !== true || projectPolicy.requireIsolation === true) return [];
  const strategy = isRecord(projectPolicy.workspaceStrategy) ? projectPolicy.workspaceStrategy : null;
  const dropsCommands = isNonEmptyCommand(strategy?.provisionCommand) || isNonEmptyCommand(strategy?.teardownCommand);
  const projectDefaultMode = projectPolicy.defaultMode === "isolated_workspace"
    ? "isolated_workspace"
    : projectPolicy.defaultMode === "operator_branch"
      ? "operator_branch"
      : projectPolicy.defaultMode === "adapter_default"
        ? "agent_default"
        : "shared_workspace";
  // `workspaceStrategy.type` is the other switch: the run keeps the task's type, and any type
  // other than `git_worktree` returns the shared checkout before the project's provision/teardown
  // commands are reached. It only matters when the run would otherwise be isolated (a
  // non-isolated mode already drops the commands and is judged below).
  const strategyType = parsedSettings?.workspaceStrategy?.type;
  if (dropsCommands && strategyType && strategyType !== "git_worktree") {
    const existingParsed = parseIssueExecutionWorkspaceSettings(existingSettings);
    const effectiveMode = mode ?? existingParsed?.mode ?? projectDefaultMode;
    if (effectiveMode === "isolated_workspace" && existingParsed?.workspaceStrategy?.type !== strategyType) {
      return ["executionWorkspaceSettings.workspaceStrategy.type"];
    }
  }
  if (mode !== "shared_workspace" && mode !== "agent_default" && mode !== "operator_branch") return [];
  const dropsRuntime = mode === "agent_default"
    && projectPolicy.workspaceRuntime !== undefined && projectPolicy.workspaceRuntime !== null;
  if (!dropsCommands && !dropsRuntime) return [];
  if (mode === projectDefaultMode) return [];
  if (parseIssueExecutionWorkspaceSettings(existingSettings)?.mode === mode) return [];
  return ["executionWorkspaceSettings.mode"];
}

/**
 * DUR-5246: every path that turns `executionWorkspaceSettings` into a task (routine runs,
 * pipeline stage entry) must apply the same three checks as the task routes: no board-only
 * commands/runtime, the project's `allowIssueOverride`, and no `mode` that switches the
 * project's board-set fields off. A board user is not bound by any of them.
 */
export function assertAgentTaskWorkspaceSettingsAllowed(
  req: Request,
  executionWorkspaceSettings: unknown,
  projectPolicy: unknown,
  existingSettings?: unknown,
) {
  if (!isBoardOnlyBlockedActor(req)) return;
  if (executionWorkspaceSettings === undefined || executionWorkspaceSettings === null) return;
  assertBoardOnlyWorkspaceSettingsMutation(req, collectIssueWorkspaceCommandPaths({ executionWorkspaceSettings }));
  assertAgentIssueWorkspaceOverrideAllowed(req, { executionWorkspaceSettings }, projectPolicy);
  assertBoardOnlyWorkspaceSettingsMutation(
    req,
    collectAgentTaskModeDropPaths(executionWorkspaceSettings, projectPolicy, existingSettings),
  );
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
