import { and, eq, inArray, sql } from "drizzle-orm";
import { issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import type { ProjectDeployBranches } from "./deploy-branches.js";

/**
 * DUR-291: `resolveProjectDeployBranches` walks issue -> project -> deployPolicy, so an
 * issue filed with no project at all (nothing prevents that, and agents routinely do it)
 * resolves to null -- and every consumer of that null (deploy-completion-gate.ts,
 * merge-deploy-visibility.ts) then silently treats the issue as "never touched a deploy
 * branch". DUR-286 merged a security fix into `custom` that way and went straight to
 * `done` with no deploy ever confirmed.
 *
 * This is the fallback for exactly that case: when NONE of the given issues has a project,
 * look for the company's project(s) whose declared `deployPolicy.deployBranch` matches the
 * branch the merge_pr approval actually targeted. One match is unambiguous. Several
 * matches are disambiguated by the repository the approval names (against each project's
 * primary workspace repo); if that still doesn't single one out, give up -- callers must
 * then surface the gap visibly rather than fall back to silence.
 *
 * Deliberately NOT applied to an issue that HAS a project which simply declares no deploy
 * branch: that project chose not to make the branch promise, and borrowing a sibling
 * project's policy for it would be a guess, not a fact.
 *
 * Lives in its own module (not deploy-branches.ts) so the many suites that mock
 * deploy-branches.js with only `resolveProjectDeployBranches` keep working unchanged.
 */

export type FallbackDeployBranchesReason =
  | "issue_has_project"
  | "no_base"
  | "no_matching_project"
  | "ambiguous"
  | "resolved_unique"
  | "resolved_by_repo";

export interface FallbackDeployBranchesResult {
  branches: (ProjectDeployBranches & { resolvedViaFallback: true }) | null;
  issueHasProject: boolean;
  reason: FallbackDeployBranchesReason;
}

export function parseGitHubRepoReference(value: unknown): { owner: string; name: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // owner/name, https://github.com/owner/name(.git), git@github.com:owner/name(.git)
  const match =
    trimmed.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/git@[^/]+\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ?? null;
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name || owner.includes(":")) return null;
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

async function anyIssueHasProject(db: Db, issueIds: string[]): Promise<boolean> {
  if (issueIds.length === 0) return false;
  const rows = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  return rows.some((row) => typeof row.projectId === "string" && row.projectId.length > 0);
}

export async function resolveFallbackDeployBranches(
  db: Db,
  input: { companyId: string; issueIds: string[]; bases: string[]; repo?: unknown },
): Promise<FallbackDeployBranchesResult> {
  if (await anyIssueHasProject(db, input.issueIds)) {
    return { branches: null, issueHasProject: true, reason: "issue_has_project" };
  }

  const bases = Array.from(
    new Set(input.bases.map((base) => (typeof base === "string" ? base.trim() : "")).filter(Boolean)),
  );
  if (bases.length === 0) return { branches: null, issueHasProject: false, reason: "no_base" };

  const candidates = await db
    .select({ id: projects.id, deployPolicy: projects.deployPolicy })
    .from(projects)
    .where(
      and(
        eq(projects.companyId, input.companyId),
        inArray(sql`${projects.deployPolicy} ->> 'deployBranch'`, bases),
      ),
    );

  const usable = candidates
    .map((row) => {
      const policy = (row.deployPolicy ?? null) as Record<string, unknown> | null;
      const deployBranch = typeof policy?.deployBranch === "string" ? policy.deployBranch : undefined;
      const mirrorBranch = typeof policy?.mirrorBranch === "string" ? policy.mirrorBranch : undefined;
      return deployBranch && bases.includes(deployBranch)
        ? { projectId: row.id, deployBranch, mirrorBranch }
        : null;
    })
    .filter((row): row is { projectId: string; deployBranch: string; mirrorBranch: string | undefined } => row !== null);

  if (usable.length === 0) return { branches: null, issueHasProject: false, reason: "no_matching_project" };
  if (usable.length === 1) {
    return {
      branches: { ...usable[0], resolvedViaFallback: true },
      issueHasProject: false,
      reason: "resolved_unique",
    };
  }

  const claimed = parseGitHubRepoReference(input.repo);
  if (claimed) {
    const repoRows = await db
      .select({ projectId: projectWorkspaces.projectId, repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.isPrimary, true),
          inArray(
            projectWorkspaces.projectId,
            usable.map((row) => row.projectId),
          ),
        ),
      );
    const matching = usable.filter((candidate) =>
      repoRows.some((row) => {
        if (row.projectId !== candidate.projectId) return false;
        const registered = parseGitHubRepoReference(row.repoUrl);
        return Boolean(registered && registered.owner === claimed.owner && registered.name === claimed.name);
      }),
    );
    if (matching.length === 1) {
      return {
        branches: { ...matching[0], resolvedViaFallback: true },
        issueHasProject: false,
        reason: "resolved_by_repo",
      };
    }
  }

  return { branches: null, issueHasProject: false, reason: "ambiguous" };
}
