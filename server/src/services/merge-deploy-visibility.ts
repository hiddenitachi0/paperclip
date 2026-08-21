import { and, eq, lte, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { resolveProjectDeployBranches } from "./deploy-branches.js";
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
  return merged ? { status: "merged" } : { status: "unmerged" };
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
    fetch?: FetchLike;
    verifyMerge?: (
      payload: Record<string, unknown>,
      companyId: string,
    ) => Promise<MergeVerificationResult>;
  } = {},
) {
  const delayMs = options.delayMs ?? MERGE_DEPLOY_VISIBILITY_DELAY_MS;
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

  async function markNoted(approvalId: string, payload: Record<string, unknown>) {
    await db
      .update(approvals)
      .set({ payload: { ...payload, deployVisibilityNoted: true }, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
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

  async function tick(now = new Date()) {
    const cutoff = new Date(now.getTime() - delayMs);
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
        ),
      )
      .limit(50);

    let checked = 0;
    let flagged = 0;

    for (const approval of dueApprovals) {
      checked += 1;
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      const base = typeof payload.base === "string" ? payload.base.trim() : "";

      const linkedIssues = base
        ? await issueApprovalsSvc.listIssuesForApproval(approval.id)
        : [];
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);

      if (base && linkedIssueIds.length > 0) {
        const branches = await resolveProjectDeployBranches(db, linkedIssueIds);
        if (branches?.deployBranch && base === branches.deployBranch) {
          const verification = await verifyMerge(payload, approval.companyId);

          if (verification.status === "merged") {
            const alreadyDeployed = await hasFollowingDeployApproval(linkedIssueIds);
            if (!alreadyDeployed) {
              flagged += 1;
              for (const issueId of linkedIssueIds) {
                await issuesSvc.addComment(
                  issueId,
                  `This merged into "${branches.deployBranch}", the branch we deploy from, over ` +
                    `${Math.round(delayMs / 60000)} minutes ago. No deploy approval has been filed for ` +
                    "it yet, so it has not gone live.",
                  {},
                  { authorType: "system" },
                );
              }
            }
          } else if (verification.status === "unmerged") {
            // Confirmed via GitHub that no merge happened — this is the
            // "approved but never acted on" gap DUR-46 also asked to close.
            // Say so plainly rather than leaving it silent.
            flagged += 1;
            for (const issueId of linkedIssueIds) {
              await issuesSvc.addComment(
                issueId,
                `An approval to merge into "${branches.deployBranch}", the branch we deploy from, was ` +
                  `approved over ${Math.round(delayMs / 60000)} minutes ago, but the linked pull request ` +
                  "does not appear to have been merged. Nothing has deployed for it.",
                {},
                { authorType: "system" },
              );
            }
          }
          // verification.status === "unknown": no evidence either way (missing
          // PR reference, GitHub unreachable, auth failure) — say nothing
          // rather than guess.
        }
      }

      await markNoted(approval.id, payload);
    }

    return { checked, flagged };
  }

  return { tick };
}
