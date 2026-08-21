import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * DUR-68: if the customer-inbox secretary stalls on a message, the message
 * must not just sit there. Scoped to `originKind = 'routine_execution'` +
 * the inbox routine's id (not the current assignee), so a handed-off issue
 * stays observable by this same sweep for its one allowed follow-up notice.
 *
 * Exactly two actions ever happen per issue, gated by how many
 * `agent_wakeup_requests` rows with this reason already reference it
 * (mirrors `countCheapRunEscalationsForIssue`'s payload->>'issueId' shape):
 *   0 -> reassign to the secretary's reports_to, wake them, comment, touch inboxes.
 *   1 -> once another full timer period has elapsed, post a notice comment,
 *        touch inboxes, and stop. No second hand-off, ever.
 *   2+ -> untouched forever; an operator has to act.
 */

export const CUSTOMER_INBOX_HANDOFF_REASON = "customer_inbox.handoff";

const CANDIDATE_LIMIT = 50;

async function touchIssueForCompanyInboxes(
  db: Db,
  input: { companyId: string; issueId: string; touchedAt: Date },
) {
  const memberUserIds = await db
    .select({ principalId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );

  for (const { principalId: userId } of memberUserIds) {
    await db
      .insert(issueReadStates)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        userId,
        lastReadAt: input.touchedAt,
        updatedAt: input.touchedAt,
      })
      .onConflictDoUpdate({
        target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
        set: { lastReadAt: input.touchedAt, updatedAt: input.touchedAt },
      });
    await db
      .delete(issueInboxArchives)
      .where(
        and(
          eq(issueInboxArchives.companyId, input.companyId),
          eq(issueInboxArchives.issueId, input.issueId),
          eq(issueInboxArchives.userId, userId),
        ),
      );
  }
}

async function countCustomerInboxHandoffsForIssue(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<{ count: number; lastRequestedAt: Date | null }> {
  const rows = await db
    .select({ requestedAt: agentWakeupRequests.requestedAt })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, CUSTOMER_INBOX_HANDOFF_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      ),
    );
  const lastRequestedAt = rows.reduce<Date | null>((latest, row) => {
    const at = row.requestedAt instanceof Date ? row.requestedAt : new Date(row.requestedAt as unknown as string);
    return !latest || at > latest ? at : latest;
  }, null);
  return { count: rows.length, lastRequestedAt };
}

async function hasQueuedWakeForAgent(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "queued"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

type CandidateRow = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  createdAt: Date;
  secretaryAgentId: string;
  handOffAfterMinutes: number;
};

async function findDueCandidates(db: Db, now: Date): Promise<CandidateRow[]> {
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      createdAt: issues.createdAt,
      secretaryAgentId: routines.assigneeAgentId,
      handOffAfterMinutes: sql<number>`(${agents.runtimeConfig} ->> 'handOffUnhandledAfterMinutes')::int`,
    })
    .from(issues)
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .innerJoin(routines, sql`${routines.id}::text = ${issues.originId}`)
    .innerJoin(
      routineTriggers,
      and(eq(routineTriggers.routineId, routines.id), sql`${routineTriggers.customerInboxChannel} is not null`),
    )
    .innerJoin(agents, eq(agents.id, routines.assigneeAgentId))
    .where(
      and(
        eq(companies.status, "active"),
        eq(issues.originKind, "routine_execution"),
        eq(issues.status, "todo"),
        isNull(issues.executionRunId),
        isNull(issues.hiddenAt),
        sql`(${agents.runtimeConfig} ->> 'handOffUnhandledAfterMinutes') is not null`,
        sql`(${agents.runtimeConfig} ->> 'handOffUnhandledAfterMinutes')::int > 0`,
        sql`${issues.createdAt} + ((${agents.runtimeConfig} ->> 'handOffUnhandledAfterMinutes')::int * interval '1 minute') <= ${now}`,
      ),
    )
    .orderBy(issues.createdAt)
    .limit(CANDIDATE_LIMIT);
  return rows as CandidateRow[];
}

export async function tickCustomerInboxHandoff(
  db: Db,
  heartbeat: IssueAssignmentWakeupDeps,
  now: Date = new Date(),
) {
  const candidates = await findDueCandidates(db, now);
  let reassigned = 0;
  let noticed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      if (candidate.assigneeAgentId && await hasQueuedWakeForAgent(db, {
        companyId: candidate.companyId,
        agentId: candidate.assigneeAgentId,
        issueId: candidate.id,
      })) {
        skipped += 1;
        continue;
      }

      const { count, lastRequestedAt } = await countCustomerInboxHandoffsForIssue(db, {
        companyId: candidate.companyId,
        issueId: candidate.id,
      });

      if (count === 0) {
        const secretary = await db
          .select({ reportsTo: agents.reportsTo })
          .from(agents)
          .where(eq(agents.id, candidate.secretaryAgentId))
          .then((r) => r[0] ?? null);
        const reportsToAgentId = secretary?.reportsTo ?? null;
        if (!reportsToAgentId) {
          logger.warn(
            { issueId: candidate.id, secretaryAgentId: candidate.secretaryAgentId },
            "customer-inbox hand-off: secretary has no reports_to, cannot hand off",
          );
          skipped += 1;
          continue;
        }

        const claimed = await db
          .update(issues)
          .set({ assigneeAgentId: reportsToAgentId, updatedAt: now })
          .where(
            and(
              eq(issues.id, candidate.id),
              eq(issues.status, "todo"),
              isNull(issues.executionRunId),
              isNull(issues.hiddenAt),
            ),
          )
          .returning({ id: issues.id });
        if (claimed.length === 0) {
          skipped += 1;
          continue;
        }

        await db.insert(issueComments).values({
          companyId: candidate.companyId,
          issueId: candidate.id,
          authorType: "system",
          body:
            "Denne kundehenvendelsen ble ikke behandlet av sekretæren innen fristen, så den er sendt videre til deg.",
        });
        await touchIssueForCompanyInboxes(db, { companyId: candidate.companyId, issueId: candidate.id, touchedAt: now });
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: candidate.id, assigneeAgentId: reportsToAgentId, status: "todo" },
          reason: CUSTOMER_INBOX_HANDOFF_REASON,
          mutation: "customer_inbox_handoff",
          contextSource: "customer_inbox.handoff",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
        });
        reassigned += 1;
        continue;
      }

      if (count === 1) {
        const periodMs = candidate.handOffAfterMinutes * 60 * 1000;
        if (!lastRequestedAt || now.getTime() - lastRequestedAt.getTime() < periodMs) {
          skipped += 1;
          continue;
        }
        if (!candidate.assigneeAgentId) {
          skipped += 1;
          continue;
        }

        await db.insert(issueComments).values({
          companyId: candidate.companyId,
          issueId: candidate.id,
          authorType: "system",
          body: "Denne meldingen har ligget uten at noen har tatt den. Den trenger deg.",
        });
        await touchIssueForCompanyInboxes(db, { companyId: candidate.companyId, issueId: candidate.id, touchedAt: now });
        // Not a real wake -- nobody is being woken -- but recorded with the
        // same reason so this issue is never touched by this sweep again.
        await db.insert(agentWakeupRequests).values({
          companyId: candidate.companyId,
          agentId: candidate.assigneeAgentId,
          source: "automation",
          triggerDetail: "system",
          reason: CUSTOMER_INBOX_HANDOFF_REASON,
          payload: { issueId: candidate.id, mutation: "customer_inbox_handoff_notice" },
          status: "skipped",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          finishedAt: now,
        });
        noticed += 1;
        continue;
      }

      // count >= 2: this issue has already had its one hand-off and its one
      // follow-up notice. Never touch it again.
      skipped += 1;
    } catch (err) {
      logger.error({ err, issueId: candidate.id }, "customer-inbox hand-off sweep failed for issue");
      skipped += 1;
    }
  }

  return { checked: candidates.length, reassigned, noticed, skipped };
}
