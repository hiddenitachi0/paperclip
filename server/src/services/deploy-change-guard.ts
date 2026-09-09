import type { Db } from "@paperclipai/db";
import { readProjectDeployHistory } from "./deploy-history.js";
import type { DeployRunnerStatusEntry } from "./deploy-runner-status.js";

/**
 * Pointless deploy cards: refuse deploy cards that cannot deploy, or would deploy nothing.
 *
 * An agent filed six deploy cards in a row that the operator had to reject one
 * by one: a mistyped commit id, commits that were already live, a commit whose
 * only difference from the live one was documentation, and commits from a
 * rewritten branch history the deploy runner refuses anyway. None of those were
 * visible on the card -- every one of them looked like an ordinary deploy, and
 * only a person who went and read the repository could tell.
 *
 * This module holds the parts of that check that do not need GitHub: which
 * version is live right now (read from the deploy runner's own status log, the
 * same source deploy-history.ts uses), which changed files count as
 * documentation, and the plain-language wording of each refusal. The GitHub
 * lookups themselves live next to the DUR-227 ancestry pre-check in
 * server/src/routes/approvals.ts, which owns the repo/token plumbing.
 *
 * Everything here is advisory-safe: the caller fails OPEN (files the card) when
 * the live version, the repository or GitHub cannot be resolved -- an
 * unreachable GitHub must never become a reason a real deploy cannot be asked
 * for.
 */

/** How many changed paths get stamped onto the card so it can say what changes. */
export const DEPLOY_CHANGED_FILES_STAMP_LIMIT = 12;

/**
 * GitHub's compare endpoint returns at most 300 files. At (or above) that many
 * changed files the list is not the whole truth, so the "only documentation
 * changed" conclusion is not safe to draw from it -- and a 300-file diff is
 * never documentation-only in practice anyway.
 */
export const GITHUB_COMPARE_FILE_LIMIT = 300;

export type DeployChangeSummary = {
  /** The version live right now, per the deploy runner's status log. */
  liveCommit: string;
  /** How many files differ between the live version and the requested one. */
  changedFileCount: number;
  /** The first few of those paths, for the card to show. */
  changedFiles: string[];
  /** True when every changed file is documentation (nothing would change for a user). */
  documentationOnly: boolean;
};

/**
 * Which version of this project is live right now. Reads the deploy runner's
 * status log through deploy-history.ts (only real, health-checked deploys
 * count), and returns null whenever that cannot be determined -- a project that
 * has never deployed, a status log the server cannot read, or any error at all.
 * Never throws: not knowing what is live must not stop a card being filed.
 */
export async function resolveLiveDeployCommit(
  db: Db,
  companyId: string,
  projectId: string,
  deps: { readStatusLog?: (companyId: string) => DeployRunnerStatusEntry[] } = {},
): Promise<string | null> {
  try {
    const history = await readProjectDeployHistory(db, companyId, projectId, deps);
    const commit = history.current?.commit?.trim();
    return commit ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Documentation, for the purposes of "would this deploy change anything a user
 * can see": anything named `*.md` (which covers PROJECT_STATUS.md), and
 * anything under a `docs/` folder.
 */
export function isDocumentationPath(path: string): boolean {
  const trimmed = path.trim().replace(/^\.\//, "");
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(".md")) return true;
  if (lower === "project_status.md") return true;
  if (lower.startsWith("docs/")) return true;
  if (lower.includes("/docs/")) return true;
  return false;
}

/**
 * Turn the changed paths GitHub reported into the summary stamped onto the
 * card. `documentationOnly` is deliberately false for an empty list only when
 * the caller says the list was truncated -- an empty diff genuinely changes
 * nothing, which the caller treats the same way as a documentation-only one.
 */
export function summarizeChangedPaths(
  liveCommit: string,
  paths: string[],
  options: { truncated?: boolean } = {},
): DeployChangeSummary {
  const unique = Array.from(new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)));
  const documentationOnly = options.truncated ? false : unique.every((path) => isDocumentationPath(path));
  return {
    liveCommit,
    changedFileCount: unique.length,
    changedFiles: unique.slice(0, DEPLOY_CHANGED_FILES_STAMP_LIMIT),
    documentationOnly,
  };
}

/** Commit ids are shown short everywhere an operator or an agent reads them. */
export function shortCommit(commit: string): string {
  const trimmed = commit.trim();
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function liveVersionClause(liveCommit: string | null): string {
  return liveCommit
    ? `The version running now is ${shortCommit(liveCommit)}.`
    : "We could not work out which version is running right now.";
}

/** (a) The commit is not in the repository at all -- almost always a typo. */
export function describeMissingDeployCommit(input: {
  commit: string;
  repo: string;
  liveCommit: string | null;
}): string {
  return (
    `There is no commit ${shortCommit(input.commit)} in ${input.repo}, so this card could never be deployed. ` +
    `${liveVersionClause(input.liveCommit)} ` +
    "Check the commit id you copied -- one wrong character is enough -- and file the card again with a commit " +
    "that is really in the repository."
  );
}

/** (b) The requested commit is already part of what is live. */
export function describeDeployCommitAlreadyLive(input: {
  commit: string;
  liveCommit: string;
  identical: boolean;
}): string {
  const requested = shortCommit(input.commit);
  const live = shortCommit(input.liveCommit);
  return input.identical
    ? `Commit ${requested} is exactly what is running now (${live}), so approving this card would change nothing. ` +
        "File a deploy card once there is newer work to ship."
    : `Commit ${requested} is already running: it is part of the version live now (${live}). ` +
        "Approving this card would change nothing. File a deploy card for a commit made after " +
        `${live} once there is newer work to ship.`;
}

/**
 * (c) The live version is not in the requested commit's history -- a rewritten
 * or sideways branch. The deploy runner refuses to move the checkout like that,
 * so the card would be approved and then do nothing.
 */
export function describeDeployCommitNotBuiltOnLive(input: {
  commit: string;
  liveCommit: string;
  deployBranch?: string | null;
}): string {
  const requested = shortCommit(input.commit);
  const live = shortCommit(input.liveCommit);
  const branchClause = input.deployBranch ? ` on "${input.deployBranch}"` : "";
  return (
    `Commit ${requested} is not built on top of what is running now (${live}), so the deploy would be refused ` +
    "and nothing would happen. This usually means the branch history was rewritten, or the commit comes from a " +
    `different line of work. Bring the running version ${live} back into the branch history${branchClause} first ` +
    "(merge it in, or redo the work on top of it), then file a new card with the commit that comes out of that."
  );
}

/** (d) Nothing but documentation changed since the live version. */
export function describeDocumentationOnlyDeploy(input: {
  commit: string;
  liveCommit: string;
  changedFiles: string[];
  changedFileCount?: number;
}): string {
  const requested = shortCommit(input.commit);
  const live = shortCommit(input.liveCommit);
  if (input.changedFileCount === 0 && input.changedFiles.length === 0) {
    return (
      `Nothing would change if this were approved: not a single file differs between the version running now ` +
      `(${live}) and commit ${requested}. A deploy restarts the site for no visible difference. File a deploy ` +
      "card when the code, the page templates or the database setup differ from what is running."
    );
  }
  const fileClause =
    input.changedFiles.length > 0
      ? ` The only difference is ${input.changedFiles.slice(0, 5).join(", ")}${input.changedFiles.length > 5 ? " and a few more notes files" : ""}.`
      : "";
  return (
    `Nothing would change if this were approved: between the version running now (${live}) and commit ` +
    `${requested} only written notes changed, no working parts.${fileClause} ` +
    "A deploy restarts the site for no visible difference. File a deploy card when the code, the page templates " +
    "or the database setup differ from what is running."
  );
}
