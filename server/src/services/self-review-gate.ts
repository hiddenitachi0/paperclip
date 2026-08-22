import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, executionWorkspaces, heartbeatRuns, issueComments, projectWorkspaces } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

/**
 * DUR-22 slice 1: a bounded, one-time "review your own diff before handing off" pass
 * inserted before a code issue moves to in_review/done. See:
 * - server/src/routes/issues.ts (the synchronous done gate)
 * - server/src/services/heartbeat.ts handleSuccessfulRunHandoff (the run-finish backstop)
 */

export const SELF_REVIEW_PASS_REASON = "self_review_pass";

// Marker carried in a run's contextSnapshot/payload so a run started for the self-review
// pass (and anything it bounded-retries into) is recognized without re-gating it again.
export const SELF_REVIEW_PASS_CONTEXT_KEY = "selfReviewPass";

export function isSelfReviewPassContext(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context[SELF_REVIEW_PASS_CONTEXT_KEY] === true || context.wakeReason === SELF_REVIEW_PASS_REASON;
}

/** Recognizes a run that IS the (bounded, one-time) self-review pass, however it was scheduled. */
export function isSelfReviewPassRun(run: {
  scheduledRetryReason?: string | null;
  contextSnapshot?: unknown;
}): boolean {
  if (run.scheduledRetryReason === SELF_REVIEW_PASS_REASON) return true;
  return isSelfReviewPassContext(run.contextSnapshot);
}

/**
 * Looks up whether a given run (by id) IS itself the self-review pass, so a caller that only
 * has a run id (e.g. the actor on an inbound PATCH request) can exempt that run from being
 * gated again. Without this, each self-review pass run would be gated on its own attempt to
 * hand off, scheduling another self-review pass indefinitely — the exact loop this feature is
 * meant to bound to exactly one extra pass.
 */
export async function isSelfReviewPassRunId(db: Db, runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const run = await db
    .select({ scheduledRetryReason: heartbeatRuns.scheduledRetryReason, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return false;
  return isSelfReviewPassRun(run);
}

export function issueExecutionPolicyOptsOutOfSelfReview(
  policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined,
): boolean {
  return (policy as { selfReview?: unknown } | null | undefined)?.selfReview === false;
}

/** A "code issue" is one whose project has at least one git-backed workspace. */
export async function issueProjectHasGitWorkspace(
  db: Db,
  companyId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  if (!projectId) return false;
  const row = await db
    .select({ id: projectWorkspaces.id })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
        isNotNull(projectWorkspaces.repoUrl),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

export function buildSelfReviewPassIdempotencyKey(input: { issueId: string; sourceRunId: string }) {
  return [SELF_REVIEW_PASS_REASON, input.issueId, input.sourceRunId].join(":");
}

/**
 * DUR-71: a change touching one of these surfaces gets a second, adversarial set of
 * questions appended to the ordinary self-review instruction (see
 * buildSelfReviewPassInstruction below). Detection runs against the actual changed file
 * paths (detectRiskySurfaceFromDiff), not the agent's own judgment of whether its work is
 * risky — see getChangedFilePathsForIssueWorkspace for where those paths come from.
 */
export type RiskySurfaceCategory =
  | "authorization_or_permissions"
  | "agent_configuration"
  | "secrets_or_credentials"
  | "migrations"
  | "outbound_or_spend";

export const RISKY_SURFACE_CATEGORY_LABELS: Record<RiskySurfaceCategory, string> = {
  authorization_or_permissions: "authorization or permissions",
  agent_configuration: "agent configuration",
  secrets_or_credentials: "secrets or credentials",
  migrations: "database migrations",
  outbound_or_spend: "publishing outward or spending money",
};

const RISKY_SURFACE_PATTERNS: Array<{ category: RiskySurfaceCategory; pattern: RegExp }> = [
  { category: "authorization_or_permissions", pattern: /authoriz|permission|\bacl\b|\brbac\b|access-control/i },
  {
    category: "agent_configuration",
    pattern: /adapterConfig|agent-permissions|agent-instructions|agent-secret-bindings|\bagents\.ts$|mcp[-_]?servers?|plugin-managed-agents/i,
  },
  { category: "secrets_or_credentials", pattern: /secret|credential|\btoken\b|api[-_]?key|\.env(\.|$)/i },
  { category: "migrations", pattern: /\/migrations\// },
  {
    category: "outbound_or_spend",
    pattern:
      /deploy-runner|deploy-policy|deploy-branches|merge-deploy|webhook|notification|\bslack\b|\btelegram\b|\bemail\b|billing|\bcosts?\.ts$|\bbudgets?\.ts$|approvals?\.ts/i,
  },
];

/**
 * Pure, testable core of surface detection: given the paths changed by a diff, returns
 * which risky-surface categories they touch (empty array for an ordinary change). Takes
 * plain strings so it can be exercised without any git/DB access.
 */
export function detectRiskySurfaceFromDiff(changedFilePaths: readonly string[]): RiskySurfaceCategory[] {
  const found = new Set<RiskySurfaceCategory>();
  for (const rawPath of changedFilePaths) {
    if (!rawPath) continue;
    for (const { category, pattern } of RISKY_SURFACE_PATTERNS) {
      if (pattern.test(rawPath)) found.add(category);
    }
  }
  return [...found];
}

const RISKY_SURFACE_GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Looks up the issue's current execution workspace and, if it's a local, on-disk checkout
 * (local_fs/git_worktree with a base ref recorded), runs `git diff --name-only` against it
 * to get the paths changed since the base ref. Returns null (not an empty array) whenever
 * the diff genuinely can't be read -- cloud/adapter-managed workspaces, a missing path, a
 * missing base ref, or the git command failing -- so callers can tell "no risky surface
 * detected" apart from "couldn't check" and fall back to the ordinary-only prompt rather
 * than guessing.
 */
export async function getChangedFilePathsForIssueWorkspace(
  db: Db,
  input: { companyId: string; executionWorkspaceId: string | null | undefined },
): Promise<string[] | null> {
  if (!input.executionWorkspaceId) return null;
  const workspace = await db
    .select({
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
      providerType: executionWorkspaces.providerType,
      baseRef: executionWorkspaces.baseRef,
    })
    .from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.id, input.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workspace) return null;
  if (workspace.providerType !== "local_fs" && workspace.providerType !== "git_worktree") return null;

  const workspacePath = workspace.providerRef ?? workspace.cwd;
  if (!workspacePath || !workspace.baseRef) return null;

  try {
    await fs.access(workspacePath);
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "diff", "--name-only", `${workspace.baseRef}...HEAD`],
      { cwd: workspacePath, maxBuffer: RISKY_SURFACE_GIT_MAX_BUFFER_BYTES },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function buildAdversarialSurfaceLines(categories: readonly RiskySurfaceCategory[]): string[] {
  const categoryLabels = categories.map((category) => RISKY_SURFACE_CATEGORY_LABELS[category]).join(", ");
  return [
    `This change touches a risky surface (${categoryLabels}). On top of the check above, also ask yourself these questions -- they're adversarial on purpose, not another way of confirming you did what the ticket asked:`,
    "- If a dishonest agent wanted to abuse this change, what would it do? Actually try to find the path -- don't just assert there is none.",
    "- Does this add a field, route, or setting that an agent could set on itself? If so, say who is allowed to set it, and go verify the check that enforces that actually exists -- don't assume it does.",
    "- Does this only work because something elsewhere is configured a particular way? If so, check right now whether that configuration is actually set that way -- don't assume it.",
    "- What did the ticket NOT ask for that a reasonable person would still expect anyway (the obvious abuse case, the missing guard, the config nobody wired up)?",
    "",
    'If this turns up a real security or correctness gap -- even one outside what the ticket asked for -- report it in a comment. "Do not invent extra scope" above is about not padding the work, not about staying quiet on a genuine finding; fixing it can be its own follow-up issue, but don\'t suppress it.',
  ];
}

export function buildSelfReviewPassInstruction(input: {
  issueIdentifier: string | null;
  alreadyHandedOff: boolean;
  riskySurfaceCategories?: readonly RiskySurfaceCategory[];
}) {
  const issueLabel = input.issueIdentifier ?? "this issue";
  const lines = [
    `Before ${issueLabel} moves on, take one pass over your own work first.`,
    "",
    "Review your diff/changes against the task description and:",
    "- Check that every requirement in the description is actually met, not just partially addressed.",
    "- Look for bugs, mistakes, or loose ends you may have missed the first time.",
    "- Fix anything real that you find. Do not invent extra scope beyond the task.",
  ];
  const riskySurfaceCategories = input.riskySurfaceCategories ?? [];
  if (riskySurfaceCategories.length > 0) {
    lines.push("", ...buildAdversarialSurfaceLines(riskySurfaceCategories));
  }
  lines.push("");
  if (input.alreadyHandedOff) {
    lines.push(
      "This issue already shows as handed off. If your review finds nothing wrong, leave the status as-is — no further action is required. If you find a real problem, fix it and leave a short comment describing what you fixed.",
    );
  } else {
    lines.push(
      "Once you've done this check (and fixed anything real that came up), continue the normal handoff for this issue.",
    );
  }
  return lines.join("\n");
}

export const SELF_REVIEW_PASS_NOTICE_COMMENT =
  "Before this moves on, I'm doing one more pass over my own work to double-check it against the task.";

/**
 * Posts a plain-language, system-authored issue comment explaining the self-review pass.
 *
 * The synchronous gate (evaluateSelfReviewDoneGate) and the run-finish backstop
 * (heartbeat.ts handleSuccessfulRunHandoff) both schedule a wakeup tagged with
 * SELF_REVIEW_PASS_REASON, but the generic wake payload (buildPaperclipWakePayload in
 * heartbeat.ts) only surfaces specific known contextSnapshot fields — it does not read an
 * arbitrary `instruction` field out of the wakeup payload/context. Posting an issue comment
 * is the pragmatic way to make sure the agent actually sees the plain-language instruction,
 * since comments are already reliably surfaced to agents on wake.
 */
export async function postSelfReviewPassNoticeComment(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId?: string | null; body: string },
): Promise<void> {
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: input.body,
    createdByRunId: input.sourceRunId ?? null,
  });
}

/**
 * Looks for a self-review-pass notice comment already posted for this exact run, so callers
 * that don't already have a wake-level idempotency check (e.g. the heartbeat.ts backstop)
 * can avoid posting a duplicate comment if the same run chain is re-evaluated.
 */
export async function findExistingSelfReviewPassNoticeCommentForRun(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId: string; body: string },
) {
  return db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.sourceRunId),
        eq(issueComments.body, input.body),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

const IDEMPOTENT_SELF_REVIEW_PASS_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "completed"] as const;

export async function findExistingSelfReviewPassWake(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_SELF_REVIEW_PASS_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export type SelfReviewGateWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * Evaluates whether an agent-initiated transition to in_review/done should be deferred
 * for a self-review pass, and if so, schedules the corrective wake. Returns null when the
 * transition should proceed as requested.
 */
export async function evaluateSelfReviewDoneGate(input: {
  db: Db;
  wakeup: SelfReviewGateWakeup;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    projectId: string | null;
    executionPolicy: unknown;
    executionWorkspaceId?: string | null;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
}): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "in_review" && input.requestedStatus !== "done") return null;
  if (input.currentStatus === input.requestedStatus) return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) return null;
  if (issueExecutionPolicyOptsOutOfSelfReview(input.issue.executionPolicy as IssueExecutionPolicy | null)) return null;

  // The self-review pass run itself must be allowed through — otherwise its own handoff
  // attempt would re-trigger this gate and schedule another pass, looping indefinitely.
  if (await isSelfReviewPassRunId(input.db, input.actor.runId)) return null;

  const hasGitWorkspace = await issueProjectHasGitWorkspace(input.db, input.issue.companyId, input.issue.projectId);
  if (!hasGitWorkspace) return null;

  const sourceRunId = input.actor.runId;
  const idempotencyKey = buildSelfReviewPassIdempotencyKey({ issueId: input.issue.id, sourceRunId });
  const existingWake = await findExistingSelfReviewPassWake(input.db, {
    companyId: input.issue.companyId,
    idempotencyKey,
  });

  const baseMessage =
    "This task needs one more self-check before it can move to review or done. I've asked the assignee to double-check their own work first, then try again.";

  if (existingWake) return { message: baseMessage };

  // DUR-71: detection is driven by the actual changed file paths, not by asking the agent
  // whether its own work is risky. changedFilePaths is null (not []) when the diff genuinely
  // couldn't be read (e.g. a non-local workspace) -- that degrades to the ordinary-only
  // prompt rather than guessing at risk. Only computed here (once we know we're actually
  // about to schedule a new pass), not on every duplicate/retry hit of this gate.
  const changedFilePaths = await getChangedFilePathsForIssueWorkspace(input.db, {
    companyId: input.issue.companyId,
    executionWorkspaceId: input.issue.executionWorkspaceId ?? null,
  });
  const riskySurfaceCategories = changedFilePaths ? detectRiskySurfaceFromDiff(changedFilePaths) : [];
  const riskySurfaceNote =
    riskySurfaceCategories.length > 0
      ? ` This one also touches ${riskySurfaceCategories.map((category) => RISKY_SURFACE_CATEGORY_LABELS[category]).join(", ")}, so I've included some adversarial questions on top of the usual check.`
      : "";
  const message = baseMessage + riskySurfaceNote;

  const instruction = buildSelfReviewPassInstruction({
    issueIdentifier: input.issue.identifier,
    alreadyHandedOff: false,
    riskySurfaceCategories,
  });

  try {
    await input.wakeup(input.actor.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        resumeIntent: true,
        resumeFromRunId: sourceRunId,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        instruction,
      },
      contextSnapshot: {
        issueId: input.issue.id,
        wakeReason: SELF_REVIEW_PASS_REASON,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        resumeFromRunId: sourceRunId,
      },
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "issue_self_review_gate",
    });
  } catch {
    // Scheduling the extra pass failed (e.g. the agent is paused or the company is over
    // budget). Don't let a self-review scheduling failure block a real disposition — let
    // the transition through as requested instead.
    return null;
  }

  try {
    // Best-effort: the wakeup is already scheduled (and is what actually re-gates the
    // transition), so a failure here shouldn't change the gate's outcome.
    await postSelfReviewPassNoticeComment(input.db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sourceRunId,
      body: instruction,
    });
  } catch {
    // Ignore — see comment above.
  }

  return { message };
}
