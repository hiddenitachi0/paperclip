import { and, eq, gte, lte, or, sql } from "drizzle-orm";
import { approvals, projects, type Db } from "@paperclipai/db";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { describeUnknownDeployLikeKind } from "./deploy-workspace.js";

/**
 * DUR-3923 item 2 (NOR-1242 follow-up): an operator approved a deploy card and nothing
 * happened -- the card was `kind:"deploy_pr"`, which scripts/deploy-runner.sh never looks at,
 * and nothing in the system said so. Silence must never be the response to an approval.
 *
 * This scheduled tick (same shape as merge-deploy-visibility.ts, wired next to it in
 * server/src/index.ts) looks at every deploy-looking approval that has been `approved` for
 * more than `delayMs` and checks the runner's own status log (deploy-runner-status.ts) for an
 * entry about it. The runner writes an `outcome:"started"` line as soon as it begins a real
 * deploy (before the fetch, drain and build) and a terminal line at the end, so ANY entry --
 * started or terminal -- means the runner reached the card and its own comment is the answer.
 * No entry at all means the runner never picked it up: post a plain-language comment on the
 * approval and its linked issue(s) saying so, and why, as far as it can be told from here:
 *   - the card's kind is not "deploy" (nothing acts on it, and nothing ever will),
 *   - the project's deploy settings are missing/disabled,
 *   - the card names a workspace other than the project's deploy workspace (the runner
 *     refuses those),
 *   - the runner has handled other deploys since (it is running but skipped this one), or
 *   - no deploy activity at all since the approval (the runner service is probably stopped).
 *
 * Posted once per approval (`payload.deployRunnerFeedbackNoted`), and only for approvals
 * decided within `maxAgeMs` -- the status log is trimmed to its last 500 lines, so an old
 * approval with no entry in it is not evidence of anything and must not be re-litigated.
 * The runner's own comment, when it does get to the card, remains the authoritative outcome.
 *
 * Why 45 minutes: the runner polls every minute but handles approvals one at a time, and a
 * single deploy can legitimately take ~26 minutes end to end (quiet-mode drain up to 240 s,
 * the docker build, a health-check budget of HEALTH_RETRIES x (3 s + 10 s) ~= 13 min, and the
 * build + health check again on a rollback). A card approved while such a deploy is already
 * running gets no "started" line until that deploy finishes, so the patience here has to
 * exceed one worst-case deploy with room to spare -- otherwise this tick would tell the
 * operator "the runner may be stopped" in the middle of a perfectly normal slow deploy.
 */
export const DEPLOY_APPROVAL_FEEDBACK_DELAY_MS = 45 * 60 * 1000;
export const DEPLOY_APPROVAL_FEEDBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DEPLOY_LIKE_KIND_SQL_PATTERN = "deploy|release|rollout|ship";

export interface DeployApprovalFeedbackTickResult {
  checked: number;
  flagged: number;
}

function minutesSince(from: Date, now: Date): number {
  return Math.max(1, Math.round((now.getTime() - from.getTime()) / 60000));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function composeUnsupportedKindFeedback(kind: string, approvedMinutesAgo: number): string {
  return (
    `This card was approved ${approvedMinutesAgo} minutes ago, but nothing has acted on it and nothing ` +
    `will: it was filed with kind "${kind}", which the deploy runner does not understand. Only cards with ` +
    `kind "deploy" get deployed. If this change should go live, ask the agent to file a new deploy approval ` +
    `with kind "deploy" (project, workspace and commit filled in). This card can be left as it is.`
  );
}

export function composeUnprocessedDeployFeedback(input: {
  approvedMinutesAgo: number;
  reason: string;
}): string {
  return (
    `This deploy was approved ${input.approvedMinutesAgo} minutes ago, but the deploy runner has not ` +
    `picked it up. ${input.reason} Nothing has deployed for it yet.`
  );
}

export function diagnoseUnprocessedDeploy(input: {
  approvalId: string;
  payload: Record<string, unknown>;
  decidedAt: Date;
  project: { deployPolicy: Record<string, unknown> | null } | null;
  statusEntries: DeployRunnerStatusEntry[];
}): string {
  if (!input.project) {
    return "The card points at a project that does not exist, so the runner cannot find what to deploy.";
  }
  const policy = input.project.deployPolicy;
  if (!policy || policy.enabled !== true) {
    return (
      "The project's deploy settings are missing or switched off, so the runner will not deploy it. " +
      "An operator needs to turn on deploys for this project first."
    );
  }
  const policyWorkspaceId = typeof policy.workspaceId === "string" ? policy.workspaceId : "";
  const cardWorkspaceId = typeof input.payload.workspaceId === "string" ? input.payload.workspaceId : "";
  if (policyWorkspaceId && cardWorkspaceId && policyWorkspaceId !== cardWorkspaceId) {
    return (
      `The card names workspace ${shortId(cardWorkspaceId)} but this project deploys from workspace ` +
      `${shortId(policyWorkspaceId)}, so the runner refuses it. File a new deploy approval for the right workspace.`
    );
  }
  const activitySinceApproval = input.statusEntries.some((entry) => {
    const ts = new Date(entry.ts);
    return !Number.isNaN(ts.getTime()) && ts.getTime() >= input.decidedAt.getTime();
  });
  if (activitySinceApproval) {
    return (
      "The runner has handled other deploys since then, so it is running but skipped this one. " +
      "An operator should check deploy-runner.log on the server."
    );
  }
  return (
    "No deploy activity has been recorded since it was approved, so the deploy runner service on the " +
    "server may be stopped. An operator needs to check it."
  );
}

export function deployApprovalFeedbackService(
  db: Db,
  options: {
    delayMs?: number;
    maxAgeMs?: number;
    readStatusLog?: (companyId: string) => DeployRunnerStatusEntry[];
  } = {},
) {
  const delayMs = options.delayMs ?? DEPLOY_APPROVAL_FEEDBACK_DELAY_MS;
  const maxAgeMs = options.maxAgeMs ?? DEPLOY_APPROVAL_FEEDBACK_MAX_AGE_MS;
  const readStatusLog = options.readStatusLog ?? ((companyId: string) => readDeployRunnerStatus(companyId, 500));
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);

  async function markNoted(approvalId: string, payload: Record<string, unknown>, extra: Record<string, unknown>) {
    await db
      .update(approvals)
      .set({ payload: { ...payload, ...extra, deployRunnerFeedbackNoted: true }, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
  }

  async function readProject(projectId: unknown): Promise<{ deployPolicy: Record<string, unknown> | null } | null> {
    if (typeof projectId !== "string" || !projectId) return null;
    const row = await db
      .select({ deployPolicy: projects.deployPolicy })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const policy = row.deployPolicy;
    return {
      deployPolicy: policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as Record<string, unknown>) : null,
    };
  }

  async function tick(now = new Date()): Promise<DeployApprovalFeedbackTickResult> {
    const cutoff = new Date(now.getTime() - delayMs);
    const horizon = new Date(now.getTime() - maxAgeMs);
    const dueApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
          or(
            sql`${approvals.payload} ->> 'kind' = 'deploy'`,
            sql`${approvals.payload} ->> 'kind' ~* ${DEPLOY_LIKE_KIND_SQL_PATTERN}`,
          ),
          sql`(${approvals.payload} ->> 'deployRunnerFeedbackNoted') is distinct from 'true'`,
          sql`${approvals.decidedAt} is not null`,
          lte(approvals.decidedAt, cutoff),
          gte(approvals.decidedAt, horizon),
        ),
      )
      .limit(50);

    let checked = 0;
    let flagged = 0;
    const statusLogByCompany = new Map<string, DeployRunnerStatusEntry[]>();
    const getStatusEntries = (companyId: string) => {
      if (!statusLogByCompany.has(companyId)) statusLogByCompany.set(companyId, readStatusLog(companyId));
      return statusLogByCompany.get(companyId) as DeployRunnerStatusEntry[];
    };

    for (const approval of dueApprovals) {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      const kind = typeof payload.kind === "string" ? payload.kind.trim() : "";
      if (kind !== "deploy" && !describeUnknownDeployLikeKind(kind)) continue;
      const decidedAt = approval.decidedAt ? new Date(approval.decidedAt) : null;
      if (!decidedAt || Number.isNaN(decidedAt.getTime())) continue;
      if (decidedAt.getTime() > cutoff.getTime() || decidedAt.getTime() < horizon.getTime()) continue;
      checked += 1;

      const statusEntries = getStatusEntries(approval.companyId);
      const runnerSawIt = statusEntries.some((entry) => entry.approvalId === approval.id);
      if (runnerSawIt) {
        // The runner reached it: it is deploying it right now ("started" line), or it has
        // commented (or is retrying its comment). That comment is the operator's answer, not
        // this one.
        await markNoted(approval.id, payload, { deployRunnerFeedbackOutcome: "processed_by_runner" });
        continue;
      }

      const approvedMinutesAgo = minutesSince(decidedAt, now);
      let body: string;
      let outcome: string;
      if (kind !== "deploy") {
        body = composeUnsupportedKindFeedback(kind, approvedMinutesAgo);
        outcome = "unsupported_kind";
      } else {
        const project = await readProject(payload.projectId);
        const reason = diagnoseUnprocessedDeploy({
          approvalId: approval.id,
          payload,
          decidedAt,
          project,
          statusEntries,
        });
        body = composeUnprocessedDeployFeedback({ approvedMinutesAgo, reason });
        outcome = "unprocessed";
      }

      await approvalsSvc.addComment(approval.id, body, {});
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      for (const issue of linkedIssues) {
        await issuesSvc.addComment(issue.id, body, {}, { authorType: "system" });
      }
      flagged += 1;
      await markNoted(approval.id, payload, {
        deployRunnerFeedbackOutcome: outcome,
        deployRunnerFeedbackAt: now.toISOString(),
      });
    }

    return { checked, flagged };
  }

  return { tick };
}
