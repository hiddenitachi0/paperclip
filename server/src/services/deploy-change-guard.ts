import type { Db } from "@paperclipai/db";
import {
  DEPLOY_CHANGED_FILES_STAMP_LIMIT,
  DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH,
} from "@paperclipai/shared";
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

/**
 * How many changed paths get stamped onto the card so it can say what changes,
 * and how long each of those paths may be. Both live in
 * packages/shared/src/validators/approval.ts next to the schema that enforces
 * them, so the stamping site and the validator can never drift apart.
 */
export { DEPLOY_CHANGED_FILES_STAMP_LIMIT, DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH };

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
 * A single path, shortened so one very long repository path cannot bloat the
 * stored card. The end is kept, because that is where the file name is.
 */
export function shortenChangedPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH) return trimmed;
  return `...${trimmed.slice(trimmed.length - (DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH - 3))}`;
}

/**
 * Turn the changed paths GitHub reported into the summary stamped onto the
 * card. `documentationOnly` is deliberately false for an empty list only when
 * the caller says the list was truncated -- an empty diff genuinely changes
 * nothing, which the caller treats the same way as a documentation-only one.
 *
 * The stamped list is capped in both directions -- at most
 * DEPLOY_CHANGED_FILES_STAMP_LIMIT paths, each at most
 * DEPLOY_CHANGED_FILE_PATH_MAX_LENGTH characters -- so a deploy that touches a
 * thousand files, or one file with an absurdly long path, still writes a small,
 * fixed-size summary into the approval payload. `changedFileCount` keeps the
 * real total, so the card can still say "changes 812 files".
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
    changedFiles: unique.slice(0, DEPLOY_CHANGED_FILES_STAMP_LIMIT).map(shortenChangedPath),
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

/**
 * DUR-3964 (a): how long a commit id is when it is written out in full. Git's
 * own `rev-parse` prints all 40 characters; anything shorter is an abbreviation
 * that only means something inside one particular checkout.
 */
export const FULL_COMMIT_ID_LENGTH = 40;

const FULL_COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/i;

/** True only for a written-out 40-character commit id. */
export function isFullCommitId(value: string): boolean {
  return FULL_COMMIT_ID_PATTERN.test(value.trim());
}

/**
 * DUR-3964 (a): does this text contain something that looks like a commit id?
 *
 * Used only to word the refusal, never to decide it: the mistake actually made
 * was an agent writing the commit id into the card's note ("deploying 8623c28")
 * while leaving the card's own commit field empty, so the refusal should say
 * that in as many words instead of a generic "no commit id".
 *
 * Requires a run of 7-40 hex characters containing BOTH a digit and one of
 * a-f, which is what every real commit id looks like and what an ordinary
 * number ("1234567") or an ordinary word is not.
 */
export function findCommitIdLikeText(text: string): string | null {
  const match = text.match(/\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i);
  return match ? match[0] : null;
}

const HOW_TO_GET_THE_COMMIT_ID =
  "Run `git rev-parse HEAD` in the checkout you tested -- it prints the full 40-character commit id -- and file " +
  "the card again with that.";

/**
 * DUR-3964 (a): the card carries no commit id at all, so approving it would
 * deploy whatever happens to be at the top of the branch at that moment rather
 * than the change that was actually reviewed.
 */
export function describeDeployCardWithoutCommitId(input: { commitIdInText?: string | null }): string {
  const noteClause = input.commitIdInText
    ? `The card's own commit field is empty, even though its note mentions ${shortCommit(input.commitIdInText)} -- ` +
      "the note is just text, nothing reads it. "
    : "";
  return (
    "This deploy card does not say which commit to deploy. " +
    noteClause +
    "Approving it would ship whatever happens to be at the top of the branch at that moment, which may not be the " +
    `change that was checked. ${HOW_TO_GET_THE_COMMIT_ID}`
  );
}

/**
 * DUR-3964 (a): the card carries a shortened (or otherwise not-40-character)
 * commit id. A short id only means something inside one particular checkout,
 * and one wrong character in it is exactly how a deploy card ends up pointing
 * at a commit nobody reviewed.
 */
export function describeDeployCardPartialCommitId(input: { commit: string }): string {
  return (
    `"${input.commit}" is not a full commit id, so it does not pin down which change this card would deploy. ` +
    `A deploy card needs all ${FULL_COMMIT_ID_LENGTH} characters. ${HOW_TO_GET_THE_COMMIT_ID}`
  );
}

/**
 * DUR-3964 (c): the change on a merge card is already contained in the branch
 * it asks to merge into, so approving it would merge nothing.
 */
export function describeMergeCommitAlreadyInBase(input: { commit: string; base: string }): string {
  return (
    `That change is already merged into "${input.base}" -- commit ${shortCommit(input.commit)} is already part of ` +
    "it, so approving this card would merge nothing. If you want it live, file a deploy card with the commit id " +
    `${input.commit} instead.`
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
