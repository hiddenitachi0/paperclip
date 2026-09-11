import type { ProjectDeployPolicy } from "@paperclipai/shared";

/**
 * Plain-language completeness check for a project's deploy settings.
 *
 * The shared zod schema only checks the SHAPE of `deployPolicy` so the
 * operator can save the form one field at a time. This is the part that
 * decides whether the settings actually make sense, in words a non-technical
 * operator can act on. Format problems (a relative folder, a health-check
 * address that is not a web address, a workspace from another project) are
 * reported whenever the field is filled in; "missing" problems only once the
 * operator tries to switch deploys ON, because that is when the runner would
 * start relying on them (scripts/deploy-runner.sh refuses to act on a policy
 * with an empty deployTargetPath or healthCheckUrl, silently from the
 * operator's point of view).
 */

export interface DeployPolicyValidationWorkspace {
  id: string;
  name: string;
  repoUrl: string | null;
}

export interface DeployPolicyValidationAgent {
  id: string;
  name: string;
  status: string;
}

export interface DeployPolicyValidationContext {
  workspaces: DeployPolicyValidationWorkspace[];
  agents: DeployPolicyValidationAgent[];
}

function isAbsolutePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRelativeInsideProject(value: string) {
  if (!value.trim()) return false;
  if (isAbsolutePath(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === "..");
}

function hasWhitespace(value: string) {
  return /\s/.test(value);
}

/**
 * Returns the list of things wrong with `policy`, each a complete sentence an
 * operator can act on. Empty when the policy is fine to store (and, when
 * `enabled` is true, fine to switch on).
 */
export function describeDeployPolicyProblems(
  policy: ProjectDeployPolicy,
  context: DeployPolicyValidationContext,
): string[] {
  const problems: string[] = [];
  const enabled = policy.enabled === true;
  const workspaceId = (policy.workspaceId ?? "").trim();
  const targetPath = (policy.deployTargetPath ?? "").trim();
  const healthCheckUrl = (policy.healthCheckUrl ?? "").trim();
  const deployCommand = (policy.deployCommand ?? "").trim();
  const envFile = (policy.envFile ?? "").trim();
  const deployBranch = (policy.deployBranch ?? "").trim();
  const mirrorBranch = (policy.mirrorBranch ?? "").trim();

  // Workspace: must be one of this project's, and must have a repo to fetch from.
  if (workspaceId) {
    const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      problems.push("The workspace chosen for deploys does not belong to this project. Pick one of this project's workspaces.");
    } else if (!workspace.repoUrl?.trim()) {
      problems.push(
        `The workspace "${workspace.name}" has no repository address, so the deploy runner would have nothing to fetch. ` +
          "Set the project's repo first, or choose a workspace that has one.",
      );
    }
  } else if (enabled) {
    problems.push("Choose which workspace to deploy from before letting agents request deploys.");
  }

  // Folder on the server.
  if (targetPath) {
    if (!isAbsolutePath(targetPath)) {
      problems.push(
        `The folder on the server must be a full path starting with "/", for example /root/my-project (got "${targetPath}").`,
      );
    }
  } else if (enabled) {
    problems.push("Fill in the folder on the server where this project is checked out, for example /root/my-project.");
  }

  // Health check.
  if (healthCheckUrl) {
    if (!isHttpUrl(healthCheckUrl)) {
      problems.push(
        "The health check must be a full web address starting with http:// or https://, for example " +
          `https://example.com/api/health (got "${healthCheckUrl}").`,
      );
    }
  } else if (enabled) {
    problems.push(
      "Fill in the health check web address. After every deploy the runner opens it and rolls back if it does not answer OK.",
    );
  }

  // DUR-3974: the pages that must still work after a deploy. Format only —
  // leaving the list empty is allowed on purpose (every project that exists
  // today has an empty one, and blocking on it would turn a safety
  // improvement into an outage of its own). The runner says out loud on the
  // card when a deploy was only checked against the one health-check address.
  for (const page of policy.appHealthCheckPaths ?? []) {
    const trimmed = page.trim();
    if (!trimmed) continue;
    if (hasWhitespace(trimmed)) {
      problems.push(`A page address cannot contain spaces (got "${trimmed}"). Put each page on its own line.`);
      continue;
    }
    if (!trimmed.startsWith("/") && !isHttpUrl(trimmed)) {
      problems.push(
        'Each page to check must start with "/" (for example /dashboard) or be a full web address starting with ' +
          `http:// or https:// (got "${trimmed}").`,
      );
    }
  }

  // Recipe.
  if (policy.deployKind === "custom") {
    if (!deployCommand && enabled) {
      problems.push('The "custom command" way of deploying needs the command to run. Fill it in, or choose one of the Docker Compose options.');
    }
  } else {
    const services = (policy.deployServices ?? []).map((service) => service.trim()).filter(Boolean);
    const badService = services.find(hasWhitespace);
    if (badService) {
      problems.push(`Service names cannot contain spaces (got "${badService}"). Separate several services with commas.`);
    }
  }

  // Compose extras.
  if (envFile && !isRelativeInsideProject(envFile)) {
    problems.push(
      `The environment file must be a path inside the project folder, for example .env or docker/.env.prod (got "${envFile}").`,
    );
  }
  for (const composeFile of policy.composeFiles ?? []) {
    const trimmed = composeFile.trim();
    if (trimmed && !isRelativeInsideProject(trimmed)) {
      problems.push(
        `Compose files must be paths inside the project folder, for example docker/docker-compose.yml (got "${trimmed}").`,
      );
    }
  }

  // Branches.
  if (deployBranch && hasWhitespace(deployBranch)) {
    problems.push(`The deploy branch name cannot contain spaces (got "${deployBranch}").`);
  }
  if (mirrorBranch && hasWhitespace(mirrorBranch)) {
    problems.push(`The mirror branch name cannot contain spaces (got "${mirrorBranch}").`);
  }
  if (deployBranch && mirrorBranch && deployBranch === mirrorBranch) {
    problems.push(
      `The deploy branch and the mirror branch are both "${deployBranch}". The mirror branch is the one that is never deployed, so they must differ.`,
    );
  }

  // Requesting agent.
  if (policy.requestingAgentId) {
    const agent = context.agents.find((candidate) => candidate.id === policy.requestingAgentId);
    if (!agent) {
      problems.push("The agent chosen to request deploys is not part of this company any more. Choose another agent.");
    } else if (agent.status === "terminated") {
      problems.push(`The agent chosen to request deploys, ${agent.name}, has been terminated. Choose another agent.`);
    }
  }

  return problems;
}

/** One operator-facing message for an HTTP 422, built from the problem list. */
export function formatDeployPolicyProblems(problems: string[]): string {
  if (problems.length === 1) return problems[0]!;
  return `Deploy settings need attention: ${problems.join(" ")}`;
}
