import { execFile } from "node:child_process";
import { serverChildProcessEnv } from "./runtime-env.js";
import { promisify } from "node:util";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveIssueWorkspaceCheckout } from "./self-review-gate.js";

const execFileAsync = promisify(execFile);

/**
 * DUR-3987: "done" must not cite work that only exists on one machine.
 *
 * On 15 Sep 2026 a Nordstrand agent committed 0409513 in the project's SHARED checkout and
 * never pushed it. Forty-six minutes later another agent's run did `reset: moving to
 * origin/main` in that same checkout and the commit became unreachable. A third agent then
 * closed the issue as "deployed and verified", naming that commit. The work was gone, the
 * issue said done, and only a human reading the reflog found it.
 *
 * DUR-3975's push guard could not help: it refuses a push that would overwrite someone
 * else's, and nothing here was ever pushed. This gate closes the other half -- before an
 * AGENT may move an issue to `done` while naming a commit, that commit has to be in the
 * shared repository.
 *
 * Scope, deliberately narrow (same split self-review-gate.ts and deploy-completion-gate.ts
 * already draw -- this guards agent self-certification, never operator authority):
 * - Only an AGENT-authored transition into `done`. A board/human actor is never gated.
 * - Only when the agent's own done note NAMES a commit. An issue whose note names none is
 *   not this gate's business; there are other gates for "is the work finished".
 * - Only the done note itself is read: the comment carried on the PATCH, or -- when the
 *   PATCH carries none -- that agent's most recent comment on the issue. Deliberately not
 *   the whole comment history: an old comment may legitimately name a scratch commit that
 *   was never meant to ship, and refusing on that would be a dead end the agent cannot
 *   clear by doing the right thing now.
 * - Only when the issue resolves to a local git checkout to check against. No checkout
 *   (cloud/adapter-managed workspace, path gone) means "couldn't check", and the
 *   transition goes through.
 *
 * Verdicts, and why they differ:
 * - Any named commit reachable from a remote-tracking ref -> PASS. The agent named work
 *   that is in the shared repository; the other shas in the note are not nitpicked.
 * - Every named commit exists in the checkout but is on NO remote ref -> REFUSE. This is
 *   exactly the 15 Sep failure, and it is recoverable in one step: push it, or name the
 *   commit that actually went to the shared repository.
 * - Every named commit is unknown to the checkout -> WARN ONLY, never refuse. A commit
 *   this repository has never heard of is just as likely a sha from another repository
 *   (agents cite dashboard commits on platform issues all the time) as a fabricated one,
 *   and this gate cannot tell those apart. Refusing would block honest work; saying so on
 *   the issue leaves the trail a human needs.
 *
 * A squash merge is the one honest way a pushed-and-shipped commit stays off every remote
 * ref (the sha on origin is a different one). That is why the refusal message says "or name
 * the commit that went to the shared repository" rather than "push this" alone, and why a
 * single on-origin sha anywhere in the note is enough to pass.
 */

// Only shas introduced with commit-ish wording, plus bare full-length shas. A loose "any 7+
// hex run" match would fire on ids, hashes and checksums that have nothing to do with git.
const COMMIT_MENTION_PATTERNS: readonly RegExp[] = [
  /\b(?:commit|sha|revision|rev|pushed|merged|deployed|shipped)\s+(?:is\s+|as\s+|at\s+)?`?([0-9a-f]{7,40})`?\b/gi,
  /\b([0-9a-f]{40})\b/g,
];

// `git log --format=%H` on a huge history is not this gate's job; every command here is
// O(refs) or a single object lookup, and a wedged git must not hold a PATCH open.
const GIT_TIMEOUT_MS = 10_000;

export type NamedCommitState = "on_remote" | "local_only" | "unknown_to_repo";

export type OriginCommitGateResult = {
  message: string;
  /** true -> post the message on the issue after the transition; false -> refuse with 409. */
  warningOnly: boolean;
  reason: "local_only" | "unknown_to_repo";
  commits: string[];
};

/**
 * Pulls the commit shas an agent named in its done note. Deduplicated, lowercased, and
 * capped -- a note that names fifty shas gets the first few checked, not fifty git calls.
 */
export function extractNamedCommits(body: string | null | undefined, maxCommits = 5): string[] {
  if (!body) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of COMMIT_MENTION_PATTERNS) {
    // Each RegExp is module-level and stateful (`g`), so reset before reuse.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const sha = match[1]?.toLowerCase();
      if (!sha || seen.has(sha)) continue;
      // A prefix of an already-named sha is the same commit written two ways.
      if (found.some((existing) => existing.startsWith(sha) || sha.startsWith(existing))) continue;
      seen.add(sha);
      found.push(sha);
      if (found.length >= maxCommits) return found;
    }
  }
  return found;
}

/**
 * Classifies one sha against a real checkout. `unknown_to_repo` covers both "never existed"
 * and "exists in another repository"; the caller treats it as unproven, not as proven bad.
 */
export async function classifyCommitAgainstCheckout(
  workspacePath: string,
  sha: string,
): Promise<NamedCommitState> {
  try {
    await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--quiet", "--verify", `${sha}^{commit}`], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
      env: serverChildProcessEnv(),
    });
  } catch {
    return "unknown_to_repo";
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "for-each-ref", "--contains", sha, "--count", "1", "--format=%(refname)", "refs/remotes/"],
      { cwd: workspacePath, timeout: GIT_TIMEOUT_MS, env: serverChildProcessEnv() },
    );
    return stdout.trim().length > 0 ? "on_remote" : "local_only";
  } catch {
    // The object is there but the reachability check itself failed (a `--contains` this git
    // cannot run, a broken ref). Unproven either way -- never refuse on it.
    return "unknown_to_repo";
  }
}

/** The agent's own most recent, still-visible comment on this issue. */
async function findLatestAgentComment(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<string | null> {
  const row = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.agentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.body ?? null;
}

function formatCommitList(commits: readonly string[]): string {
  const shortened = commits.map((sha) => sha.slice(0, 12));
  if (shortened.length === 1) return shortened[0]!;
  return `${shortened.slice(0, -1).join(", ")} and ${shortened[shortened.length - 1]}`;
}

export async function evaluateOriginCommitDoneGate(input: {
  db: Db;
  issue: { id: string; identifier: string | null; companyId: string };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  patchComment: string | null;
}): Promise<OriginCommitGateResult | null> {
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
  if (input.requestedStatus !== "done" || input.currentStatus === "done") return null;
  try {
    return await checkNamedCommits(input);
  } catch (err) {
    // Fails OPEN, always. This gate runs inside the PATCH that closes a task, and the worst
    // thing it could do is make finishing work impossible because a git call, a lookup or a
    // workspace path misbehaved. Every deliberate "couldn't check" path above already
    // returns null; this catches the ones nobody thought of.
    logger.warn(
      { err, issueId: input.issue.id, companyId: input.issue.companyId },
      "origin-commit gate could not run; letting the transition through (DUR-3987)",
    );
    return null;
  }
}

async function checkNamedCommits(input: {
  db: Db;
  issue: { id: string; identifier: string | null; companyId: string };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  patchComment: string | null;
}): Promise<OriginCommitGateResult | null> {
  const doneNote =
    input.patchComment?.trim()
      ? input.patchComment
      : await findLatestAgentComment(input.db, {
          companyId: input.issue.companyId,
          issueId: input.issue.id,
          agentId: input.actor.agentId!,
        });

  const namedCommits = extractNamedCommits(doneNote);
  if (namedCommits.length === 0) return null;

  const checkout = await resolveIssueWorkspaceCheckout(input.db, {
    companyId: input.issue.companyId,
    issueId: input.issue.id,
  });
  if (!checkout) return null;

  const states = await Promise.all(
    namedCommits.map((sha) => classifyCommitAgainstCheckout(checkout.workspacePath, sha)),
  );
  if (states.includes("on_remote")) return null;

  const localOnly = namedCommits.filter((_, index) => states[index] === "local_only");
  if (localOnly.length > 0) {
    return {
      warningOnly: false,
      reason: "local_only",
      commits: localOnly,
      message: [
        `This task cannot be marked done yet. The change you named (${formatCommitList(localOnly)}) exists only in this working copy — it is not in the shared repository, so nobody else can see it and the next agent to reset this checkout would erase it.`,
        "Push the work to the shared repository and then mark the task done. If the change did reach the shared repository under a different commit (a squashed merge does that), say so and name that commit instead.",
      ].join(" "),
    };
  }

  return {
    warningOnly: true,
    reason: "unknown_to_repo",
    commits: namedCommits,
    message: `This task was marked done naming ${formatCommitList(namedCommits)}, which this project's working copy has never seen. That is normal when the change lives in another repository, but if it was meant to be this project's work, check it actually reached the shared repository before trusting this as finished.`,
  };
}
