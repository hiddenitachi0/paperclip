import { and, eq, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { secretService } from "./secrets.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ResolveHeadCommitDeps = {
  fetchImpl?: FetchLike;
  resolveGitHubToken?: (companyId: string) => Promise<string | null>;
};

function parseRepo(repo: unknown): { owner: string; name: string } | null {
  if (typeof repo !== "string") return null;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, name: name.replace(/\.git$/i, "") };
}

async function resolveDeps(
  db: Db,
  companyId: string,
  deps: ResolveHeadCommitDeps,
): Promise<{ fetchImpl: FetchLike; token: string | null }> {
  const fetchImpl = deps.fetchImpl ?? ghFetch;
  const resolveGitHubToken =
    deps.resolveGitHubToken ??
    ((cid: string) =>
      secretService(db).resolveGitHubToken(cid, { consumerType: "system", consumerId: "merge-card-head-commit" }));
  const token = await resolveGitHubToken(companyId).catch(() => null);
  return { fetchImpl, token };
}

/**
 * DUR-4601: a `merge_pr` card's `payload.commit` used to be entirely filer-supplied -- an
 * agent filing one with only `prNumber`/`url` left it unset forever, so "Request security
 * review" (security-review.ts's `requestReview`/`recordVerdict`) could never pass its
 * `mergePrHeadCommit` check. Resolves the PR's current head sha straight from GitHub, the
 * same `/pulls/{n}` call `merge-deploy-visibility.ts` already makes for merge verification.
 * Never throws: an unresolvable repo/PR or an unreachable GitHub is reported as `null`, which
 * every caller below treats as "leave whatever is already on the card alone."
 */
export async function resolvePullRequestHeadCommit(
  payload: Record<string, unknown>,
  deps: { fetchImpl: FetchLike; token: string | null },
): Promise<string | null> {
  const repo = parseRepo(payload.repo);
  const prNumber =
    typeof payload.prNumber === "number" || typeof payload.prNumber === "string" ? Number(payload.prNumber) : NaN;
  if (!repo || !Number.isFinite(prNumber) || prNumber <= 0) return null;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-card-head-commit",
    "x-github-api-version": "2022-11-28",
  };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;

  try {
    const response = await deps.fetchImpl(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${prNumber}`,
      { headers },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const head = body.head as Record<string, unknown> | undefined;
    const sha = typeof head?.sha === "string" ? head.sha.trim() : "";
    return sha || null;
  } catch {
    return null;
  }
}

export const MERGE_CARD_HEAD_UNREADABLE_MESSAGE =
  "Could not read this pull request's latest commit from GitHub. Try again in a minute, or include the commit.";

export function describeStaleMergeCardCommit(named: string, head: string) {
  return `This card names commit ${named}, but the pull request is now at ${head}. File the card for ${head}.`;
}

/**
 * DUR-5222: a `merge_pr` card is only ever stored with the pull request's real, current head
 * commit. Used when a card is filed and when it is resubmitted (both bodies are caller-controlled).
 *  - no commit named: GitHub's current head is looked up and stored;
 *  - a commit named: it must be GitHub's current head (a full sha, or a 7+ character prefix of
 *    it, which is stored in full); a different one is refused as stale;
 *  - GitHub cannot be read: filing is refused. A head is never guessed.
 * Returns the original object when there is nothing to look up (not a merge_pr card, or the
 * payload names no repo / pull request number to look up).
 */
export async function withResolvedMergePrHeadCommit(
  db: Db,
  companyId: string,
  payload: Record<string, unknown>,
  deps: ResolveHeadCommitDeps = {},
): Promise<Record<string, unknown>> {
  if (payload.kind !== "merge_pr") return payload;
  const prNumber =
    typeof payload.prNumber === "number" || typeof payload.prNumber === "string" ? Number(payload.prNumber) : NaN;
  if (!parseRepo(payload.repo) || !Number.isFinite(prNumber) || prNumber <= 0) return payload;
  const named = typeof payload.commit === "string" ? payload.commit.trim() : "";
  const head = await resolvePullRequestHeadCommit(payload, await resolveDeps(db, companyId, deps));
  if (!head) throw unprocessable(MERGE_CARD_HEAD_UNREADABLE_MESSAGE, { reason: "github_head_unreadable" });
  if (named) {
    const lowerNamed = named.toLowerCase();
    const lowerHead = head.toLowerCase();
    const matches = lowerNamed === lowerHead || (lowerNamed.length >= 7 && lowerHead.startsWith(lowerNamed));
    if (!matches) {
      throw unprocessable(describeStaleMergeCardCommit(named, head), {
        reason: "merge_card_commit_stale",
        named,
        head,
      });
    }
  }
  return { ...payload, commit: head };
}

/**
 * Re-resolves and persists the live head commit for an already-filed `merge_pr` approval --
 * used to both fill a missing one and refresh a present one that has since moved (a later
 * push on the same PR), which is what lets `computeState`'s `stale` check in
 * security-review.ts ever see a card go `out_of_date`. Fails open: on any GitHub failure (or
 * nothing to resolve), returns the approval's existing payload/commit unchanged.
 */
export async function refreshMergePrHeadCommit(
  db: Db,
  approval: { id: string; companyId: string; payload: unknown },
  deps: ResolveHeadCommitDeps = {},
): Promise<{ payload: Record<string, unknown>; headCommit: string | null }> {
  const payload = (approval.payload && typeof approval.payload === "object" ? approval.payload : {}) as Record<
    string,
    unknown
  >;
  if (payload.kind !== "merge_pr") {
    return { payload, headCommit: null };
  }
  const existing = typeof payload.commit === "string" ? payload.commit.trim() : "";
  const resolved = await resolvePullRequestHeadCommit(payload, await resolveDeps(db, approval.companyId, deps));
  if (!resolved || resolved === existing) {
    return { payload, headCommit: existing || null };
  }
  const nextPayload = { ...payload, commit: resolved };
  await db
    .update(approvals)
    .set({ payload: nextPayload, updatedAt: new Date() })
    .where(and(eq(approvals.id, approval.id), eq(approvals.companyId, approval.companyId)));
  return { payload: nextPayload, headCommit: resolved };
}

/**
 * DUR-4601: one-shot backfill for `merge_pr` cards filed before this module existed that are
 * still open (`status: "pending"`) with no `payload.commit` at all -- every such card was
 * otherwise permanently stuck, unable to ever request or record a security review. Idempotent
 * (a no-op once every open card has a commit); called once at server startup.
 */
export async function backfillOpenMergeCardHeadCommits(
  db: Db,
  deps: ResolveHeadCommitDeps = {},
): Promise<{ checked: number; resolved: number }> {
  const rows = await db
    .select({ id: approvals.id, companyId: approvals.companyId, payload: approvals.payload })
    .from(approvals)
    .where(
      and(
        eq(approvals.type, "request_board_approval"),
        eq(approvals.status, "pending"),
        sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
        sql`coalesce(${approvals.payload} ->> 'commit', '') = ''`,
      ),
    );
  let resolved = 0;
  for (const row of rows) {
    const result = await refreshMergePrHeadCommit(db, row, deps);
    if (result.headCommit) resolved += 1;
  }
  return { checked: rows.length, resolved };
}
