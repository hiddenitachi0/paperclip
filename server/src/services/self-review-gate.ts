import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
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

/**
 * DUR-91: content-based counterpart to detectRiskySurfaceFromDiff. The path-based check
 * alone misses risky content living in a generically-named file (e.g. DUR-67's
 * codex-home.ts/runtime-config.ts, which strip `mcp_servers` blocks carrying secrets but
 * match none of the RISKY_SURFACE_PATTERNS filename regexes). This runs the same patterns
 * against the *added* lines of a unified diff -- lines starting with "+" other than the
 * "+++ b/path" file header -- so risky literals (mcp_servers, secret, token, ...) trip the
 * gate regardless of what file they land in. Deliberately only looks at added lines: new
 * code introducing a risky capability is the case that matters, and limiting to additions
 * (vs. also scanning removed/context lines) keeps the signal closer to "what did this change
 * actually introduce" rather than flagging every diff that happens to touch a file
 * mentioning these words anywhere nearby.
 */
export function detectRiskySurfaceFromDiffContent(diffContent: string): RiskySurfaceCategory[] {
  const found = new Set<RiskySurfaceCategory>();
  for (const line of diffContent.split(/\r?\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { category, pattern } of RISKY_SURFACE_PATTERNS) {
      if (pattern.test(line)) found.add(category);
    }
  }
  return [...found];
}

const RISKY_SURFACE_GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Resolves the issue's current execution workspace to a local, on-disk git checkout
 * (local_fs/git_worktree with a base ref recorded) that getChangedFilePathsForIssueWorkspace
 * and getChangedDiffContentForIssueWorkspace can run `git diff` against. Returns null
 * whenever there's no such workspace to read -- cloud/adapter-managed workspaces, a missing
 * path, or a missing base ref -- so callers degrade to "couldn't check" rather than guessing.
 *
 * DUR-83: resolves the workspace by execution_workspaces.sourceIssueId (set only by the
 * server when a workspace is realized, never writable by an issue PATCH) rather than by
 * trusting issues.executionWorkspaceId. That field is a plain, ungated column an issue's
 * own assignee can PATCH to null on an unrelated field-only update -- doing so right before
 * a status transition would silently skip risk detection (and any adversarial questions)
 * without ever tripping the self-review gate itself.
 */
async function resolveIssueGitWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<{ workspacePath: string; baseRef: string } | null> {
  if (!input.issueId) return null;
  const workspace = await db
    .select({
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
      providerType: executionWorkspaces.providerType,
      baseRef: executionWorkspaces.baseRef,
    })
    .from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.sourceIssueId, input.issueId), eq(executionWorkspaces.companyId, input.companyId)))
    .orderBy(desc(executionWorkspaces.lastUsedAt))
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

  return { workspacePath, baseRef: workspace.baseRef };
}

/**
 * Runs `git diff --name-only` against the issue's resolved workspace to get the paths
 * changed since the base ref. Returns null (not an empty array) whenever the diff genuinely
 * can't be read -- no resolvable workspace or the git command failing -- so callers can tell
 * "no risky surface detected" apart from "couldn't check" and fall back to the ordinary-only
 * prompt rather than guessing.
 */
export async function getChangedFilePathsForIssueWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<string[] | null> {
  const resolved = await resolveIssueGitWorkspace(db, input);
  if (!resolved) return null;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", resolved.workspacePath, "diff", "--name-only", `${resolved.baseRef}...HEAD`],
      { cwd: resolved.workspacePath, maxBuffer: RISKY_SURFACE_GIT_MAX_BUFFER_BYTES },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * DUR-91: sibling to getChangedFilePathsForIssueWorkspace that reads the actual diff hunk
 * text (`git diff <base>...HEAD`, not `--name-only`) so detectRiskySurfaceFromDiffContent can
 * catch risky content living in a generically-named file. Same null-vs-empty-string contract:
 * null means "couldn't check", not "checked, found nothing".
 */
export async function getChangedDiffContentForIssueWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<string | null> {
  const resolved = await resolveIssueGitWorkspace(db, input);
  if (!resolved) return null;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", resolved.workspacePath, "diff", `${resolved.baseRef}...HEAD`],
      { cwd: resolved.workspacePath, maxBuffer: RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES },
    );
    return stdout;
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
  requestedStatus?: string | null;
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
    // DUR-125/DUR-167: this comment is posted immediately when a PATCH gets declined,
    // attributed to (and visible in real time to) the SOURCE run that just got declined --
    // not to the distinct future run this instruction is actually meant for, which doesn't
    // exist yet. A same-run reader wording ("this run", "yourself, right now") reads as
    // self-addressed and reliably caused the declined run to retry the same PATCH in-run
    // (confirmed on DUR-132: two separate runs did exactly this, immediately after posting
    // their own self-review comment, and both got declined again). Naming both possible
    // audiences explicitly closes that gap instead of assuming the reader is the exempt one.
    const statusLine = input.requestedStatus
      ? ` That freshly-started run's own \`PATCH .../${input.requestedStatus}\` will not be gated again — it should call it itself, right away.`
      : "";
    lines.push(
      "One of two things is true about whoever reads this:",
      "- If you are the run whose PATCH was just declined: stop. Do not retry that PATCH in this run, even after doing the review above and even if you post a self-review comment first — only a separate, freshly-started run is exempt from this gate, and retrying here will be declined again no matter what you post.",
      `- If you are that freshly-started run (you were woken up specifically for a self-review pass on ${issueLabel}): do the check above, fix anything real, then continue the normal handoff.${statusLine} Do not defer this to "the next self-review-pass run" — you already are that pass, and there is no other one coming.`,
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
    "This task needs one more self-check before it can move to review or done. I've scheduled a separate follow-up run to do that check and complete the handoff — retrying this same PATCH again in this run will not succeed, even right after posting a self-review comment yourself. Don't retry here; wait for the follow-up run.";

  if (existingWake) return { message: baseMessage };

  // DUR-71: detection is driven by the actual changed file paths, not by asking the agent
  // whether its own work is risky. changedFilePaths is null (not []) when the diff genuinely
  // couldn't be read (e.g. a non-local workspace) -- that degrades to the ordinary-only
  // prompt rather than guessing at risk. Only computed here (once we know we're actually
  // about to schedule a new pass), not on every duplicate/retry hit of this gate.
  //
  // DUR-91: path-only detection misses risky content in a generically-named file (e.g.
  // DUR-67's codex-home.ts, which strips `mcp_servers` blocks carrying secrets but matches
  // no filename pattern). getChangedDiffContentForIssueWorkspace/detectRiskySurfaceFromDiffContent
  // supplement the path check with the same patterns run against added diff lines.
  const [changedFilePaths, diffContent] = await Promise.all([
    getChangedFilePathsForIssueWorkspace(input.db, { companyId: input.issue.companyId, issueId: input.issue.id }),
    getChangedDiffContentForIssueWorkspace(input.db, { companyId: input.issue.companyId, issueId: input.issue.id }),
  ]);
  const riskySurfaceCategories = [
    ...new Set([
      ...(changedFilePaths ? detectRiskySurfaceFromDiff(changedFilePaths) : []),
      ...(diffContent ? detectRiskySurfaceFromDiffContent(diffContent) : []),
    ]),
  ];
  const riskySurfaceNote =
    riskySurfaceCategories.length > 0
      ? ` This one also touches ${riskySurfaceCategories.map((category) => RISKY_SURFACE_CATEGORY_LABELS[category]).join(", ")}, so I've included some adversarial questions on top of the usual check.`
      : "";
  const message = baseMessage + riskySurfaceNote;

  const instruction = buildSelfReviewPassInstruction({
    issueIdentifier: input.issue.identifier,
    alreadyHandedOff: false,
    riskySurfaceCategories,
    requestedStatus: input.requestedStatus,
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
        // DUR-125: the run this scheduling call spawns must be exempt from this same gate
        // (see isSelfReviewPassRunId above). That only holds if it lands as a genuinely new
        // heartbeat_runs row -- if the source run is still "running" when this fires, the
        // generic same-agent/same-issue coalescing in heartbeat.ts's enqueueWakeup would
        // otherwise merge this contextSnapshot onto the source run's own (already-gated) row
        // instead of producing a new one. This flag routes it through the defer-and-promote
        // path so the exemption always lands on a fresh run.
        requiresDistinctRunBoundary: true,
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
