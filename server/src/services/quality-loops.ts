import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  companyHelperSettings,
  companyQualityLoopSettings,
  issueComments,
  modelDirectoryEntries,
} from "@paperclipai/db";
import {
  QUALITY_CHECK_BILLING_CODE,
  QUALITY_DONE_CHECK_DEFAULT_ROUNDS,
  QUALITY_DONE_CHECK_MAX_ROUNDS,
  QUALITY_LOOPS_NEW_COMPANY_DEFAULTS,
  QUALITY_SELF_REVIEW_MAX_PASSES,
  type CompanyQualityLoopSettings,
  type UpdateCompanyQualityLoopSettings,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import {
  DONE_GATE_NEEDS_WORK_PREFIX,
  DoneGateUnreadableReplyError,
  buildDoneGateCriticSystemPrompt,
  buildDoneGateCriticUserMessage,
  evaluateDoneGateCritic,
  findDoneGateLoopResetAt,
  noteDoneGateCouldNotRun,
  parseDoneGateCriticReply,
  type DoneGateCritic,
  type DoneGateEvaluationInput,
  type DoneGateEvaluationResult,
} from "./done-gate-critic.js";
// Type-only: helper.ts pulls in the picture pipeline (sharp, storage), which is loaded
// lazily below so the issue routes and heartbeat that import this module stay light.
import type { HelperServiceOptions } from "./helper.js";
import {
  MISSING_RUN_ID_GATE_MESSAGE,
  SELF_REVIEW_PASS_CONTEXT_KEY,
  SELF_REVIEW_PASS_REASON,
  issueProjectHasGitWorkspace,
  type SelfReviewGateWakeup,
  type SelfReviewGateWakeupNotScheduledInfo,
} from "./self-review-gate.js";

/**
 * Agent quality loops: the per-company, opt-in OFFENSIVE loops around an agent's "done".
 *
 * Existing loops are defensive (retry a crashed run, recover a stranded task) or narrow
 * (the code-diff self-review in self-review-gate.ts, the instance-wide critic in
 * done-gate-critic.ts). This module lets a company switch on, under Company settings:
 *
 * 1. Self-check pass ("selfReviewPasses", 0-3 per task). When an agent first moves a task
 *    to in_review/done, the move is refused once (409) and a separate run of the same
 *    agent is woken to compare the work with the task's request, list what is not done,
 *    fix it and then finish. Counts every self-review pass the task ever had (including
 *    the code-diff pass from self-review-gate.ts), so the total is bounded by the setting.
 *    Recorded in the activity log ("issue.quality_self_review_scheduled").
 *
 * 2. Independent finish check ("doneCheckEnabled"). A cheap call to one of the company's
 *    own saved models, through the helper's model path (helper.ts completeWithSavedModel),
 *    reads the request next to the agent's final note (+ merge summary / changed files
 *    when present) and answers pass / needs work. Round counting, the send-back comment,
 *    and escalation to the person after the last round are the existing machinery in
 *    done-gate-critic.ts. Cost goes to the ledger with billing code "quality_check",
 *    attributed to the agent (so it counts against the agent's budget). No saved model,
 *    or a spending limit hit -> the check is skipped with a visible note on the task.
 *    When the agent's run ends with the task still sent back, the agent is woken once
 *    per round to fix it (maybeScheduleQualityCheckFollowUp, called from heartbeat.ts).
 *
 * 3. Default reviewer for new code tasks ("defaultReviewerAgentId"): applies the existing
 *    review stage ("Reviewers" on a task) at creation; see applyDefaultReviewerPolicy.
 *
 * A company with no settings row has everything off. Per task, executionPolicy can set
 * `selfReviewPasses` (0-3) and `doneCheck` (true/false); `selfReview: false` (the older
 * opt-out) also turns the self-check pass off.
 */

export const QUALITY_SELF_REVIEW_KEY_PREFIX = "quality_self_review";
export const QUALITY_CHECK_FOLLOW_UP_REASON = "quality_check_needs_work";
export const QUALITY_SETTINGS_PATH = 'Company settings, "Quality checks"';

const QUALITY_CHECK_MAX_OUTPUT_TOKENS = 600;
const QUALITY_CHECK_TIMEOUT_MS = 60_000;

type SettingsRow = typeof companyQualityLoopSettings.$inferSelect;

export interface EffectiveQualityLoops {
  selfReviewPasses: number;
  doneCheckEnabled: boolean;
  doneCheckMaxRounds: number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Company row + the task's own override -> what actually applies to this task. */
export function resolveEffectiveQualityLoops(
  row: Pick<SettingsRow, "selfReviewPasses" | "doneCheckEnabled" | "doneCheckMaxRounds"> | null,
  executionPolicy: unknown,
): EffectiveQualityLoops {
  const policy =
    executionPolicy && typeof executionPolicy === "object" && !Array.isArray(executionPolicy)
      ? (executionPolicy as Record<string, unknown>)
      : {};
  let selfReviewPasses = clampInt(row?.selfReviewPasses ?? 0, 0, QUALITY_SELF_REVIEW_MAX_PASSES, 0);
  if (typeof policy.selfReviewPasses === "number") {
    selfReviewPasses = clampInt(policy.selfReviewPasses, 0, QUALITY_SELF_REVIEW_MAX_PASSES, selfReviewPasses);
  }
  if (policy.selfReview === false) selfReviewPasses = 0;
  const doneCheckEnabled = typeof policy.doneCheck === "boolean" ? policy.doneCheck : Boolean(row?.doneCheckEnabled);
  return {
    selfReviewPasses,
    doneCheckEnabled,
    doneCheckMaxRounds: clampInt(
      row?.doneCheckMaxRounds ?? QUALITY_DONE_CHECK_DEFAULT_ROUNDS,
      1,
      QUALITY_DONE_CHECK_MAX_ROUNDS,
      QUALITY_DONE_CHECK_DEFAULT_ROUNDS,
    ),
  };
}

/**
 * The task-level fields that switch quality checks on or off. Only a person (a board
 * user) may change them: an agent must not be able to switch off the checks on its own
 * work, nor switch on paid checks in a company that has not opted in.
 */
export const QUALITY_LOOP_POLICY_FIELDS = ["selfReview", "selfReviewPasses", "doneCheck"] as const;

/**
 * For a non-person writer: returns `next` with the quality-check fields reset to what is
 * stored on the task (`previous`; nothing for a new task), whatever the writer sent.
 * Returns null when nothing else is left in the policy.
 */
export function pinQualityLoopPolicyFields<P extends object>(next: P | null, previous: unknown): P | null {
  const prev =
    previous && typeof previous === "object" && !Array.isArray(previous) ? (previous as Record<string, unknown>) : {};
  const pinned: Record<string, unknown> = { ...((next ?? {}) as Record<string, unknown>) };
  for (const field of QUALITY_LOOP_POLICY_FIELDS) {
    if (prev[field] !== undefined) pinned[field] = prev[field];
    else delete pinned[field];
  }
  const stages = Array.isArray(pinned.stages) ? pinned.stages : [];
  const hasQuality = QUALITY_LOOP_POLICY_FIELDS.some((field) => pinned[field] !== undefined);
  if (!next && !hasQuality) return null;
  if (stages.length === 0 && !pinned.monitor && !pinned.reviewPreset && !pinned.authorizationPolicy && !hasQuality) {
    return null;
  }
  if (!next) {
    // An agent cleared the policy: keep only the person-set quality fields.
    return { mode: "normal", commentRequired: true, stages: [], ...pickQuality(pinned) } as unknown as P;
  }
  return pinned as P;
}

function pickQuality(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of QUALITY_LOOP_POLICY_FIELDS) if (source[field] !== undefined) out[field] = source[field];
  return out;
}

export async function readQualityLoopSettingsRow(db: Db, companyId: string): Promise<SettingsRow | null> {
  const [row] = await db
    .select()
    .from(companyQualityLoopSettings)
    .where(eq(companyQualityLoopSettings.companyId, companyId));
  return row ?? null;
}

/**
 * The saved model the finish check uses: the explicit pick, else the helper's default
 * saved model. Archived or foreign entries do not count. Null = the company has none.
 */
export async function resolveDoneCheckModel(
  db: Db,
  companyId: string,
  row: Pick<SettingsRow, "doneCheckDirectoryEntryId"> | null,
): Promise<{ directoryEntryId: string; name: string } | null> {
  const candidates: string[] = [];
  if (row?.doneCheckDirectoryEntryId) candidates.push(row.doneCheckDirectoryEntryId);
  const [helperRow] = await db
    .select({ defaultDirectoryEntryId: companyHelperSettings.defaultDirectoryEntryId })
    .from(companyHelperSettings)
    .where(eq(companyHelperSettings.companyId, companyId));
  if (helperRow?.defaultDirectoryEntryId) candidates.push(helperRow.defaultDirectoryEntryId);
  for (const id of candidates) {
    const [entry] = await db
      .select({ id: modelDirectoryEntries.id, name: modelDirectoryEntries.name })
      .from(modelDirectoryEntries)
      .where(
        and(
          eq(modelDirectoryEntries.id, id),
          eq(modelDirectoryEntries.companyId, companyId),
          isNull(modelDirectoryEntries.archivedAt),
        ),
      );
    if (entry) return { directoryEntryId: entry.id, name: entry.name };
  }
  return null;
}

export function qualityLoopSettingsService(db: Db) {
  async function get(companyId: string): Promise<CompanyQualityLoopSettings> {
    const row = await readQualityLoopSettingsRow(db, companyId);
    const effective = resolveEffectiveQualityLoops(row, null);
    return {
      configured: Boolean(row),
      selfReviewPasses: effective.selfReviewPasses,
      doneCheckEnabled: effective.doneCheckEnabled,
      doneCheckMaxRounds: effective.doneCheckMaxRounds,
      doneCheckDirectoryEntryId: row?.doneCheckDirectoryEntryId ?? null,
      effectiveDoneCheckModel: await resolveDoneCheckModel(db, companyId, row),
      defaultReviewerAgentId: row?.defaultReviewerAgentId ?? null,
    };
  }

  async function update(
    companyId: string,
    patch: UpdateCompanyQualityLoopSettings,
    actor: { userId: string | null },
  ): Promise<CompanyQualityLoopSettings> {
    if (patch.doneCheckDirectoryEntryId) {
      const [entry] = await db
        .select({ id: modelDirectoryEntries.id, archivedAt: modelDirectoryEntries.archivedAt })
        .from(modelDirectoryEntries)
        .where(
          and(
            eq(modelDirectoryEntries.id, patch.doneCheckDirectoryEntryId),
            eq(modelDirectoryEntries.companyId, companyId),
          ),
        );
      if (!entry) throw unprocessable("That saved model is not in this company's model list.");
      if (entry.archivedAt) throw unprocessable("That saved model is archived. Pick another one.");
    }
    if (patch.defaultReviewerAgentId) {
      const [agent] = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, patch.defaultReviewerAgentId));
      if (!agent || agent.companyId !== companyId) throw unprocessable("That agent is not part of this company.");
    }
    const set: Partial<typeof companyQualityLoopSettings.$inferInsert> = {
      updatedAt: new Date(),
      updatedByUserId: actor.userId,
    };
    if (patch.selfReviewPasses !== undefined) set.selfReviewPasses = patch.selfReviewPasses;
    if (patch.doneCheckEnabled !== undefined) set.doneCheckEnabled = patch.doneCheckEnabled;
    if (patch.doneCheckMaxRounds !== undefined) set.doneCheckMaxRounds = patch.doneCheckMaxRounds;
    if (patch.doneCheckDirectoryEntryId !== undefined) set.doneCheckDirectoryEntryId = patch.doneCheckDirectoryEntryId;
    if (patch.defaultReviewerAgentId !== undefined) set.defaultReviewerAgentId = patch.defaultReviewerAgentId;
    await db
      .insert(companyQualityLoopSettings)
      .values({ companyId, ...set })
      .onConflictDoUpdate({ target: companyQualityLoopSettings.companyId, set });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "company.quality_loops_updated",
      entityType: "company",
      entityId: companyId,
      details: { ...patch },
    });
    return get(companyId);
  }

  /** A brand-new company starts with the self-check on and the (paid) finish check off. Never overwrites a choice. */
  async function applyNewCompanyDefaults(companyId: string): Promise<void> {
    await db
      .insert(companyQualityLoopSettings)
      .values({
        companyId,
        selfReviewPasses: QUALITY_LOOPS_NEW_COMPANY_DEFAULTS.selfReviewPasses,
        doneCheckEnabled: QUALITY_LOOPS_NEW_COMPANY_DEFAULTS.doneCheckEnabled,
        doneCheckMaxRounds: QUALITY_LOOPS_NEW_COMPANY_DEFAULTS.doneCheckMaxRounds,
      })
      .onConflictDoNothing();
  }

  return { get, update, applyNewCompanyDefaults };
}

// ---------------------------------------------------------------------------
// 1. Self-check pass
// ---------------------------------------------------------------------------

const OUTSTANDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];

function wakeIsForIssue(issueId: string) {
  return sql`(${agentWakeupRequests.payload} ->> 'issueId' = ${issueId} or ${agentWakeupRequests.payload} ->> 'taskId' = ${issueId})`;
}

/** Self-review passes this task has had scheduled (both kinds), never-scheduled (skipped) ones excluded. */
export async function countUsedSelfReviewPasses(db: Db, input: { companyId: string; issueId: string }): Promise<number> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, SELF_REVIEW_PASS_REASON),
        ne(agentWakeupRequests.status, "skipped"),
        wakeIsForIssue(input.issueId),
      ),
    );
  return rows.length;
}

/** A self-review pass still waiting to run (or running) for this task, other than the caller's own run. */
async function findOutstandingSelfReviewPass(
  db: Db,
  input: { companyId: string; issueId: string; currentRunId: string },
) {
  const rows = await db
    .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, SELF_REVIEW_PASS_REASON),
        inArray(agentWakeupRequests.status, OUTSTANDING_WAKE_STATUSES),
        wakeIsForIssue(input.issueId),
      ),
    );
  return rows.find((row) => row.runId !== input.currentRunId) ?? null;
}

export function buildQualitySelfReviewInstruction(input: {
  issueIdentifier: string | null;
  pass: number;
  totalPasses: number;
  requestedStatus: string;
}): string {
  const label = input.issueIdentifier ?? "this task";
  return [
    `Self-check before ${label} is finished (check ${input.pass} of ${input.totalPasses}).`,
    "",
    "Read the task again -- its description, any acceptance criteria, and what the person asked for in the comments -- and compare it with what was actually done:",
    "1. Make a short list of everything the task asked for.",
    "2. For each item, check the real result (files, pages, data, messages), not your memory of doing it. If the task asked for a number of things (for example \"convert all 300 texts\"), count what was actually done.",
    "3. Write down anything that is not done, only partly done, or done differently than asked.",
    "4. Fix what is missing. Do not add work the task did not ask for.",
    `5. Then move the task to \`${input.requestedStatus}\` again with a comment that says what you checked, what you fixed, and anything that is still not done and why.`,
    "",
    "Who is reading this:",
    "- If your request to finish was just refused: stop here. A separate self-check run has been scheduled; do not retry in this run.",
    "- If you were woken up for this self-check: you are that run. Do the steps above now and finish the task yourself.",
  ].join("\n");
}

export interface QualitySelfReviewGateInput {
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
}

/**
 * Returns null when the move may go ahead; otherwise the refusal message (the route
 * answers 409). Never gates a person. Bounded by the effective selfReviewPasses.
 */
export async function evaluateQualitySelfReviewGate(input: QualitySelfReviewGateInput): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "in_review" && input.requestedStatus !== "done") return null;
  if (input.currentStatus === input.requestedStatus) return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
  const { db, issue } = input;

  let row: SettingsRow | null;
  try {
    row = await readQualityLoopSettingsRow(db, issue.companyId);
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality self-check: could not read settings; treating as off");
    return null;
  }
  const effective = resolveEffectiveQualityLoops(row, issue.executionPolicy);
  if (effective.selfReviewPasses <= 0) return null;
  if (!input.actor.runId) return { message: MISSING_RUN_ID_GATE_MESSAGE };
  const sourceRunId = input.actor.runId;

  const waitMessage =
    "This task gets a self-check before it can move to review or done, and that self-check is already scheduled as a separate run. Don't retry this in the current run; the self-check run will finish the task.";

  // A pass already waiting (or running for someone else) -- e.g. this same run retrying.
  if (await findOutstandingSelfReviewPass(db, { companyId: issue.companyId, issueId: issue.id, currentRunId: sourceRunId })) {
    return { message: waitMessage };
  }
  const used = await countUsedSelfReviewPasses(db, { companyId: issue.companyId, issueId: issue.id });
  if (used >= effective.selfReviewPasses) return null;

  const pass = used + 1;
  const instruction = buildQualitySelfReviewInstruction({
    issueIdentifier: issue.identifier,
    pass,
    totalPasses: effective.selfReviewPasses,
    requestedStatus: input.requestedStatus,
  });

  let notScheduled: SelfReviewGateWakeupNotScheduledInfo | undefined;
  try {
    await input.wakeup(input.actor.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {
        issueId: issue.id,
        taskId: issue.id,
        resumeIntent: true,
        resumeFromRunId: sourceRunId,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        qualityLoop: true,
        pass,
        instruction,
      },
      contextSnapshot: {
        issueId: issue.id,
        wakeReason: SELF_REVIEW_PASS_REASON,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        resumeFromRunId: sourceRunId,
        // Same as self-review-gate.ts: land on a fresh run, not coalesced into this one.
        requiresDistinctRunBoundary: true,
      },
      idempotencyKey: [QUALITY_SELF_REVIEW_KEY_PREFIX, issue.id, sourceRunId].join(":"),
      requestedByActorType: "system",
      requestedByActorId: "quality_self_review",
      onNotScheduled: (info) => {
        notScheduled = info;
      },
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality self-check: could not schedule the pass; letting the move through");
    return null;
  }
  if (notScheduled?.kind === "skipped") {
    // Paused agent, spending limit, heartbeat off, ...: nothing will run, so do not hold
    // the work hostage -- but leave a trace of why the check did not happen.
    try {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "quality_self_review",
        action: "issue.quality_self_review_skipped",
        entityType: "issue",
        entityId: issue.id,
        agentId: input.actor.agentId,
        runId: sourceRunId,
        details: { reason: notScheduled.reason, pass, totalPasses: effective.selfReviewPasses },
      });
    } catch {
      // best-effort
    }
    return null;
  }

  try {
    await db.insert(issueComments).values({
      companyId: issue.companyId,
      issueId: issue.id,
      authorType: "system",
      body: instruction,
      createdByRunId: sourceRunId,
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality self-check: could not post the instruction comment");
  }
  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "quality_self_review",
      action: "issue.quality_self_review_scheduled",
      entityType: "issue",
      entityId: issue.id,
      agentId: input.actor.agentId,
      runId: sourceRunId,
      details: { pass, totalPasses: effective.selfReviewPasses, requestedStatus: input.requestedStatus },
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality self-check: could not write the activity row");
  }
  return {
    message:
      `Before this task can move to ${input.requestedStatus}, it gets a self-check (${pass} of ${effective.selfReviewPasses}). ` +
      "A separate run has been scheduled to compare the work with what the task asked for, fix what is missing, and then finish it. " +
      "Don't retry in this run.",
  };
}

// ---------------------------------------------------------------------------
// 2. Independent finish check
// ---------------------------------------------------------------------------

export function noDoneCheckModelReason(): string {
  return (
    "This company has no saved model for the finish check yet. An owner or admin can pick one under " +
    `${QUALITY_SETTINGS_PATH} (or set a default model for the helper). Until then, tasks an agent marks done are not checked.`
  );
}

/** The finish check's reviewer: one call to the company's saved model through the helper's path. */
export function createSavedModelDoneCheckCritic(
  db: Db,
  input: { companyId: string; directoryEntryId: string; agentId: string; issueId: string },
  options: HelperServiceOptions = {},
): DoneGateCritic {
  return async (criticInput) => {
    const { helperService } = await import("./helper.js");
    const helper = helperService(db, options);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the finish check's model did not answer in time")), QUALITY_CHECK_TIMEOUT_MS);
    });
    try {
      const completion = await Promise.race([
        helper.completeWithSavedModel({
          companyId: input.companyId,
          directoryEntryId: input.directoryEntryId,
          system: buildDoneGateCriticSystemPrompt(),
          user: buildDoneGateCriticUserMessage(criticInput),
          maxTokens: QUALITY_CHECK_MAX_OUTPUT_TOKENS,
          billingCode: QUALITY_CHECK_BILLING_CODE,
          agentId: input.agentId,
          issueId: input.issueId,
        }),
        timeout,
      ]);
      const parsed = parseDoneGateCriticReply(completion.text);
      if (!parsed) throw new DoneGateUnreadableReplyError();
      // Cost is already in the ledger (completeWithSavedModel), so no usage here.
      return { ...parsed, usage: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export interface QualityDoneCheckInput {
  db: Db;
  issue: DoneGateEvaluationInput["issue"] & { executionPolicy: unknown; projectId?: string | null };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  patchComment?: string | null;
  /** Test seam: replaces the saved-model reviewer. */
  critic?: DoneGateCritic;
  helperOptions?: HelperServiceOptions;
}

export type QualityDoneCheckOutcome =
  /** The company/task has not switched the check on: fall back to the instance-wide gate. */
  | { applies: false }
  /** The company check owns this move: `result` null = let it through, else refuse (409). */
  | { applies: true; result: DoneGateEvaluationResult | null };

export async function evaluateQualityDoneCheck(input: QualityDoneCheckInput): Promise<QualityDoneCheckOutcome> {
  if (input.requestedStatus !== "done" || input.currentStatus === "done") return { applies: false };
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return { applies: false };
  const { db, issue } = input;
  const agentId = input.actor.agentId;

  let row: SettingsRow | null;
  try {
    row = await readQualityLoopSettingsRow(db, issue.companyId);
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality finish check: could not read settings; treating as off");
    return { applies: false };
  }
  const effective = resolveEffectiveQualityLoops(row, issue.executionPolicy);
  if (!effective.doneCheckEnabled) return { applies: false };

  const noteSkipped = async (reason: string) => {
    let since: Date | null = null;
    try {
      since = await findDoneGateLoopResetAt(db, { companyId: issue.companyId, issueId: issue.id });
    } catch {
      // count from the start
    }
    await noteDoneGateCouldNotRun({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      sourceRunId: input.actor.runId ?? null,
      since,
      reason,
      settingsPath: QUALITY_SETTINGS_PATH,
    });
  };

  let critic = input.critic;
  if (!critic) {
    const model = await resolveDoneCheckModel(db, issue.companyId, row);
    if (!model) {
      await noteSkipped(noDoneCheckModelReason());
      return { applies: true, result: null };
    }
    critic = createSavedModelDoneCheckCritic(
      db,
      { companyId: issue.companyId, directoryEntryId: model.directoryEntryId, agentId, issueId: issue.id },
      input.helperOptions,
    );
  }

  // Respect spending limits: an agent or company that is out of budget does not spend on checks.
  try {
    const block = await budgetService(db).getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId ?? null,
    });
    if (block) {
      await noteSkipped(`A spending limit stops this check from running right now: ${block.reason}`);
      return { applies: true, result: null };
    }
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality finish check: could not read the spending limits; running the check");
  }

  // Watch the reviewer so a failed or unreadable check is recorded as "not checked",
  // never as a pass.
  let checkFailure: unknown = null;
  const reviewer = critic;
  const watchedCritic: DoneGateCritic = async (criticInput) => {
    try {
      return await reviewer(criticInput);
    } catch (err) {
      checkFailure = err ?? new Error("unknown failure");
      throw err;
    }
  };

  const result = await evaluateDoneGateCritic({
    db,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      companyId: issue.companyId,
      title: issue.title,
      description: issue.description,
    },
    actor: input.actor,
    requestedStatus: input.requestedStatus,
    currentStatus: input.currentStatus,
    patchComment: input.patchComment ?? null,
    readGeneralSettings: async () => ({}) as never,
    configOverride: { mode: "enforce", maxRounds: effective.doneCheckMaxRounds },
    critic: watchedCritic,
    unavailableReason: (err) =>
      err instanceof DoneGateUnreadableReplyError
        ? "The company's saved model for the finish check answered with something that could not be read as a verdict, so this task was NOT checked. If this keeps happening, pick a different (more capable) model for the check."
        : "The company's saved model for the finish check could not be reached, so this task was NOT checked. This is usually temporary; the next task will be checked again.",
    settingsPath: QUALITY_SETTINGS_PATH,
  });
  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "quality_check",
      action: "issue.quality_check_ran",
      entityType: "issue",
      entityId: issue.id,
      agentId,
      runId: input.actor.runId ?? null,
      details: {
        outcome: result
          ? result.escalated
            ? "asked_the_person"
            : "not_done"
          : checkFailure
            ? checkFailure instanceof DoneGateUnreadableReplyError
              ? "not_checked_unreadable_answer"
              : "not_checked_model_unreachable"
            : "passed",
        findings: result?.findings ?? [],
      },
    });
  } catch {
    // best-effort
  }
  return { applies: true, result };
}

/**
 * Called when a run finishes (heartbeat.ts handleSuccessfulRunHandoff). If, during that
 * run, the finish check sent the task back and the agent ended without fixing it, wake
 * the agent once to work on the findings. Bounded: one wake per run that was sent back,
 * and the check's own rounds cap how many such runs there can be.
 */
export async function maybeScheduleQualityCheckFollowUp(input: {
  db: Db;
  run: { id: string; agentId: string; companyId: string };
  issue: {
    id: string;
    companyId: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    executionPolicy: unknown;
  };
  wakeup: SelfReviewGateWakeup;
}): Promise<boolean> {
  const { db, run, issue } = input;
  if (issue.status !== "in_progress") return false;
  if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId) return false;
  const row = await readQualityLoopSettingsRow(db, issue.companyId);
  if (!resolveEffectiveQualityLoops(row, issue.executionPolicy).doneCheckEnabled) return false;

  const [sentBack] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        eq(issueComments.authorType, "system"),
        isNull(issueComments.authorAgentId),
        isNull(issueComments.authorUserId),
        eq(issueComments.createdByRunId, run.id),
        sql`${issueComments.body} like ${`${DONE_GATE_NEEDS_WORK_PREFIX}%`}`,
      ),
    )
    .limit(1);
  if (!sentBack) return false;

  let notScheduled: SelfReviewGateWakeupNotScheduledInfo | undefined;
  try {
    await input.wakeup(run.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: QUALITY_CHECK_FOLLOW_UP_REASON,
      payload: {
        issueId: issue.id,
        taskId: issue.id,
        resumeIntent: true,
        resumeFromRunId: run.id,
        qualityLoop: true,
      },
      contextSnapshot: {
        issueId: issue.id,
        wakeReason: QUALITY_CHECK_FOLLOW_UP_REASON,
        resumeFromRunId: run.id,
        qualityCheckFollowUpOf: run.id,
      },
      idempotencyKey: [QUALITY_CHECK_FOLLOW_UP_REASON, issue.id, run.id].join(":"),
      requestedByActorType: "system",
      requestedByActorId: "quality_check",
      onNotScheduled: (info) => {
        notScheduled = info;
      },
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "quality finish check: could not wake the agent to fix the findings");
    return false;
  }
  if (notScheduled?.kind === "skipped") return false;
  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "quality_check",
      action: "issue.quality_check_follow_up_scheduled",
      entityType: "issue",
      entityId: issue.id,
      agentId: run.agentId,
      runId: run.id,
      details: {},
    });
  } catch {
    // best-effort
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. Default reviewer for new code tasks
// ---------------------------------------------------------------------------

/**
 * At task creation: when the creator set no execution policy, the task belongs to a
 * code project (a git-backed workspace), and the company picked a default reviewer,
 * returns a policy with that agent as the review stage ("have <agent> review before
 * done"). Otherwise returns the given policy unchanged. Never makes an agent its own reviewer.
 */
export async function applyDefaultReviewerPolicy<T>(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null | undefined;
    assigneeAgentId: string | null | undefined;
    requestedPolicy: unknown;
    normalizedPolicy: T;
    normalize: (policy: unknown) => T;
  },
): Promise<T> {
  if (input.requestedPolicy != null || input.normalizedPolicy) return input.normalizedPolicy;
  try {
    const row = await readQualityLoopSettingsRow(db, input.companyId);
    const reviewerId = row?.defaultReviewerAgentId ?? null;
    if (!reviewerId || reviewerId === input.assigneeAgentId) return input.normalizedPolicy;
    const [reviewer] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, reviewerId), eq(agents.companyId, input.companyId)));
    if (!reviewer || reviewer.status === "terminated") return input.normalizedPolicy;
    if (!(await issueProjectHasGitWorkspace(db, input.companyId, input.projectId))) return input.normalizedPolicy;
    return input.normalize({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
  } catch (err) {
    logger.warn({ err, companyId: input.companyId }, "quality loops: could not apply the default reviewer");
    return input.normalizedPolicy;
  }
}
