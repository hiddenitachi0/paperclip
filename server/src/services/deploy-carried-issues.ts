import { and, eq, sql } from "drizzle-orm";
import { approvals, issueApprovals, issues, projectWorkspaces, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { resolveProjectDeployBranchesByProjectId } from "./deploy-branches.js";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { secretService } from "./secrets.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  DEPLOY_SUCCESS_MARKER,
  approvalPayloadKind,
  approvalPayloadMergeCommitSha,
  approvalPayloadProjectId,
  commitsMatch,
  extractDeployedCommit,
} from "./deploy-completion-gate.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * DUR-238: follow-up from DUR-237/DUR-99. deploy-completion-gate.ts answers "is THIS issue's
 * own done-gate satisfied" the moment its assignee happens to retry the PATCH -- but nothing
 * proactively told every OTHER issue riding the same deploy that it was now free to close, so
 * each one sat in `in_review` until its own agent happened to notice and retry (the actual
 * complaint this ticket writes up: "en utrulling skal lukke ALLE saker den frakter").
 *
 * Design decisions made here (the ticket explicitly asked for these to be made deliberately,
 * not left implicit):
 *
 * 1. WHICH issues qualify: same company + same project as the completed deploy approval,
 *    status is exactly `in_review` (never `todo`/`in_progress`/`blocked` -- this never
 *    initiates review, it only recognizes that an issue's OWN prior review already finished
 *    and it was waiting purely on deployment), with an approved `merge_pr` approval linked
 *    whose `base` matches the project's declared deploy branch and whose `mergeCommitSha` has
 *    been backfilled by merge-deploy-visibility.ts. That is exactly the signature
 *    deploy-completion-gate.ts's own docblock names as "the escape hatch already in wide use":
 *    an issue can only be sitting in this state because its completing action was a merge into
 *    the deploy branch. A commit is "carried" by a deploy when it exactly matches the deployed
 *    commit OR is a git ancestor of it (confirmed via GitHub's compare API, mirroring the same
 *    mechanism merge-deploy-visibility.ts and DUR-227's ancestry precheck already use) --
 *    unlike DUR-227's filing-time precheck, which fails OPEN on unknown ancestry because the
 *    risky direction there is blocking a human operator's deploy, this fails CLOSED: an issue
 *    is never auto-closed on unproven ancestry, only on a GitHub-confirmed "ahead"/"identical".
 *
 * 2. AUTO-CLOSE outright, not just gate-clearing: this calls `issueService(db).update` directly
 *    with a `status: "done"` patch rather than waiting for an agent-authenticated PATCH. That is
 *    deliberate, not a shortcut around the self-review / goal-condition / deploy-completion
 *    gates in routes/issues.ts -- all three already no-op unconditionally for any non-"agent"
 *    actor (`actor.actorType !== "agent"` short-circuits each one; see self-review-gate.ts,
 *    goal-condition-judge.ts, deploy-completion-gate.ts), the same "a board/human actor can
 *    always override" authority a human operator already exercises by flipping status in the
 *    UI. This tick exercises that identical, pre-existing authority class -- it does not invent
 *    a new one -- and only ever does so for an issue already sitting in `in_review`, i.e. one
 *    whose own review already concluded through whatever path put it there.
 *
 * 3. AUDIT TRAIL: a system-authored comment naming the exact deploy approval and commit that
 *    proved liveness is posted BEFORE the status flip, and the resulting status change is
 *    logged via `logActivity` the same way routes/issues.ts's PATCH handler logs one -- never a
 *    silent flip.
 *
 * Wired into the same periodic tick as mergeDeployVisibilityService (server/src/index.ts), not
 * `tickDueIssueMonitors` -- this is a passive "did a deploy just carry other issues" sweep with
 * none of the strict issue-monitor preconditions (agent-assigned, in-progress/in-review with a
 * declared monitor kind).
 *
 * Idempotency: a completed deploy approval is only ever swept once, tracked via
 * `payload.carriedIssuesSwept` on the approval row itself (the same "state lives on the
 * approval, no new columns" convention `deployVisibilityNoted` already established) -- an issue
 * that qualifies gets closed the first time its carrying deploy is swept, and re-running the
 * sweep is a guaranteed no-op afterward (the issue no longer matches `status = 'in_review'`).
 */

const CANDIDATE_ISSUE_LIMIT = 200;
const DUE_APPROVAL_LIMIT = 50;

type CandidateIssue = { issueId: string; identifier: string | null; mergeCommitSha: string };

function parseGitHubRepoFromUrl(repoUrl: string | null | undefined): { owner: string; name: string } | null {
  if (!repoUrl) return null;
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.host.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const [owner, rawName] = parsed.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !rawName) return null;
    return { owner, name: rawName.replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Every `in_review` issue in the given project with an approved merge_pr approval into the
 * declared deploy branch whose merge commit has been backfilled -- the exact candidate pool
 * item 1 of this file's docblock names. An issue with more than one such approval linked (a
 * re-review loop) contributes its first matching row; which one is immaterial since they all
 * carry the same issue toward the same conclusion.
 */
async function listCarriedCandidateIssues(
  db: Db,
  companyId: string,
  projectId: string,
  deployBranch: string,
): Promise<CandidateIssue[]> {
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      payload: approvals.payload,
    })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        eq(issues.status, "in_review"),
        eq(approvals.type, "request_board_approval"),
        eq(approvals.status, "approved"),
        sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
        sql`${approvals.payload} ->> 'base' = ${deployBranch}`,
        sql`${approvals.payload} ->> 'mergeCommitSha' is not null`,
      ),
    )
    .limit(CANDIDATE_ISSUE_LIMIT);

  const byIssueId = new Map<string, CandidateIssue>();
  for (const row of rows) {
    if (byIssueId.has(row.issueId)) continue;
    const mergeCommitSha = approvalPayloadMergeCommitSha(row.payload);
    if (!mergeCommitSha) continue;
    byIssueId.set(row.issueId, { issueId: row.issueId, identifier: row.identifier, mergeCommitSha });
  }
  return Array.from(byIssueId.values());
}

/**
 * The GitHub repo a deploy approval actually shipped from: its own pinned `payload.workspaceId`
 * first, falling back to the project's primary workspace for older payloads filed before
 * `workspaceId` was required. Returns null (never guesses) when neither resolves to a
 * github.com repo -- the ancestry check below then only ever has the exact-commit fast path
 * available, per this file's fail-closed rule.
 */
async function resolveDeployApprovalRepo(
  db: Db,
  payload: Record<string, unknown>,
): Promise<{ owner: string; name: string } | null> {
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : null;
  const projectId = approvalPayloadProjectId(payload);

  if (workspaceId) {
    const row = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, workspaceId))
      .then((rows) => rows[0] ?? null);
    const repo = parseGitHubRepoFromUrl(row?.repoUrl);
    if (repo) return repo;
  }

  if (projectId) {
    const row = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
      .then((rows) => rows[0] ?? null);
    return parseGitHubRepoFromUrl(row?.repoUrl);
  }

  return null;
}

/**
 * True/false only on a GitHub-confirmed answer; null ("unknown") for anything else --
 * unreachable, non-2xx, unparseable, or a compare status GitHub itself doesn't report as
 * ahead/identical/behind/diverged. Callers MUST treat null as "cannot close", never as
 * evidence either way (the fail-closed rule this file's docblock states).
 */
async function isCommitAncestorOrEqual(
  fetchImpl: FetchLike,
  repo: { owner: string; name: string },
  token: string | null,
  candidateCommit: string,
  deployedCommit: string,
): Promise<boolean | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-deploy-carried-issue-closer",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/compare/${encodeURIComponent(candidateCommit)}...${encodeURIComponent(deployedCommit)}`,
      { headers },
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const status = typeof body?.status === "string" ? body.status : null;
  if (status === "ahead" || status === "identical") return true;
  if (status === "behind" || status === "diverged") return false;
  return null;
}

export function deployCarriedIssuesService(
  db: Db,
  options: {
    readStatusLog?: (companyId: string) => DeployRunnerStatusEntry[];
    fetch?: FetchLike;
    resolveGitHubToken?: (companyId: string) => Promise<string | null>;
  } = {},
) {
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const readStatusLog = options.readStatusLog ?? ((companyId: string) => readDeployRunnerStatus(companyId));
  const fetchImpl = options.fetch ?? ghFetch;
  const resolveGitHubToken =
    options.resolveGitHubToken ??
    ((companyId: string) =>
      secretsSvc
        .resolveGitHubToken(companyId, { consumerType: "system", consumerId: "deploy-carried-issue-closer" })
        .catch(() => null));

  async function markSwept(approvalId: string, payload: Record<string, unknown>) {
    await db
      .update(approvals)
      .set({ payload: { ...payload, carriedIssuesSwept: true }, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
  }

  async function closeCarriedIssue(input: {
    candidate: CandidateIssue;
    approvalId: string;
    companyId: string;
    deployedCommit: string;
  }) {
    await issuesSvc.addComment(
      input.candidate.issueId,
      `This issue's merge commit ${shortSha(input.candidate.mergeCommitSha)} is confirmed live -- it shipped ` +
        `as part of deploy approval ${input.approvalId} (commit ${shortSha(input.deployedCommit)}), which ` +
        "deploy-runner recorded as completed. This issue had already completed its own review and was only " +
        "waiting on deployment, so it is being closed automatically (DUR-238).",
      {},
      { authorType: "system" },
    );
    const updated = await issuesSvc.update(input.candidate.issueId, { status: "done" });
    if (!updated) return false;
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "deploy-carried-issue-closer",
      action: "issue.updated",
      entityType: "issue",
      entityId: input.candidate.issueId,
      details: {
        status: "done",
        previousStatus: "in_review",
        source: "deploy_carried_issue_closer",
        deployApprovalId: input.approvalId,
        mergeCommitSha: input.candidate.mergeCommitSha,
        deployedCommit: input.deployedCommit,
      },
    });
    return true;
  }

  async function tick() {
    const dueApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
          sql`${approvals.payload} ->> 'kind' = 'deploy'`,
          sql`(${approvals.payload} ->> 'carriedIssuesSwept') is distinct from 'true'`,
        ),
      )
      .limit(DUE_APPROVAL_LIMIT);

    let checked = 0;
    let closed = 0;
    const statusLogByCompany = new Map<string, DeployRunnerStatusEntry[]>();
    const getStatusEntries = (companyId: string) => {
      if (!statusLogByCompany.has(companyId)) statusLogByCompany.set(companyId, readStatusLog(companyId));
      return statusLogByCompany.get(companyId) as DeployRunnerStatusEntry[];
    };

    for (const approval of dueApprovals) {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      if (approvalPayloadKind(payload) !== "deploy") continue;

      const entries = getStatusEntries(approval.companyId);
      const completedEntry = entries.find(
        (entry) =>
          entry.approvalId === approval.id &&
          (entry.body.includes(DEPLOY_SUCCESS_MARKER) || entry.outcome === "carried"),
      );
      // Not completed (or not yet visible in the trimmed status log) -- leave unswept so the
      // next tick re-checks once deploy-runner records completion.
      if (!completedEntry) continue;

      checked += 1;
      const deployedCommit = extractDeployedCommit(completedEntry);
      const projectId = approvalPayloadProjectId(payload);
      if (!deployedCommit || !projectId) {
        await markSwept(approval.id, payload);
        continue;
      }

      const branches = await resolveProjectDeployBranchesByProjectId(db, projectId);
      if (!branches?.deployBranch) {
        await markSwept(approval.id, payload);
        continue;
      }

      const candidates = await listCarriedCandidateIssues(db, approval.companyId, projectId, branches.deployBranch);
      if (candidates.length === 0) {
        await markSwept(approval.id, payload);
        continue;
      }

      const repo = await resolveDeployApprovalRepo(db, payload);
      const token = repo ? await resolveGitHubToken(approval.companyId) : null;

      for (const candidate of candidates) {
        let isCarried = commitsMatch(candidate.mergeCommitSha, deployedCommit);
        if (!isCarried && repo) {
          const ancestry = await isCommitAncestorOrEqual(
            fetchImpl,
            repo,
            token,
            candidate.mergeCommitSha,
            deployedCommit,
          );
          isCarried = ancestry === true;
        }
        if (!isCarried) continue;

        const didClose = await closeCarriedIssue({
          candidate,
          approvalId: approval.id,
          companyId: approval.companyId,
          deployedCommit,
        });
        if (didClose) closed += 1;
      }

      await markSwept(approval.id, payload);
    }

    return { checked, closed };
  }

  return { tick };
}
