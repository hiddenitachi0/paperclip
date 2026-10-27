import { and, asc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companyAgentRoles,
  contractDeadlineReminders,
  contractDeadlines,
  contracts,
  issues,
} from "@paperclipai/db";
import {
  CONTRACT_DEADLINE_ORIGIN_KIND,
  type ContractDeadlineKind,
  type IssuePriority,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * Contract-deadline reminders (Legal Phase 3, DUR-4855 under DUR-4851).
 *
 * `syncDeadline` is the one place that decides what reminder issues a deadline
 * should have; the daily sweep, the deadline routes and the version-link route
 * all call it, so a date edit or a status change and the next sweep can never
 * disagree. It runs without any agent.
 *
 * Idempotency has three layers: contract_deadline_reminders (unique per
 * deadline and lead step) is the permanent record, the origin fingerprint
 * check in issueService.create refuses a second open issue for the same step,
 * and issues_active_contract_deadline_reminder_uq backs that at the database
 * for two sweeps racing.
 *
 * Confidentiality: the issue carries the contract title and clause reference
 * (the ticket asks for them) and never any extracted text, summary, term value
 * or deadline note. Activity entries and log lines carry ids, enums and
 * counts only.
 */

export const LEGAL_POSITION_ROLE_KEY = "legal-advisor";

const KIND_LABEL: Record<ContractDeadlineKind, string> = {
  notice_extend: "notice to extend",
  notice_terminate: "notice to terminate",
  expiry: "expiry",
  renewal: "renewal",
  price_review: "price review",
  payment: "payment",
  reporting: "reporting",
  other: "deadline",
};

const OWNER_ACTION: Partial<Record<ContractDeadlineKind, string>> = {
  notice_extend: "Decide whether to extend the contract and give notice in time",
  notice_terminate: "Decide whether to terminate the contract and give notice in time",
  renewal: "Decide whether to renew the contract",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// ---------------------------------------------------------------- pure helpers

/** Today as a UTC calendar date (YYYY-MM-DD). */
export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (both YYYY-MM-DD); negative when `toIso` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** Fewer days left, higher priority; overdue is critical. */
export function reminderPriority(daysLeft: number): IssuePriority {
  if (daysLeft <= 2) return "critical";
  if (daysLeft <= 14) return "high";
  return "medium";
}

export interface ReminderPlan {
  /** Existing lead steps that no longer apply (date moved later, step removed): close and forget them. */
  stale: number[];
  /** Missing steps that are due but not the most urgent: recorded without an issue. */
  skipped: number[];
  /** The one step to open an issue for now, or null. */
  create: number | null;
}

/**
 * What a deadline should do right now. `leads` are the configured lead steps,
 * `existing` the steps that already have a reminder row.
 *
 * A step is due once `daysLeft <= lead`. Of the due steps that have no row
 * yet only the most urgent (smallest lead) opens an issue, and only when it is
 * more urgent than every step already on record: a deadline created inside its
 * 7-day step gets one 7-day issue, not a 60-, 30- and 7-day pile.
 */
export function planReminderSteps(input: {
  daysLeft: number;
  leads: readonly number[];
  existing: readonly number[];
}): ReminderPlan {
  const leads = [...new Set(input.leads)].sort((a, b) => b - a);
  const due = leads.filter((lead) => input.daysLeft <= lead);
  const dueSet = new Set(due);
  const existing = new Set(input.existing);
  const stale = [...existing].filter((lead) => !dueSet.has(lead)).sort((a, b) => b - a);
  const kept = [...existing].filter((lead) => dueSet.has(lead));
  const missing = due.filter((lead) => !existing.has(lead));
  if (missing.length === 0) return { stale, skipped: [], create: null };
  const mostUrgent = Math.min(...missing);
  const moreUrgentThanKept = kept.every((lead) => mostUrgent < lead);
  if (!moreUrgentThanKept) return { stale, skipped: missing, create: null };
  return { stale, skipped: missing.filter((lead) => lead !== mostUrgent), create: mostUrgent };
}

function formatDate(iso: string, todayIso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const base = `${day} ${MONTHS[(month ?? 1) - 1]}`;
  return year === Number(todayIso.slice(0, 4)) ? base : `${base} ${year}`;
}

function daysLeftText(daysLeft: number): string {
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === 1) return "1 day left";
  if (daysLeft === 0) return "due today";
  return daysLeft === -1 ? "overdue by 1 day" : `overdue by ${-daysLeft} days`;
}

export function renderReminder(input: {
  contractId: string;
  contractTitle: string;
  kind: ContractDeadlineKind;
  dueDate: string;
  clauseRef: string | null;
  leadDays: number;
  daysLeft: number;
  needsOwner: boolean;
  todayIso: string;
}): { title: string; description: string; priority: IssuePriority } {
  const label = KIND_LABEL[input.kind] ?? "deadline";
  const contractTitle = input.contractTitle.trim().slice(0, 100);
  const title = `Contract deadline: ${contractTitle} - ${label} by ${formatDate(input.dueDate, input.todayIso)} (${daysLeftText(input.daysLeft)})`;
  const lines = [
    "A contract deadline needs attention. This reminder was opened automatically by the daily contract-deadline check.",
    "",
    `- Contract: ${contractTitle} (contract id \`${input.contractId}\`)`,
    `- Deadline: ${label}, ${input.dueDate}`,
  ];
  if (input.clauseRef?.trim()) lines.push(`- Clause: ${input.clauseRef.trim().slice(0, 200)}`);
  lines.push(`- Reminder step: ${input.leadDays} days before the deadline`);
  if (input.needsOwner) {
    lines.push(
      "",
      "Human owner: Contract owner",
      `Human action: ${OWNER_ACTION[input.kind] ?? "Review the deadline and decide what to do"} before ${input.dueDate}`,
    );
  }
  lines.push(
    "",
    "Open the contract in the register for the details. This issue holds no contract text.",
    "Marking the deadline done or dismissed in the register closes this reminder.",
  );
  return { title, description: lines.join("\n"), priority: reminderPriority(input.daysLeft) };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; status?: number; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "23505" || e?.status === 409;
}

// ---------------------------------------------------------------- service

type DeadlineContext = {
  deadlineId: string;
  companyId: string;
  contractId: string;
  contractTitle: string;
  contractStatus: string;
  kind: ContractDeadlineKind;
  dueDate: string;
  leadTimesDays: number[];
  clauseRef: string | null;
  needsOwner: boolean;
  state: string;
  companyStatus: string;
};

export interface DeadlineSyncResult {
  created: number;
  skipped: number;
  closed: number;
  updated: number;
}

export interface ReminderSweepResult extends DeadlineSyncResult {
  deadlines: number;
  errors: number;
}

const EMPTY_RESULT = (): DeadlineSyncResult => ({ created: 0, skipped: 0, closed: 0, updated: 0 });

export function contractDeadlineReminderService(
  db: Db,
  deps: { heartbeat?: IssueAssignmentWakeupDeps } = {},
) {
  const issuesSvc = issueService(db);

  async function loadContext(companyId: string, where: SQL | undefined): Promise<DeadlineContext[]> {
    // The contract join repeats the company id: a deadline whose contract is
    // not in the deadline's own company is invisible here (creates nothing).
    return db
      .select({
        deadlineId: contractDeadlines.id,
        companyId: contractDeadlines.companyId,
        contractId: contracts.id,
        contractTitle: contracts.title,
        contractStatus: contracts.status,
        kind: contractDeadlines.kind,
        dueDate: contractDeadlines.dueDate,
        leadTimesDays: contractDeadlines.leadTimesDays,
        clauseRef: contractDeadlines.clauseRef,
        needsOwner: contractDeadlines.needsOwner,
        state: contractDeadlines.state,
        companyStatus: companies.status,
      })
      .from(contractDeadlines)
      .innerJoin(
        contracts,
        and(eq(contracts.id, contractDeadlines.contractId), eq(contracts.companyId, contractDeadlines.companyId)),
      )
      .innerJoin(companies, eq(companies.id, contractDeadlines.companyId))
      .where(and(eq(contractDeadlines.companyId, companyId), where))
      .orderBy(asc(contractDeadlines.dueDate)) as unknown as Promise<DeadlineContext[]>;
  }

  async function findLegalAgentId(companyId: string): Promise<string | null> {
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(
        companyAgentRoles,
        and(eq(companyAgentRoles.id, agents.roleId), eq(companyAgentRoles.companyId, agents.companyId)),
      )
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(companyAgentRoles.key, LEGAL_POSITION_ROLE_KEY),
          notInArray(agents.status, ["terminated", "pending_approval"]),
        ),
      )
      .orderBy(asc(agents.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  async function findOpenReminderIssue(companyId: string, deadlineId: string, fingerprint: string) {
    return db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, CONTRACT_DEADLINE_ORIGIN_KIND),
          eq(issues.originId, deadlineId),
          eq(issues.originFingerprint, fingerprint),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function cancelReminderIssue(companyId: string, issueId: string, reason: string): Promise<boolean> {
    const issue = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.status === "done" || issue.status === "cancelled") return false;
    await issuesSvc.addComment(issue.id, reason, {}, { authorType: "system" });
    await issuesSvc.update(issue.id, { status: "cancelled" });
    return true;
  }

  async function deleteReminderRows(companyId: string, deadlineId: string, leads: number[]) {
    if (leads.length === 0) return;
    await db
      .delete(contractDeadlineReminders)
      .where(
        and(
          eq(contractDeadlineReminders.companyId, companyId),
          eq(contractDeadlineReminders.deadlineId, deadlineId),
          inArray(contractDeadlineReminders.leadDays, leads),
        ),
      );
  }

  function closeReasonForState(state: string): string {
    if (state === "done") return "Closed automatically: the contract deadline was marked done.";
    if (state === "dismissed") return "Closed automatically: the contract deadline was dismissed.";
    if (state === "superseded") {
      return "Closed automatically: a newer version of the contract replaced this deadline.";
    }
    return "Closed automatically: this contract deadline no longer needs a reminder.";
  }

  async function closeRows(
    companyId: string,
    rows: Array<{ leadDays: number; issueId: string | null }>,
    deadlineId: string,
    reason: string,
  ): Promise<number> {
    let closed = 0;
    for (const row of rows) {
      if (row.issueId && (await cancelReminderIssue(companyId, row.issueId, reason))) closed += 1;
    }
    await deleteReminderRows(
      companyId,
      deadlineId,
      rows.map((row) => row.leadDays),
    );
    return closed;
  }

  async function syncContext(ctx: DeadlineContext, now: Date): Promise<DeadlineSyncResult> {
    const result = EMPTY_RESULT();
    const todayIso = utcDateString(now);
    const rows = await db
      .select({
        leadDays: contractDeadlineReminders.leadDays,
        issueId: contractDeadlineReminders.issueId,
      })
      .from(contractDeadlineReminders)
      .where(
        and(
          eq(contractDeadlineReminders.companyId, ctx.companyId),
          eq(contractDeadlineReminders.deadlineId, ctx.deadlineId),
        ),
      );

    const inactive = ctx.state !== "open" || ctx.contractStatus === "superseded";
    if (inactive) {
      // The rows go too, so reopening a deadline starts its reminders fresh.
      const reason = closeReasonForState(ctx.state === "open" ? "superseded" : ctx.state);
      result.closed += await closeRows(ctx.companyId, rows, ctx.deadlineId, reason);
      return result;
    }
    if (ctx.companyStatus !== "active") return result;

    const daysLeft = daysBetween(todayIso, ctx.dueDate);
    const plan = planReminderSteps({
      daysLeft,
      leads: ctx.leadTimesDays,
      existing: rows.map((row) => row.leadDays),
    });

    if (plan.stale.length > 0) {
      const staleRows = rows.filter((row) => plan.stale.includes(row.leadDays));
      result.closed += await closeRows(
        ctx.companyId,
        staleRows,
        ctx.deadlineId,
        "Closed automatically: the contract deadline changed, so this reminder step no longer applies. A new reminder opens when the new date comes within range.",
      );
    }

    // Keep the still-valid open reminders current: new date, days left, priority.
    for (const row of rows) {
      if (plan.stale.includes(row.leadDays) || !row.issueId) continue;
      if (await refreshReminderIssue(ctx, row.leadDays, row.issueId, daysLeft, todayIso)) result.updated += 1;
    }

    if (plan.skipped.length > 0) {
      await db
        .insert(contractDeadlineReminders)
        .values(plan.skipped.map((leadDays) => ({ companyId: ctx.companyId, deadlineId: ctx.deadlineId, leadDays, issueId: null })))
        .onConflictDoNothing({ target: [contractDeadlineReminders.deadlineId, contractDeadlineReminders.leadDays] });
      result.skipped += plan.skipped.length;
    }

    if (plan.create !== null) {
      if (await openReminderIssue(ctx, plan.create, daysLeft, todayIso)) result.created += 1;
    }
    return result;
  }

  async function refreshReminderIssue(
    ctx: DeadlineContext,
    leadDays: number,
    issueId: string,
    daysLeft: number,
    todayIso: string,
  ): Promise<boolean> {
    const issue = await db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        dueDate: issues.dueDate,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, ctx.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.status === "done" || issue.status === "cancelled") return false;
    const rendered = renderReminder({
      contractId: ctx.contractId,
      contractTitle: ctx.contractTitle,
      kind: ctx.kind,
      dueDate: ctx.dueDate,
      clauseRef: ctx.clauseRef,
      leadDays,
      daysLeft,
      needsOwner: ctx.needsOwner,
      todayIso,
    });
    const patch: Partial<typeof issues.$inferInsert> = {};
    if (issue.title !== rendered.title) patch.title = rendered.title;
    if (issue.dueDate !== ctx.dueDate) patch.dueDate = ctx.dueDate;
    // The text is rewritten only when the date moved or the deadline moved to
    // another contract version; otherwise a person's additions to it stay.
    if (issue.dueDate !== ctx.dueDate || !issue.description?.includes(`\`${ctx.contractId}\``)) {
      patch.description = rendered.description;
    }
    // Priority only ever goes up: someone may have raised it by hand.
    if ((PRIORITY_RANK[rendered.priority] ?? 0) > (PRIORITY_RANK[issue.priority] ?? 0)) {
      patch.priority = rendered.priority;
    }
    if (Object.keys(patch).length === 0) return false;
    await db
      .update(issues)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, ctx.companyId)));
    return true;
  }

  async function openReminderIssue(
    ctx: DeadlineContext,
    leadDays: number,
    daysLeft: number,
    todayIso: string,
  ): Promise<boolean> {
    const fingerprint = `${ctx.deadlineId}:${leadDays}`;
    const rendered = renderReminder({
      contractId: ctx.contractId,
      contractTitle: ctx.contractTitle,
      kind: ctx.kind,
      dueDate: ctx.dueDate,
      clauseRef: ctx.clauseRef,
      leadDays,
      daysLeft,
      needsOwner: ctx.needsOwner,
      todayIso,
    });
    // The Legal agent of this company, or nobody: an unassigned issue is
    // visible to the board. Never an agent of another company.
    const legalAgentId = await findLegalAgentId(ctx.companyId);
    // An owner decision waits on a person ("Needs you" on the Now page, via the
    // human-action marker in the description) instead of landing in an agent's queue.
    const status = ctx.needsOwner ? "blocked" : "todo";

    const input = (assigneeAgentId: string | null) => ({
      title: rendered.title,
      description: rendered.description,
      status,
      priority: rendered.priority,
      assigneeAgentId,
      assigneeUserId: null,
      dueDate: ctx.dueDate,
      originKind: CONTRACT_DEADLINE_ORIGIN_KIND,
      originId: ctx.deadlineId,
      originFingerprint: fingerprint,
    });

    let issueId: string | null = null;
    let assigneeAgentId: string | null = null;
    let freshlyCreated = false;
    try {
      let created: { id: string; assigneeAgentId: string | null };
      try {
        created = await issuesSvc.create(ctx.companyId, input(legalAgentId));
      } catch (error) {
        const status422 = (error as { status?: number } | null)?.status === 422;
        if (!legalAgentId || !status422) throw error;
        // The Legal agent cannot take work right now (paused, ...): leave it unassigned.
        created = await issuesSvc.create(ctx.companyId, input(null));
      }
      issueId = created.id;
      assigneeAgentId = created.assigneeAgentId ?? null;
      freshlyCreated = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A sweep that died between creating the issue and recording the row, or
      // one racing this one: adopt the issue that is already there.
      const existing = await findOpenReminderIssue(ctx.companyId, ctx.deadlineId, fingerprint);
      if (!existing) throw error;
      issueId = existing.id;
    }

    await db
      .insert(contractDeadlineReminders)
      .values({ companyId: ctx.companyId, deadlineId: ctx.deadlineId, leadDays, issueId })
      .onConflictDoUpdate({
        target: [contractDeadlineReminders.deadlineId, contractDeadlineReminders.leadDays],
        set: { issueId },
      });

    if (!freshlyCreated) return false;

    await logActivity(db, {
      companyId: ctx.companyId,
      actorType: "system",
      actorId: "contract_deadline_reminders",
      action: "contract.deadline_reminder_opened",
      entityType: "issue",
      entityId: issueId,
      details: {
        deadlineId: ctx.deadlineId,
        contractId: ctx.contractId,
        leadDays,
        daysLeft,
        priority: rendered.priority,
        needsOwner: ctx.needsOwner,
        assigned: Boolean(assigneeAgentId),
      },
    });

    if (deps.heartbeat && assigneeAgentId && status === "todo") {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: { id: issueId, assigneeAgentId, status },
        reason: "contract_deadline_reminder",
        mutation: "create",
        contextSource: "contract_deadline.reminder",
        requestedByActorType: "system",
        requestedByActorId: "contract_deadline_reminders",
      });
    }
    return true;
  }

  function merge(total: DeadlineSyncResult, part: DeadlineSyncResult) {
    total.created += part.created;
    total.skipped += part.skipped;
    total.closed += part.closed;
    total.updated += part.updated;
  }

  return {
    /** Reconcile one deadline right now (after it was added, edited or its state changed). */
    syncDeadline: async (companyId: string, deadlineId: string, now: Date = new Date()): Promise<DeadlineSyncResult> => {
      const [ctx] = await loadContext(companyId, eq(contractDeadlines.id, deadlineId));
      return ctx ? syncContext(ctx, now) : EMPTY_RESULT();
    },

    /** Reconcile every deadline of a contract (after a version link moved or superseded some). */
    syncContract: async (companyId: string, contractId: string, now: Date = new Date()): Promise<DeadlineSyncResult> => {
      const total = EMPTY_RESULT();
      for (const ctx of await loadContext(companyId, eq(contractDeadlines.contractId, contractId))) {
        merge(total, await syncContext(ctx, now));
      }
      return total;
    },

    /** Close the open reminders of one deadline that is about to be deleted. */
    closeForDeadline: async (companyId: string, deadlineId: string): Promise<number> => {
      const rows = await db
        .select({ leadDays: contractDeadlineReminders.leadDays, issueId: contractDeadlineReminders.issueId })
        .from(contractDeadlineReminders)
        .where(
          and(
            eq(contractDeadlineReminders.companyId, companyId),
            eq(contractDeadlineReminders.deadlineId, deadlineId),
          ),
        );
      return closeRows(companyId, rows, deadlineId, "Closed automatically: the contract deadline was removed.");
    },

    /** Close the open reminders of every deadline of a contract that is about to be deleted. */
    closeForContract: async (companyId: string, contractId: string): Promise<number> => {
      const deadlineIds = await db
        .select({ id: contractDeadlines.id })
        .from(contractDeadlines)
        .where(and(eq(contractDeadlines.companyId, companyId), eq(contractDeadlines.contractId, contractId)));
      let closed = 0;
      for (const { id } of deadlineIds) {
        const rows = await db
          .select({ leadDays: contractDeadlineReminders.leadDays, issueId: contractDeadlineReminders.issueId })
          .from(contractDeadlineReminders)
          .where(
            and(
              eq(contractDeadlineReminders.companyId, companyId),
              eq(contractDeadlineReminders.deadlineId, id),
            ),
          );
        closed += await closeRows(companyId, rows, id, "Closed automatically: the contract was removed from the register.");
      }
      return closed;
    },

    /**
     * The daily sweep. Idempotent, so it can tick as often as the scheduler
     * likes: all state is in the database, nothing is held in memory. Covers
     * open deadlines (open reminders as their dates come in range) and any
     * deadline that is no longer open but still has an open reminder issue.
     */
    sweep: async (input: { now?: Date; companyIds?: string[] } = {}): Promise<ReminderSweepResult> => {
      const now = input.now ?? new Date();
      const total: ReminderSweepResult = { ...EMPTY_RESULT(), deadlines: 0, errors: 0 };

      const candidateCompanyIds = (
        await db
          .selectDistinct({ companyId: contractDeadlines.companyId })
          .from(contractDeadlines)
          .where(
            sql`${contractDeadlines.state} = 'open'
              or exists (select 1 from ${contractDeadlineReminders} r where r.deadline_id = ${contractDeadlines.id} and r.issue_id is not null)`,
          )
      )
        .map((row) => row.companyId)
        .filter((id) => !input.companyIds || input.companyIds.includes(id));

      for (const companyId of candidateCompanyIds) {
        const contexts = await loadContext(
          companyId,
          sql`${contractDeadlines.state} = 'open'
            or exists (select 1 from ${contractDeadlineReminders} r where r.deadline_id = ${contractDeadlines.id} and r.issue_id is not null)`,
        );
        for (const ctx of contexts) {
          total.deadlines += 1;
          try {
            merge(total, await syncContext(ctx, now));
          } catch (error) {
            total.errors += 1;
            // Ids only: never a contract title or a deadline note in a log line.
            logger.error(
              { err: error, companyId, deadlineId: ctx.deadlineId },
              "contract deadline reminder sync failed",
            );
          }
        }
      }
      return total;
    },
  };
}
