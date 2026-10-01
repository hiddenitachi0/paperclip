import { eq } from "drizzle-orm";
import { jobs, type Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";

/**
 * DUR-4182: a Job's `requiresApproval` flag ("needs Filip's approval before
 * done"). Mirrors the shape of deploy-completion-gate.ts (kind-based,
 * agent-transitions-only, composes as one more `evaluate...DoneGate` call in
 * routes/issues.ts's PATCH handler) but much narrower: no merge/branch/runner
 * plumbing, just "does the issue this job run created have an APPROVED
 * `request_board_approval` with `payload.kind === "job_approval"` linked to
 * it". No dedicated strict payload schema exists for that kind (the same
 * loose `payload.kind` convention merge_pr/model_boost/tool_grant already
 * use without one) -- Filip files it like any other board-approval request,
 * payload `{ kind: "job_approval", jobId, jobRunId }`.
 */
export interface JobApprovalGateInput {
  db: Db;
  issue: { id: string; companyId: string; originKind?: string | null; originId?: string | null };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
}

export interface JobApprovalGateResult {
  message: string;
}

export async function evaluateJobApprovalDoneGate(
  input: JobApprovalGateInput,
): Promise<JobApprovalGateResult | null> {
  if (input.requestedStatus !== "done") return null;
  if (input.currentStatus === "done") return null;
  // Same split as the deploy/self-review/goal-condition gates: a board actor
  // can always override, this guards agent self-certification only.
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
  if (input.issue.originKind !== "job_execution" || !input.issue.originId) return null;

  const job = await input.db
    .select({ id: jobs.id, title: jobs.title, requiresApproval: jobs.requiresApproval })
    .from(jobs)
    .where(eq(jobs.id, input.issue.originId))
    .then((rows) => rows[0] ?? null);
  if (!job || !job.requiresApproval) return null;

  const linked = await issueApprovalService(input.db).listApprovalsForIssue(input.issue.id);
  const satisfied = linked.some((approval) => {
    const payload = approval.payload as Record<string, unknown> | null;
    return (
      approval.type === "request_board_approval" &&
      approval.status === "approved" &&
      payload?.kind === "job_approval"
    );
  });
  if (satisfied) return null;

  return {
    message:
      `This job ("${job.title}") requires approval before it can be marked done. File a ` +
      `request_board_approval with payload.kind "job_approval" linked to this issue and wait ` +
      `for it to be approved.`,
  };
}
