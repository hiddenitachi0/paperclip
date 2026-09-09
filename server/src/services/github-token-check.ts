import type { GitHubTokenCheckReport, GitHubTokenRequirement, GitHubTokenScopeResult } from "@paperclipai/shared";
import { gitHubApiBase } from "./github-fetch.js";

/**
 * Which GitHub token permissions a project needs, and (optionally) whether the
 * token that is actually bound has them. Built for the recurring "the agent's
 * token lacked the `workflow` scope, so it could not fix a CI file and worked
 * around it by disabling the CI step" incident: the operator should learn
 * which scope to add, in plain words, BEFORE an agent hits the wall.
 *
 * Nothing here ever returns the token itself. The report carries scope names,
 * a status per scope, and the GitHub login the token belongs to.
 */

export type { GitHubTokenCheckReport, GitHubTokenRequirement, GitHubTokenScopeResult };

export interface ParsedGitHubRepoUrl {
  hostname: string;
  owner: string;
  name: string;
}

export function parseGitHubRepoUrl(value: string | null | undefined): ParsedGitHubRepoUrl | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ssh = trimmed.match(/^git@([^:]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh) return { hostname: ssh[1]!.toLowerCase(), owner: ssh[2]!, name: ssh[3]! };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const name = segments[1]!.replace(/\.git$/i, "");
    if (!owner || !name) return null;
    return { hostname: parsed.hostname.toLowerCase(), owner, name };
  } catch {
    return null;
  }
}

/**
 * The scopes a project needs, before we know anything about the bound token.
 * `hasWorkflows === null` means "not checked yet", and the workflow entry is
 * then described conditionally.
 */
export function describeGitHubTokenRequirements(input: { hasWorkflows: boolean | null }): GitHubTokenRequirement[] {
  return [
    {
      scope: "repo",
      why: "lets agents read the code and push their branches and merges (for a fine-grained token: Contents = read and write on this repository).",
      required: true,
    },
    {
      scope: "workflow",
      why:
        input.hasWorkflows === false
          ? "not needed: this repository has no files under .github/workflows."
          : input.hasWorkflows === true
            ? "this repository has CI files under .github/workflows, and GitHub blocks every push that touches them unless the token has this scope."
            : "only if the repository has CI files under .github/workflows. Without it GitHub blocks every push that touches those files.",
      required: input.hasWorkflows !== false,
    },
  ];
}

export interface GitHubTokenEvidence {
  /** The X-OAuth-Scopes response header (classic tokens only). */
  scopesHeader: string | null;
  /** The `permissions` object from GET /repos/{owner}/{repo}. */
  repoPermissions: { push?: boolean; admin?: boolean; maintain?: boolean } | null;
  repoPrivate: boolean | null;
  hasWorkflows: boolean | null;
  tokenKind: GitHubTokenCheckReport["tokenKind"];
}

function parseScopesHeader(header: string | null): Set<string> {
  if (!header) return new Set();
  return new Set(
    header
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

/** Pure decision: given what GitHub told us, which required scopes are present? */
export function evaluateGitHubTokenScopes(evidence: GitHubTokenEvidence): GitHubTokenScopeResult[] {
  const requirements = describeGitHubTokenRequirements({ hasWorkflows: evidence.hasWorkflows });
  const granted = parseScopesHeader(evidence.scopesHeader);
  const canPush = evidence.repoPermissions?.push === true || evidence.repoPermissions?.admin === true || evidence.repoPermissions?.maintain === true;

  return requirements.map((requirement) => {
    if (requirement.scope === "repo") {
      if (evidence.tokenKind === "classic") {
        const hasRepo = granted.has("repo");
        const hasPublicRepo = granted.has("public_repo");
        if (hasRepo || (hasPublicRepo && evidence.repoPrivate === false)) {
          if (evidence.repoPermissions && !canPush) {
            return {
              ...requirement,
              status: "missing",
              note: "The token has the scope, but the GitHub user it belongs to cannot push to this repository. Give that user write access on GitHub.",
            };
          }
          return { ...requirement, status: "ok" };
        }
        return {
          ...requirement,
          status: "missing",
          note: hasPublicRepo
            ? 'The token only has "public_repo", which does not cover a private repository. Create the token with the full "repo" scope.'
            : 'Create the token with the "repo" scope ticked.',
        };
      }
      // Fine-grained (or unknown) tokens do not report scopes; go by what the repo says we can do.
      if (evidence.repoPermissions) {
        return canPush
          ? { ...requirement, status: "ok" }
          : {
              ...requirement,
              status: "missing",
              note: "The token can see the repository but cannot push to it. Give it Contents: read and write on this repository.",
            };
      }
      return { ...requirement, status: "unknown", note: "GitHub did not say whether this token can push to the repository." };
    }

    // workflow
    if (!requirement.required) return { ...requirement, status: "ok" };
    if (evidence.tokenKind === "classic") {
      return granted.has("workflow")
        ? { ...requirement, status: "ok" }
        : {
            ...requirement,
            status: "missing",
            note: 'Edit the token on GitHub and tick the "workflow" scope, then paste it into GITHUB_TOKEN again.',
          };
    }
    return {
      ...requirement,
      status: "unknown",
      note:
        "Fine-grained tokens do not report this. Make sure the token has Workflows: read and write on this repository, otherwise agents cannot fix CI files.",
    };
  });
}

function guessTokenKind(token: string, scopesHeader: string | null): GitHubTokenCheckReport["tokenKind"] {
  if (token.startsWith("github_pat_")) return "fine_grained";
  if (token.startsWith("ghp_") || token.startsWith("gho_") || scopesHeader !== null) return "classic";
  return "unknown";
}

function summarize(report: Omit<GitHubTokenCheckReport, "summary" | "ok">): { summary: string; ok: boolean } {
  const missing = report.scopes.filter((scope) => scope.status === "missing");
  const unknown = report.scopes.filter((scope) => scope.status === "unknown");
  const who = report.login ? ` (signed in to GitHub as ${report.login})` : "";
  if (missing.length > 0) {
    return {
      ok: false,
      summary: `The GitHub token${who} is missing: ${missing.map((scope) => `"${scope.scope}"`).join(", ")}. Agents will get stuck until it is added.`,
    };
  }
  if (unknown.length > 0) {
    return {
      ok: true,
      summary: `The GitHub token${who} can push to this repository. Could not confirm: ${unknown.map((scope) => `"${scope.scope}"`).join(", ")}.`,
    };
  }
  return { ok: true, summary: `The GitHub token${who} has everything this project needs.` };
}

export interface CheckGitHubTokenInput {
  token: string;
  repoUrl: string;
  fetchImpl?: typeof fetch;
}

export class GitHubTokenCheckError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Calls GitHub with the token and reports which of the project's required
 * scopes it has. Throws GitHubTokenCheckError with an operator-facing message
 * when the token is rejected or the repository cannot be seen.
 */
export async function checkGitHubTokenForRepo(input: CheckGitHubTokenInput): Promise<GitHubTokenCheckReport> {
  const parsed = parseGitHubRepoUrl(input.repoUrl);
  if (!parsed) {
    throw new GitHubTokenCheckError(422, "The project's repository address is not a GitHub repository URL, so there is nothing to check the token against.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = gitHubApiBase(parsed.hostname);
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "paperclip-token-check",
  };

  const get = async (path: string) => {
    try {
      return await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new GitHubTokenCheckError(422, `Could not reach ${parsed.hostname} to check the token. Try again in a moment.`);
    }
  };

  const userRes = await get("/user");
  if (userRes.status === 401) {
    throw new GitHubTokenCheckError(422, "GitHub rejected the token: it is invalid, expired or has been revoked. Create a new token and paste it into GITHUB_TOKEN.");
  }
  const scopesHeader = userRes.headers.get("x-oauth-scopes");
  const userBody = userRes.ok ? ((await userRes.json().catch(() => null)) as { login?: unknown } | null) : null;
  const login = typeof userBody?.login === "string" ? userBody.login : null;
  const tokenKind = guessTokenKind(input.token, scopesHeader);

  const repoRes = await get(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`);
  if (repoRes.status === 404) {
    throw new GitHubTokenCheckError(
      422,
      `GitHub says the token cannot see ${parsed.owner}/${parsed.name}. Either the repository name is wrong, or the token was not given access to this repository.`,
    );
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    throw new GitHubTokenCheckError(422, `GitHub refused to show ${parsed.owner}/${parsed.name} with this token (HTTP ${repoRes.status}).`);
  }
  const repoBody = repoRes.ok
    ? ((await repoRes.json().catch(() => null)) as { private?: unknown; default_branch?: unknown; permissions?: unknown } | null)
    : null;
  const repoPrivate = typeof repoBody?.private === "boolean" ? repoBody.private : null;
  const defaultBranch = typeof repoBody?.default_branch === "string" ? repoBody.default_branch : null;
  const repoPermissions =
    repoBody?.permissions && typeof repoBody.permissions === "object"
      ? (repoBody.permissions as { push?: boolean; admin?: boolean; maintain?: boolean })
      : null;

  const workflowsRes = await get(
    `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/contents/.github/workflows${defaultBranch ? `?ref=${encodeURIComponent(defaultBranch)}` : ""}`,
  );
  let hasWorkflows: boolean | null = null;
  if (workflowsRes.status === 404) hasWorkflows = false;
  else if (workflowsRes.ok) {
    const listing = (await workflowsRes.json().catch(() => null)) as unknown;
    hasWorkflows = Array.isArray(listing) ? listing.length > 0 : true;
  }

  const scopes = evaluateGitHubTokenScopes({ scopesHeader, repoPermissions, repoPrivate, hasWorkflows, tokenKind });
  const partial = {
    tokenKind,
    login,
    repo: { owner: parsed.owner, name: parsed.name, hostname: parsed.hostname, private: repoPrivate, defaultBranch },
    hasWorkflows,
    scopes,
  };
  return { ...partial, ...summarize(partial) };
}
