import { and, eq, lte, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { resolveProjectDeployBranches, type ProjectDeployBranches } from "./deploy-branches.js";
import { resolveFallbackDeployBranches } from "./deploy-branch-fallback.js";
import { secretService } from "./secrets.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether a merge_pr approval's PR actually landed on its base branch.
 * "unknown" covers everything we can't confirm either way (no PR reference
 * on the payload, GitHub unreachable, a 404, an auth failure) — it must
 * never be treated as evidence of a merge.
 */
export type MergeVerificationStatus = "merged" | "unmerged" | "unknown";

export interface MergeVerificationResult {
  status: MergeVerificationStatus;
  reason?: string;
  // DUR-237: GitHub's own merge commit sha for a `merged` result. Persisted onto the approval's
  // payload so deploy-completion-gate.ts can later recognize this issue as deployed by matching
  // this commit against ANY project deploy that shipped it — not only a deploy approval that
  // happens to be linked to this specific issue (the root cause of NOR-217-style false blocks:
  // the exact commit went live under a sibling issue's deploy approval, but the gate only ever
  // looked at approvals linked to the issue asking to close).
  mergeCommitSha?: string;
}

function parseRepo(repo: unknown): { owner: string; name: string } | null {
  if (typeof repo !== "string") return null;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * DUR-46: check GitHub directly for whether the PR a merge_pr approval
 * references was actually merged, instead of inferring it from the
 * approval's own status. Approving a merge_pr approval only authorizes a
 * merge — it does not perform one, and nothing else in this codebase
 * verified that the agent ever followed through.
 */
async function verifyPullRequestMerged(
  payload: Record<string, unknown>,
  deps: { fetchImpl: FetchLike; token: string | null },
): Promise<MergeVerificationResult> {
  const repo = parseRepo(payload.repo);
  const prNumber = typeof payload.prNumber === "number" ? payload.prNumber : Number(payload.prNumber);
  if (!repo || !Number.isFinite(prNumber) || prNumber <= 0) {
    return { status: "unknown", reason: "missing_pr_reference" };
  }

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-deploy-visibility",
    "x-github-api-version": "2022-11-28",
  };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;

  let response: Response;
  try {
    response = await deps.fetchImpl(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${prNumber}`,
      { headers },
    );
  } catch {
    return { status: "unknown", reason: "github_fetch_failed" };
  }

  if (!response.ok) {
    return { status: "unknown", reason: `github_http_${response.status}` };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { status: "unknown", reason: "github_invalid_response" };
  }
  if (!body) return { status: "unknown", reason: "github_invalid_response" };

  const merged = body.merged === true || Boolean(body.merged_at);
  if (!merged) return { status: "unmerged" };
  const mergeCommitSha = typeof body.merge_commit_sha === "string" ? body.merge_commit_sha : undefined;
  return { status: "merged", mergeCommitSha };
}

/**
 * How long to wait after a merge_pr approval into a project's declared deploy
 * branch before flagging a missing deploy approval. Gives the filing agent's
 * run a reasonable window to file the deploy approval itself (per the DUR-40
 * standing delivery rule: "after any merge into the deploy branch, either
 * file the deploy approval in the same run or record on the issue why you
 * are deliberately deferring") before the system assumes it was forgotten.
 */
export const MERGE_DEPLOY_VISIBILITY_DELAY_MS = 30 * 60 * 1000;

/**
 * DUR-3928/DUR-3944: a merge_pr approval whose PR has not merged yet at check time used to be
 * checked exactly once and then marked noted forever -- with no `mergeCommitSha`, which both
 * deploy-completion-gate.ts and deploy-carried-issues.ts hard-require. Two live approvals
 * (PR #248, PR #256) got stuck that way because their PRs merged 15-20 minutes AFTER the one
 * and only check. Re-checks now back off from `delayMs` (30 min) doubling up to this cap ...
 */
export const MERGE_DEPLOY_VISIBILITY_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** ... and stop for good once the approval is this old (bounded: a PR that never merges). */
export const MERGE_DEPLOY_VISIBILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How many already-noted-but-sha-less legacy approvals to re-check per tick (see tick()). */
export const MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_LIMIT = 20;
/** Give up on a legacy re-check after this many attempts (GitHub down, no token, ...). */
export const MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_MAX_ATTEMPTS = 5;

/**
 * Delay before re-checking an approval that has already been checked `attempts` times:
 * base, 2x, 4x, ... capped at `maxMs`. With the defaults: 30m, 1h, 2h, 4h, 6h, 6h, ...
 */
export function mergeDeployVisibilityRetryDelayMs(
  attempts: number,
  baseMs = MERGE_DEPLOY_VISIBILITY_DELAY_MS,
  maxMs = MERGE_DEPLOY_VISIBILITY_RETRY_MAX_MS,
): number {
  const exponent = Math.min(Math.max(Math.floor(attempts), 1) - 1, 20);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

function readAttempts(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readTimestamp(payload: Record<string, unknown>, key: string): Date | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface MergeDeployVisibilityTickResult {
  /** Due approvals looked at this tick. */
  checked: number;
  /** Notes posted on issues (missing deploy approval, not-merged-yet, gave up). */
  flagged: number;
  /** Approvals left in the queue for a later re-check with a backoff. */
  retried: number;
  /** Approvals that hit the age bound and were marked noted without a merge. */
  gaveUp: number;
  /** Legacy noted approvals whose merge commit sha was backfilled this tick. */
  backfilled: number;
}

/**
 * DUR-40 item 4: DUR-38 was marked `done` after its merge_pr approval landed
 * on the deploy branch, but no deploy approval was ever filed, so the
 * feature never went live — and nothing on the issue said so. This service
 * closes that gap with a scheduled check (the same shape as the issue
 * monitor / scheduled-retry mechanisms elsewhere in this codebase, but
 * intentionally NOT wired into `tickDueIssueMonitors` / `IssueExecutionMonitorPolicy`:
 * that machinery exists to wake an assigned agent to go investigate
 * something external, and requires a strict `kind` ("external_service" |
 * "goal_condition") plus an in-progress/in-review agent-assigned issue. A
 * passive "did a deploy approval follow this merge" check has none of those
 * preconditions, so it gets its own tiny periodic tick — the same pattern
 * `routines.tickScheduledTriggers` already uses alongside `heartbeat.tickTimers`
 * in server/src/index.ts, rather than forcing a second, incompatible concern
 * into the issue-monitor union).
 *
 * DUR-46: the original version of this service asserted "This merged into
 * X" for every *approved* merge_pr approval whose base matched the deploy
 * branch — but approving a merge_pr approval only authorizes a merge, it
 * doesn't perform one. Two synthetic verification approvals (pointing at a
 * branch that never existed) got flagged as real merges, and a genuine
 * unmerged-but-approved case would go silently forgotten. This now checks
 * GitHub for whether the referenced PR was actually merged before making
 * any claim, and never states a merge happened without that evidence.
 *
 * Scheduling state lives entirely on the approval row itself
 * (`payload.deployVisibilityNoted`), so no new columns/migrations are needed.
 */
export function mergeDeployVisibilityService(
  db: Db,
  options: {
    delayMs?: number;
    retryMaxMs?: number;
    maxAgeMs?: number;
    legacyRecheckLimit?: number;
    fetch?: FetchLike;
    verifyMerge?: (
      payload: Record<string, unknown>,
      companyId: string,
    ) => Promise<MergeVerificationResult>;
  } = {},
) {
  const delayMs = options.delayMs ?? MERGE_DEPLOY_VISIBILITY_DELAY_MS;
  const retryMaxMs = options.retryMaxMs ?? MERGE_DEPLOY_VISIBILITY_RETRY_MAX_MS;
  const maxAgeMs = options.maxAgeMs ?? MERGE_DEPLOY_VISIBILITY_MAX_AGE_MS;
  const legacyRecheckLimit = options.legacyRecheckLimit ?? MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_LIMIT;
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const fetchImpl = options.fetch ?? ghFetch;
  const verifyMerge =
    options.verifyMerge ??
    (async (payload: Record<string, unknown>, companyId: string) => {
      const token = await secretsSvc
        .resolveGitHubToken(companyId, { consumerType: "system", consumerId: "merge-deploy-visibility" })
        .catch(() => null);
      return verifyPullRequestMerged(payload, { fetchImpl, token });
    });

  async function markNoted(
    approvalId: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    // Final: drop the retry schedule so the row reads as settled, not "due later".
    const { deployVisibilityNextCheckAt: _nextCheckAt, ...rest } = payload;
    await db
      .update(approvals)
      .set({ payload: { ...rest, ...extra, deployVisibilityNoted: true }, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
  }

  async function scheduleRecheck(
    approvalId: string,
    payload: Record<string, unknown>,
    attempts: number,
    nextCheckAt: Date,
    extra: Record<string, unknown> = {},
  ) {
    await db
      .update(approvals)
      .set({
        payload: {
          ...payload,
          ...extra,
          deployVisibilityAttempts: attempts,
          deployVisibilityNextCheckAt: nextCheckAt.toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  }

  async function resolveBranchesForApproval(
    approval: { companyId: string },
    linkedIssueIds: string[],
    base: string,
    payload: Record<string, unknown>,
  ): Promise<ProjectDeployBranches | null> {
    const viaProject = await resolveProjectDeployBranches(db, linkedIssueIds);
    if (viaProject) return viaProject;
    // DUR-291: an issue with no project used to make this a silent no-op, which also meant
    // its merge commit sha was never backfilled -- and the done-gate's cross-issue match
    // (deploy-completion-gate.ts) could then never recognise the change as shipped.
    const fallback = await resolveFallbackDeployBranches(db, {
      companyId: approval.companyId,
      issueIds: linkedIssueIds,
      bases: [base],
      repo: payload.repo,
    });
    return fallback.branches;
  }

  async function hasFollowingDeployApproval(issueIds: string[]): Promise<boolean> {
    for (const issueId of issueIds) {
      const linked = await issueApprovalsSvc.listApprovalsForIssue(issueId);
      const hasDeployApproval = linked.some(
        (approval) =>
          approval.type === "request_board_approval" &&
          (approval.payload as Record<string, unknown> | null)?.kind === "deploy" &&
          approval.status !== "rejected",
      );
      if (hasDeployApproval) return true;
    }
    return false;
  }

  async function postToLinkedIssues(issueIds: string[], body: string) {
    for (const issueId of issueIds) {
      await issuesSvc.addComment(issueId, body, {}, { authorType: "system" });
    }
  }

  async function tick(now = new Date()): Promise<MergeDeployVisibilityTickResult> {
    const cutoff = new Date(now.getTime() - delayMs);
    const nowIso = now.toISOString();
    const dueApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
          sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
          sql`(${approvals.payload} ->> 'deployVisibilityNoted') is distinct from 'true'`,
          sql`${approvals.decidedAt} is not null`,
          lte(approvals.decidedAt, cutoff),
          // DUR-3928: an approval scheduled for a later re-check is not due yet. NULL (never
          // scheduled) is due.
          sql`coalesce((${approvals.payload} ->> 'deployVisibilityNextCheckAt')::timestamptz <= ${nowIso}::timestamptz, true)`,
        ),
      )
      .limit(50);

    let checked = 0;
    let flagged = 0;
    let retried = 0;
    let gaveUp = 0;

    for (const approval of dueApprovals) {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      // Belt and braces for the SQL filter above (and for callers whose db doesn't apply it).
      const nextCheckAt = readTimestamp(payload, "deployVisibilityNextCheckAt");
      if (nextCheckAt && nextCheckAt.getTime() > now.getTime()) continue;
      checked += 1;

      const base = typeof payload.base === "string" ? payload.base.trim() : "";

      const linkedIssues = base
        ? await issueApprovalsSvc.listIssuesForApproval(approval.id)
        : [];
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      let mergeCommitSha: string | undefined;
      // Whether it's safe to permanently stop re-checking this approval. Default true
      // (every branch below that reaches a final answer, or never had enough on the payload
      // to check at all); flipped to false for any verification result that might resolve
      // differently on a later tick -- "unmerged" included (DUR-3928: PRs routinely merge
      // later than 30 minutes after the approval; a one-shot check permanently lost their
      // merge commit sha).
      let isFinal = true;
      const extra: Record<string, unknown> = {};
      let deployBranchLabel = base;

      if (base && linkedIssueIds.length > 0) {
        const branches = await resolveBranchesForApproval(approval, linkedIssueIds, base, payload);
        if (branches?.deployBranch && base === branches.deployBranch) {
          deployBranchLabel = branches.deployBranch;
          const verification = await verifyMerge(payload, approval.companyId);

          if (verification.status === "merged") {
            mergeCommitSha = verification.mergeCommitSha;
            const alreadyDeployed = await hasFollowingDeployApproval(linkedIssueIds);
            if (!alreadyDeployed) {
              flagged += 1;
              await postToLinkedIssues(
                linkedIssueIds,
                `This merged into "${branches.deployBranch}", the branch we deploy from, over ` +
                  `${Math.round(delayMs / 60000)} minutes ago. No deploy approval has been filed for ` +
                  "it yet, so it has not gone live.",
              );
            }
          } else if (verification.status === "unmerged") {
            // Confirmed via GitHub that no merge has happened YET. Say so plainly once (the
            // "approved but never acted on" gap DUR-46 asked to close), then keep checking
            // with a backoff instead of giving up on the first look.
            isFinal = false;
            if (payload.deployVisibilityUnmergedNoted !== true) {
              flagged += 1;
              extra.deployVisibilityUnmergedNoted = true;
              await postToLinkedIssues(
                linkedIssueIds,
                `An approval to merge into "${branches.deployBranch}", the branch we deploy from, was ` +
                  `approved over ${Math.round(delayMs / 60000)} minutes ago, but the linked pull request ` +
                  "has not been merged yet. Nothing has deployed for it so far. I will keep checking " +
                  "and note here once it merges.",
              );
            }
          }
          // verification.status === "unknown": no evidence either way. Say
          // nothing rather than guess -- and if the cause could plausibly
          // resolve on a later tick (network blip, rate limit, an auth token
          // that wasn't provisioned yet), leave it un-noted so this approval
          // is picked up again instead of being silently stuck forever. Only
          // a structurally unresolvable payload (no PR reference at all) is
          // final: DUR-237 hit exactly this live -- a transient GitHub check
          // failure got treated as final and permanently prevented the
          // done-gate's cross-issue ancestry match from ever seeing this
          // approval's merge commit.
          else if (verification.status === "unknown" && verification.reason !== "missing_pr_reference") {
            isFinal = false;
          }
        }
      }

      if (isFinal) {
        await markNoted(approval.id, payload, { ...extra, ...(mergeCommitSha ? { mergeCommitSha } : {}) });
        continue;
      }

      const attempts = readAttempts(payload, "deployVisibilityAttempts") + 1;
      const decidedAtMs = approval.decidedAt ? new Date(approval.decidedAt).getTime() : now.getTime();
      if (now.getTime() - decidedAtMs >= maxAgeMs) {
        // Bounded: stop re-checking a PR that never merges. Say so, once, rather than
        // silently dropping it -- and never invent a merge commit for it.
        gaveUp += 1;
        flagged += 1;
        await postToLinkedIssues(
          linkedIssueIds,
          `I checked for ${Math.round(maxAgeMs / (24 * 60 * 60 * 1000))} days whether the pull request ` +
            `behind the approved merge into "${deployBranchLabel}" merged, and could not confirm that it ` +
            "did. I have stopped checking. Nothing has deployed for it. If it does merge later, file a " +
            "deploy approval for it so the change actually goes live.",
        );
        await markNoted(approval.id, payload, {
          ...extra,
          deployVisibilityAttempts: attempts,
          deployVisibilityGaveUpAt: nowIso,
        });
        continue;
      }

      retried += 1;
      await scheduleRecheck(
        approval.id,
        payload,
        attempts,
        new Date(now.getTime() + mergeDeployVisibilityRetryDelayMs(attempts, delayMs, retryMaxMs)),
        extra,
      );
    }

    const backfilled = await recheckLegacyNotedApprovals(now);

    return { checked, flagged, retried, gaveUp, backfilled };
  }

  /**
   * DUR-3928/DUR-3944: approvals that the one-shot version of this service already marked
   * noted WITHOUT a merge commit sha (PR #248 / #256 are the two confirmed live victims) stay
   * stuck forever otherwise -- deploy-carried-issues.ts and the done-gate both need that sha.
   * Re-check each such approval against GitHub, a bounded number of times, and backfill the
   * sha silently when the PR did merge. No comments: whatever this service had to say about
   * these approvals was said when they were first noted.
   */
  async function recheckLegacyNotedApprovals(now: Date): Promise<number> {
    if (legacyRecheckLimit <= 0) return 0;
    const legacyApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
          sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
          sql`(${approvals.payload} ->> 'deployVisibilityNoted') = 'true'`,
          sql`(${approvals.payload} ->> 'mergeCommitSha') is null`,
          sql`(${approvals.payload} ->> 'mergeCommitShaRecheckedAt') is null`,
          sql`(${approvals.payload} ->> 'prNumber') is not null`,
          sql`(${approvals.payload} ->> 'repo') is not null`,
        ),
      )
      .limit(legacyRecheckLimit);

    let backfilled = 0;
    for (const approval of legacyApprovals) {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.mergeCommitSha === "string" || typeof payload.mergeCommitShaRecheckedAt === "string") continue;
      const attempts = readAttempts(payload, "mergeCommitShaRecheckAttempts") + 1;
      const verification = await verifyMerge(payload, approval.companyId);
      const settled =
        verification.status === "merged" ||
        verification.status === "unmerged" ||
        verification.reason === "missing_pr_reference" ||
        attempts >= MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_MAX_ATTEMPTS;
      const extra: Record<string, unknown> = { mergeCommitShaRecheckAttempts: attempts };
      if (verification.status === "merged" && verification.mergeCommitSha) {
        extra.mergeCommitSha = verification.mergeCommitSha;
        backfilled += 1;
      }
      if (settled) extra.mergeCommitShaRecheckedAt = now.toISOString();
      await db
        .update(approvals)
        .set({ payload: { ...payload, ...extra }, updatedAt: new Date() })
        .where(eq(approvals.id, approval.id));
    }
    return backfilled;
  }

  return { tick };
}
