import type { ProjectDeployPolicy, ProjectDeployTransport } from "@paperclipai/shared";

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
 * DUR-4977: the SFTP allowlist and exclude lists are matched as exact strings
 * against the files git tracks, and every resolved path ends up inside a curl
 * quote command that cannot escape anything. So the strict form is required
 * for both: a plain relative path (a single trailing "/" is allowed and means
 * "this whole folder"), no "..", ".", empty or backslash pieces, no
 * whitespace and no quote characters. Returns why `value` is unusable, or
 * null when it is fine.
 */
function describeSftpPathProblem(value: string): string | null {
  if (isAbsolutePath(value)) return "it is an absolute path";
  if (/\s/.test(value)) return "it contains a space";
  if (/['"\\]/.test(value)) return "it contains a quote or backslash character";
  if (/[%#?[\]{}]/.test(value)) return "it contains a percent sign, #, ?, square bracket or curly brace (the runner builds a URL from the path, so these would not mean what they say)";
  const body = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = body.split("/");
  if (segments.some((segment) => segment === "..")) return 'it contains a ".." segment';
  if (segments.some((segment) => segment === "" || segment === ".")) {
    return 'it contains an empty or "." segment (write it like Apps/data/ — no "./", no "//")';
  }
  return null;
}

// Base64 of a SHA-256 digest: 43 characters, optionally with its one "=".
const SFTP_HOST_KEY_SHA256_PATTERN = /^[A-Za-z0-9+/]{43}=?$/;

/**
 * Returns the list of things wrong with `policy`, each a complete sentence an
 * operator can act on. Empty when the policy is fine to store (and, when
 * `enabled` is true, fine to switch on).
 */
export function describeDeployPolicyProblems(
  policy: ProjectDeployPolicy,
  context: DeployPolicyValidationContext,
  // paperclip:allow-git-push: enum default value (ProjectDeployTransport), not a git command invocation
  deployTransport: ProjectDeployTransport = "git_push",
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

  // Workspace: must be one of this project's, and must have a repo to fetch
  // from. Needed for BOTH transports — SFTP still fetches the repo into the
  // local folder below before uploading the allowlisted files out of it.
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

  // Folder on the server: for git_push this is also the live target; for sftp
  // it is the local checkout the runner fetches into and reads the allowlist
  // out of before uploading.
  if (targetPath) {
    if (!isAbsolutePath(targetPath)) {
      problems.push(
        `The folder on the server must be a full path starting with "/", for example /root/my-project (got "${targetPath}").`,
      );
    }
  } else if (enabled) {
    problems.push("Fill in the folder on the server where this project is checked out, for example /root/my-project.");
  }

  // Health check: required for BOTH transports. scripts/deploy-runner.sh
  // refuses to act on a policy with an empty healthCheckUrl regardless of
  // transport, so this cannot be sftp-only without leaving the runner's
  // refusal "silent from the operator's point of view" for that transport.
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

  // DUR-3974 / DUR-4236: the pages that must still work after a deploy.
  // Format is checked for every transport. Whether an empty list is allowed
  // differs by transport: for git_push it's a deliberate opt-in safety net
  // (every project that exists today started with an empty one, and blocking
  // on it would turn a safety improvement into an outage of its own), but for
  // sftp there is no git-based rollback to fall back on if the upload breaks
  // the site, so an sftp project is required to list at least one page —
  // see the sftp branch below.
  for (const page of policy.appHealthCheckPaths ?? []) {
    const trimmed = page.trim();
    if (!trimmed) continue;
    // The field this comes from is "Pages that must still work
    // (comma-separated)" and is split on commas, so telling the operator to
    // put each page on its own line — as this once did — asks for something
    // the form cannot do. Say what the field actually accepts.
    if (hasWhitespace(trimmed)) {
      problems.push(
        `A page address cannot contain spaces (got "${trimmed}"). Separate several pages with commas, like ` +
          "/, /dashboard, /reports. If a space is really part of the address, write it as %20.",
      );
      continue;
    }
    if (!trimmed.startsWith("/") && !isHttpUrl(trimmed)) {
      problems.push(
        'Each page to check must start with "/" (for example /dashboard) or be a full web address starting with ' +
          `http:// or https:// (got "${trimmed}").`,
      );
    }
  }

  // DUR-4068 / DUR-4236: SFTP transport uploads an explicit allowlist to a
  // configured host instead of running a git-checkout-based recipe on the
  // box, so the remaining "completeness" requirements are its own, checked
  // only when this project's deployTransport is actually "sftp".
  if (deployTransport === "sftp") {
    const sftpHost = (policy.sftpHost ?? "").trim();
    const sftpUsername = (policy.sftpUsername ?? "").trim();
    const sftpRemotePath = (policy.sftpRemotePath ?? "").trim();
    const sftpAllowlist = (policy.sftpAllowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (!sftpHost && enabled) {
      problems.push("Fill in the SFTP host to upload to before letting agents request deploys.");
    }
    if (!sftpUsername && enabled) {
      problems.push("Fill in the SFTP username before letting agents request deploys.");
    }
    if (sftpRemotePath && hasWhitespace(sftpRemotePath)) {
      problems.push(`The SFTP remote path cannot contain spaces (got "${sftpRemotePath}").`);
    } else if (!sftpRemotePath && enabled) {
      problems.push("Fill in the remote directory on the SFTP host to upload into before letting agents request deploys.");
    }
    if (sftpAllowlist.length === 0 && enabled) {
      problems.push(
        "List the exact files the deploy runner may upload over SFTP. There is no whole-tree or wildcard upload.",
      );
    }
    for (const entry of policy.sftpAllowlist ?? []) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) continue;
      const why = describeSftpPathProblem(trimmedEntry);
      if (why) {
        problems.push(
          `Each item in the SFTP allowlist must be a file or a folder (ending in "/") inside the project folder, ` +
            `with no ".." segments and no absolute path (got "${entry}": ${why}).`,
        );
      }
    }
    for (const entry of policy.sftpExclude ?? []) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) continue;
      const why = describeSftpPathProblem(trimmedEntry);
      if (why) {
        problems.push(
          `Each item in the SFTP exclude list must be a file path or a folder path ending in "/" inside the ` +
            `project folder (got "${entry}": ${why}).`,
        );
      }
    }
    const sftpHostKeySha256 = (policy.sftpHostKeySha256 ?? "").trim();
    if (sftpHostKeySha256) {
      if (!SFTP_HOST_KEY_SHA256_PATTERN.test(sftpHostKeySha256)) {
        problems.push(
          "The SFTP host key pin must be the base64 SHA-256 of the host's public key — 43 characters, " +
            'without a "SHA256:" prefix. Get it with: ssh-keyscan -t ed25519 <host> | ssh-keygen -lf - ' +
            "and copy what follows SHA256:.",
        );
      }
    } else if (enabled) {
      problems.push(
        "Fill in the SFTP host key pin before letting agents request deploys. Without it the deploy key could be " +
          "handed to whatever answers on the host's address.",
      );
    }
    if (policy.sftpPort !== undefined && (!Number.isInteger(policy.sftpPort) || policy.sftpPort <= 0)) {
      problems.push(`The SFTP port must be a positive whole number (got "${policy.sftpPort}").`);
    }
    // DUR-4236: an sftp/website deploy has no git-based rollback to fall back
    // on for verifying the live site after a swap — the runner can only tell
    // the upload "worked" from the generic health-check address unless the
    // operator names real pages to re-check. Required (not just formatted)
    // for this transport specifically; git_push projects keep the opt-in
    // empty-list behavior from DUR-3974 above.
    const appHealthCheckPaths = (policy.appHealthCheckPaths ?? []).map((page) => page.trim()).filter(Boolean);
    if (appHealthCheckPaths.length === 0 && enabled) {
      problems.push(
        'List at least one page under "Pages that must still work" for an SFTP website deploy, for example / or /index.html. ' +
          "Without one, the runner can only confirm the health-check address answered — not that the uploaded site itself still works.",
      );
    }
    problems.push(...describeRequestingAgentProblems(policy, context));
    return problems;
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

  problems.push(...describeRequestingAgentProblems(policy, context));

  return problems;
}

/** Shared by both transports: whoever may request a deploy must still be a real, non-terminated agent. */
function describeRequestingAgentProblems(
  policy: ProjectDeployPolicy,
  context: DeployPolicyValidationContext,
): string[] {
  if (!policy.requestingAgentId) return [];
  const agent = context.agents.find((candidate) => candidate.id === policy.requestingAgentId);
  if (!agent) {
    return ["The agent chosen to request deploys is not part of this company any more. Choose another agent."];
  }
  if (agent.status === "terminated") {
    return [`The agent chosen to request deploys, ${agent.name}, has been terminated. Choose another agent.`];
  }
  return [];
}

/** One operator-facing message for an HTTP 422, built from the problem list. */
export function formatDeployPolicyProblems(problems: string[]): string {
  if (problems.length === 1) return problems[0]!;
  return `Deploy settings need attention: ${problems.join(" ")}`;
}
